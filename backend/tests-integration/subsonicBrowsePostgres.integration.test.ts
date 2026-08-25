import type { Client } from "pg";
import { updateMultipleArtistCounts } from "../src/services/artistCountsService";
import { prisma } from "../src/utils/db";
import { LIBRARY_ALBUM_WHERE } from "../src/routes/subsonic/shared";
import {
    buildSongsByGenreWhere,
    loadSongsByGenrePageIds,
} from "../src/routes/subsonic/genreSongPaging";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && databaseName ? describe : describe.skip;
const ARTIST_IDS = [
    "subsonic-visible",
    "subsonic-removed",
    "subsonic-empty",
    "subsonic-discover",
];
const ALBUM_IDS = [
    "subsonic-visible-album",
    "subsonic-removed-album",
    "subsonic-discover-album",
];
const ROCK_TRACK_IDS = Array.from(
    { length: 9 },
    (_, index) => `subsonic-rock-${index + 1}`,
);

async function seedArtist(id: string): Promise<void> {
    await prisma.artist.create({
        data: { id, mbid: `${id}-mbid`, name: id },
    });
}

async function seedAlbum(id: string, artistId: string): Promise<void> {
    await prisma.album.create({
        data: {
            id,
            rgMbid: `${id}-mbid`,
            artistId,
            title: id,
            primaryType: "Album",
        },
    });
}

async function seedDiscoverAlbum(): Promise<void> {
    await prisma.album.create({
        data: {
            id: ALBUM_IDS[2],
            rgMbid: `${ALBUM_IDS[2]}-mbid`,
            artistId: ARTIST_IDS[3],
            title: ALBUM_IDS[2],
            primaryType: "Album",
            location: "DISCOVER",
        },
    });
}

async function seedTrack(
    id: string,
    albumId: string,
    trackNo: number,
    removedAt: Date | null = null,
): Promise<void> {
    await prisma.track.create({
        data: {
            id,
            albumId,
            title: id,
            trackNo,
            duration: 180,
            fileModified: new Date("2026-08-25T00:00:00.000Z"),
            fileSize: 1_000,
            removedAt,
        },
    });
}

async function seedFixtureTracks(): Promise<void> {
    await Promise.all(
        ROCK_TRACK_IDS.map((trackId, index) =>
            seedTrack(trackId, ALBUM_IDS[0], index + 1),
        ),
    );
    await Promise.all([
        seedTrack(
            "subsonic-removed-track",
            ALBUM_IDS[1],
            1,
            new Date("2026-08-25T01:00:00.000Z"),
        ),
        seedTrack("subsonic-jazz-track", ALBUM_IDS[0], 10),
        seedTrack("subsonic-discover-rock", ALBUM_IDS[2], 1),
    ]);
}

async function seedFixtureGenres(): Promise<void> {
    const [rock, jazz, wildcard] = await Promise.all([
        prisma.genre.create({ data: { name: "Rock" } }),
        prisma.genre.create({ data: { name: "Jazz" } }),
        prisma.genre.create({ data: { name: "100% Electronica" } }),
    ]);
    await prisma.trackGenre.createMany({
        data: [
            ...ROCK_TRACK_IDS.map((trackId) => ({
                trackId,
                genreId: rock.id,
            })),
            { trackId: "subsonic-removed-track", genreId: rock.id },
            { trackId: "subsonic-discover-rock", genreId: rock.id },
            { trackId: "subsonic-jazz-track", genreId: jazz.id },
            { trackId: "subsonic-jazz-track", genreId: wildcard.id },
        ],
    });
}

async function seedFixture(): Promise<void> {
    await Promise.all(ARTIST_IDS.map(seedArtist));
    await Promise.all([
        seedAlbum(ALBUM_IDS[0], ARTIST_IDS[0]),
        seedAlbum(ALBUM_IDS[1], ARTIST_IDS[1]),
        seedDiscoverAlbum(),
    ]);
    await seedFixtureTracks();
    await seedFixtureGenres();
}

describeWithPostgres("Subsonic browse PostgreSQL behavior", () => {
    let admin: Client | undefined;

    beforeAll(async () => {
        if (!integrationDatabaseUrl || !databaseName) {
            throw new Error("PostgreSQL integration environment is missing");
        }
        admin = await createScaleDatabase(integrationDatabaseUrl, databaseName);
        await applyScaleMigrations(process.env.DATABASE_URL!);
        await seedFixture();
    });

    afterAll(async () => {
        await prisma.$disconnect();
        if (admin && databaseName) await dropScaleDatabase(admin, databaseName);
    });

    it("keeps denormalized artist membership equal to the computed predicate", async () => {
        await updateMultipleArtistCounts(ARTIST_IDS);
        const [countsDerived, predicateDerived] = await Promise.all([
            prisma.artist.findMany({
                where: { libraryAlbumCount: { gt: 0 } },
                select: { id: true },
                orderBy: { id: "asc" },
            }),
            prisma.artist.findMany({
                where: { albums: { some: LIBRARY_ALBUM_WHERE } },
                select: { id: true },
                orderBy: { id: "asc" },
            }),
        ]);

        expect(countsDerived).toEqual(predicateDerived);
        expect(countsDerived).toEqual([{ id: ARTIST_IDS[0] }]);
    });

    it("partitions SQL pages into the same exhaustive membership as Prisma", async () => {
        const prismaIds = (
            await prisma.track.findMany({
                where: buildSongsByGenreWhere("rOcK"),
                select: { id: true },
            })
        ).map(({ id }) => id);
        const dayKey = "2026-08-25";
        const pages = await Promise.all(
            [0, 3, 6].map((offset) =>
                loadSongsByGenrePageIds("rOcK", dayKey, 3, offset),
            ),
        );
        const repeated = await loadSongsByGenrePageIds("rOcK", dayKey, 9, 0);
        const flattened = pages.flat();

        expect(new Set(flattened).size).toBe(flattened.length);
        expect([...flattened].sort()).toEqual([...prismaIds].sort());
        expect(repeated).toEqual(flattened);
    });

    it("treats SQL-wildcard characters in genre names as literals", async () => {
        const dayKey = "2026-08-25";
        const literal = await loadSongsByGenrePageIds(
            "100% electronica",
            dayKey,
            10,
            0,
        );
        const prismaIds = (
            await prisma.track.findMany({
                where: buildSongsByGenreWhere("100% electronica"),
                select: { id: true },
            })
        ).map(({ id }) => id);

        expect([...literal].sort()).toEqual([...prismaIds].sort());
        expect(literal).toEqual(["subsonic-jazz-track"]);
        // Underscore is the single-character SQL wildcard: "100_ Electronica"
        // must NOT match "100% Electronica".
        expect(
            await loadSongsByGenrePageIds("100_ Electronica", dayKey, 10, 0),
        ).toEqual([]);
    });
});
