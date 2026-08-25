import type { Client } from "pg";
import { searchService } from "../src/services/search";
import { prisma } from "../src/utils/db";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && databaseName ? describe : describe.skip;

const ARTIST_ID = "search-relevance-artist";
const ALBUM_ID = "search-relevance-album";

async function seedTrack(
    id: string,
    title: string,
    trackNo: number,
): Promise<void> {
    await prisma.track.create({
        data: {
            id,
            albumId: ALBUM_ID,
            title,
            trackNo,
            duration: 240,
            fileModified: new Date("2026-08-25T00:00:00.000Z"),
            fileSize: 1_000,
        },
    });
}

describeWithPostgres("search relevance PostgreSQL behavior", () => {
    let admin: Client | undefined;

    beforeAll(async () => {
        if (!integrationDatabaseUrl || !databaseName) {
            throw new Error("PostgreSQL integration environment is missing");
        }
        admin = await createScaleDatabase(integrationDatabaseUrl, databaseName);
        const runtimeDatabaseUrl = process.env.DATABASE_URL;
        if (!runtimeDatabaseUrl) {
            throw new Error("Integration database URL was not initialized");
        }
        await applyScaleMigrations(runtimeDatabaseUrl);
        await prisma.artist.create({
            data: {
                id: ARTIST_ID,
                mbid: "search-relevance-artist-mbid",
                name: "Radiohead",
            },
        });
        await prisma.album.create({
            data: {
                id: ALBUM_ID,
                rgMbid: "search-relevance-album-mbid",
                artistId: ARTIST_ID,
                title: "Pablo Honey",
                primaryType: "Album",
            },
        });
        await seedTrack("search-creep", "Creep", 1);
        await seedTrack("search-acdc", "AC/DC", 2);
        await seedTrack("search-acdc-tribute", "A Tribute to AC/DC", 3);
    });

    afterAll(async () => {
        await prisma.$disconnect();
        if (admin && databaseName) {
            await dropScaleDatabase(admin, databaseName);
        }
    });

    it("matches a track across artist and title full-text columns", async () => {
        const results = await searchService.searchTracks({
            query: "radiohead creep",
        });

        expect(results).toContainEqual(
            expect.objectContaining({ id: "search-creep" }),
        );
    });

    it("finds a typo through trigram fallback with a positive rank", async () => {
        const results = await searchService.searchTracks({ query: "crepe" });

        expect(results).toContainEqual(
            expect.objectContaining({
                id: "search-creep",
                rank: expect.any(Number),
            }),
        );
        expect(results[0]?.rank).toBeGreaterThan(0);
    });

    it("orders fallback matches by similarity before title", async () => {
        const results = await searchService.searchTracks({ query: "AC/DC" });

        expect(results.slice(0, 2).map((track) => track.id)).toEqual([
            "search-acdc",
            "search-acdc-tribute",
        ]);
        const [exactMatch, tributeMatch] = results;
        if (!exactMatch || !tributeMatch) {
            throw new Error("Expected two fallback search results");
        }
        expect(exactMatch.rank).toBeGreaterThan(tributeMatch.rank);
    });
});
