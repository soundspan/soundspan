import type { Client } from "pg";
import { invalidateActiveSpaceCache } from "../src/services/embeddingSpaces";
import {
    findNearestAmongTracks,
    findNearestToEmbedding,
} from "../src/services/trackEmbeddings";
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
const SPACE_ID = "space-vibe-map-anchors";
const ARTIST_ID = "vibe-map-anchor-artist";
const ALBUM_ID = "vibe-map-anchor-album";

function vector(first: number, second: number): string {
    return `[${first},${second},${Array(510).fill(0).join(",")}]`;
}

async function seedTracks(): Promise<void> {
    await prisma.artist.create({
        data: { id: ARTIST_ID, mbid: `${ARTIST_ID}-mbid`, name: "Artist" },
    });
    await prisma.album.create({
        data: {
            id: ALBUM_ID,
            rgMbid: `${ALBUM_ID}-mbid`,
            artistId: ARTIST_ID,
            title: "Album",
            primaryType: "Album",
        },
    });
    await prisma.track.createMany({
        data: ["candidate-close", "candidate-far", "outside-nearest"].map(
            (id, index) => ({
                id,
                albumId: ALBUM_ID,
                title: id,
                trackNo: index + 1,
                duration: 180,
                fileModified: new Date("2026-09-18T00:00:00.000Z"),
                fileSize: 1_000,
            }),
        ),
    });
}

async function seedEmbeddings(): Promise<void> {
    await prisma.embeddingSpace.updateMany({
        where: { status: "active" },
        data: {
            status: "retired",
            retiredAt: new Date("2026-09-18T00:00:00.000Z"),
        },
    });
    await prisma.embeddingSpace.create({
        data: {
            id: SPACE_ID,
            family: "vibe-map-anchor-test",
            checkpointHash: "vibe-map-anchor-test-hash",
            dim: 512,
            preprocessing: {},
            status: "active",
            hadVectors: true,
        },
    });
    await prisma.$executeRaw`
        INSERT INTO track_embeddings (track_id, space_id, embedding)
        VALUES
            (${"candidate-close"}, ${SPACE_ID}, ${vector(0.9, 0.1)}::vector),
            (${"candidate-far"}, ${SPACE_ID}, ${vector(0, 1)}::vector),
            (${"outside-nearest"}, ${SPACE_ID}, ${vector(1, 0)}::vector)
    `;
}

describeWithPostgres("vibe map anchor PostgreSQL correctness", () => {
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
        await seedTracks();
        await seedEmbeddings();
        invalidateActiveSpaceCache();
    });

    afterAll(async () => {
        await prisma.$disconnect();
        if (admin && databaseName) {
            await dropScaleDatabase(admin, databaseName);
        }
    });

    it("orders exact candidates and excludes a nearer non-candidate", async () => {
        const results = await findNearestAmongTracks(
            [1, 0, ...Array(510).fill(0)],
            ["candidate-far", "candidate-close"],
            2,
        );

        expect(results.map((row) => row.id)).toEqual([
            "candidate-close",
            "candidate-far",
        ]);
        expect(results.every((row) => row.id !== "outside-nearest")).toBe(true);
        expect(results[0]?.distance).toBeLessThan(results[1]?.distance ?? 0);
    });

    it("orders production nearest-neighbor reads by distance", async () => {
        const results = await findNearestToEmbedding(
            [1, 0, ...Array(510).fill(0)],
            3,
        );

        expect(results.map((row) => row.id)).toEqual([
            "outside-nearest",
            "candidate-close",
            "candidate-far",
        ]);
        expect(results[0]?.distance).toBeLessThan(results[1]?.distance ?? 0);
        expect(results[1]?.distance).toBeLessThan(results[2]?.distance ?? 0);
    });
});
