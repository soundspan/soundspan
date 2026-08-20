import type { Prisma } from "@prisma/client";
import { Client } from "pg";
import { config } from "../src/config";
import {
    cleanupOrphanedLibraryEntities,
    ORPHAN_CLEANUP_BATCH_SIZE,
} from "../src/services/libraryOrphanCleanup";
import { prisma } from "../src/utils/db";
import { runDataIntegrityCheck } from "../src/workers/dataIntegrity";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && databaseName ? describe : describe.skip;

const ids = {
    emptyAlbum: "orphan-cleanup-empty-album",
    emptyArtist: "orphan-cleanup-empty-artist",
    providerAlbum: "orphan-cleanup-provider-album",
    providerArtist: "orphan-cleanup-provider-artist",
    racedAlbum: "orphan-cleanup-raced-album",
    racedAlbumArtist: "orphan-cleanup-raced-album-artist",
    racedArtist: "orphan-cleanup-raced-artist",
    overriddenAlbum: "orphan-cleanup-overridden-album",
    overriddenAlbumArtist: "orphan-cleanup-overridden-album-artist",
    overriddenArtist: "orphan-cleanup-overridden-artist",
} as const;

async function createArtist(id: string): Promise<void> {
    await prisma.artist.create({
        data: {
            id,
            mbid: `${id}-mbid`,
            name: id,
            normalizedName: id,
        },
    });
}

async function createAlbum(id: string, artistId: string): Promise<void> {
    await prisma.album.create({
        data: {
            id,
            rgMbid: `${id}-rg-mbid`,
            artistId,
            title: id,
            primaryType: "Album",
        },
    });
}

async function seedCatalog(): Promise<void> {
    for (const artistId of [
        ids.emptyArtist,
        ids.providerArtist,
        ids.racedAlbumArtist,
        ids.racedArtist,
        ids.overriddenAlbumArtist,
        ids.overriddenArtist,
    ]) {
        await createArtist(artistId);
    }
    await createAlbum(ids.emptyAlbum, ids.emptyArtist);
    await createAlbum(ids.providerAlbum, ids.providerArtist);
    await createAlbum(ids.racedAlbum, ids.racedAlbumArtist);
    await createAlbum(ids.overriddenAlbum, ids.overriddenAlbumArtist);
    await prisma.album.update({
        where: { id: ids.overriddenAlbum },
        data: { hasUserOverrides: true },
    });
    await prisma.artist.update({
        where: { id: ids.overriddenArtist },
        data: { hasUserOverrides: true },
    });
    await prisma.trackTidal.create({
        data: {
            tidalId: 646001,
            title: "Provider track",
            artist: "Provider artist",
            album: "Provider album",
            duration: 180,
            artistId: ids.providerArtist,
            albumId: ids.providerAlbum,
        },
    });
}

async function insertRacedAlbumLink(database: Client): Promise<void> {
    await database.query(
        `INSERT INTO "TrackTidal"
            (id, "tidalId", title, artist, album, duration, "artistId", "albumId", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
            "orphan-cleanup-raced-album-track",
            646002,
            "Raced album track",
            "Raced album artist",
            "Raced album",
            181,
            ids.racedAlbumArtist,
            ids.racedAlbum,
        ],
    );
}

async function insertRacedArtistLink(database: Client): Promise<void> {
    await database.query(
        `INSERT INTO "TrackYtMusic"
            (id, "videoId", title, artist, album, duration, "artistId", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
            "orphan-cleanup-raced-artist-track",
            "orphan-cleanup-raced-video",
            "Raced artist track",
            "Raced artist",
            "Raced artist album",
            182,
            ids.racedArtist,
        ],
    );
}

async function entityIds(): Promise<{ albums: string[]; artists: string[] }> {
    const [albums, artists] = await Promise.all([
        prisma.album.findMany({
            where: { id: { in: Object.values(ids) } },
            orderBy: { id: "asc" },
            select: { id: true },
        }),
        prisma.artist.findMany({
            where: { id: { in: Object.values(ids) } },
            orderBy: { id: "asc" },
            select: { id: true },
        }),
    ]);
    return {
        albums: albums.map((album) => album.id),
        artists: artists.map((artist) => artist.id),
    };
}

describeWithPostgres("library orphan cleanup PostgreSQL behavior", () => {
    let admin: Client;
    let database: Client;

    beforeAll(async () => {
        admin = await createScaleDatabase(
            integrationDatabaseUrl!,
            databaseName!,
        );
        await applyScaleMigrations(process.env.DATABASE_URL!);
        database = new Client({ connectionString: process.env.DATABASE_URL });
        await database.connect();
        await seedCatalog();
    });

    afterAll(async () => {
        await prisma.$disconnect();
        await database?.end();
        if (admin && databaseName) {
            await dropScaleDatabase(admin, databaseName);
        }
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("preserves provider-backed and raced entities while deleting true orphans", async () => {
        // Cleanup now runs one transaction per batch, so the race injection
        // wraps EVERY transaction and fires once per entity type overall:
        // the first album selection and the first artist selection each get
        // a competing link inserted between selection and guarded deletion.
        const runTransaction = prisma.$transaction.bind(prisma);
        let albumRaceInjected = false;
        let artistRaceInjected = false;
        jest.spyOn(prisma, "$transaction").mockImplementation((async (
            callback: (
                transaction: Prisma.TransactionClient,
            ) => Promise<unknown>,
        ) =>
            runTransaction(async (transaction) => {
                const findAlbums = transaction.album.findMany.bind(
                    transaction.album,
                );
                const findArtists = transaction.artist.findMany.bind(
                    transaction.artist,
                );
                jest.spyOn(transaction.album, "findMany").mockImplementation(
                    (async (args?: Prisma.AlbumFindManyArgs) => {
                        const candidates = await findAlbums(args ?? {});
                        if (!albumRaceInjected && candidates.length > 0) {
                            albumRaceInjected = true;
                            await insertRacedAlbumLink(database);
                        }
                        return candidates;
                    }) as never,
                );
                jest.spyOn(transaction.artist, "findMany").mockImplementation(
                    (async (args?: Prisma.ArtistFindManyArgs) => {
                        const candidates = await findArtists(args ?? {});
                        if (!artistRaceInjected && candidates.length > 0) {
                            artistRaceInjected = true;
                            await insertRacedArtistLink(database);
                        }
                        return candidates;
                    }) as never,
                );
                return callback(transaction);
            })) as never);

        await expect(cleanupOrphanedLibraryEntities()).resolves.toEqual({
            albumsDeleted: 1,
            artistsDeleted: 1,
        });
        await expect(entityIds()).resolves.toEqual({
            albums: [
                ids.overriddenAlbum,
                ids.providerAlbum,
                ids.racedAlbum,
            ].sort(),
            artists: [
                ids.providerArtist,
                ids.racedAlbumArtist,
                ids.racedArtist,
                ids.overriddenAlbumArtist,
                ids.overriddenArtist,
            ].sort(),
        });

        await expect(
            prisma.trackTidal.findUnique({
                where: { tidalId: 646002 },
                select: { albumId: true, artistId: true },
            }),
        ).resolves.toEqual({
            albumId: ids.racedAlbum,
            artistId: ids.racedAlbumArtist,
        });
        await expect(
            prisma.trackYtMusic.findUnique({
                where: { videoId: "orphan-cleanup-raced-video" },
                select: { artistId: true },
            }),
        ).resolves.toEqual({ artistId: ids.racedArtist });
    });

    it("writes tombstones when data integrity delegates parent deletion", async () => {
        const albumId = "data-integrity-tombstone-album";
        const artistId = "data-integrity-tombstone-artist";
        await createArtist(artistId);
        await createAlbum(albumId, artistId);
        const federationWasEnabled = config.features.federation;
        config.features.federation = true;

        try {
            await runDataIntegrityCheck();
        } finally {
            config.features.federation = federationWasEnabled;
        }

        await expect(
            prisma.federationTombstone.findMany({
                where: { entityId: { in: [albumId, artistId] } },
                orderBy: { entityType: "asc" },
                select: { entityType: true, entityId: true },
            }),
        ).resolves.toEqual([
            { entityType: "album", entityId: albumId },
            { entityType: "artist", entityId: artistId },
        ]);
    });

    it("cleans and tombstones orphans across batch boundaries", async () => {
        const entityCount = ORPHAN_CLEANUP_BATCH_SIZE + 1;
        const artistIds = Array.from(
            { length: entityCount },
            (_, index) => `00-batch-artist-${String(index).padStart(3, "0")}`,
        );
        const albumIds = Array.from(
            { length: entityCount },
            (_, index) => `00-batch-album-${String(index).padStart(3, "0")}`,
        );
        await prisma.artist.createMany({
            data: artistIds.map((id) => ({
                id,
                mbid: `${id}-mbid`,
                name: id,
                normalizedName: id,
            })),
        });
        await prisma.album.createMany({
            data: albumIds.map((id, index) => ({
                id,
                rgMbid: `${id}-rg-mbid`,
                artistId: artistIds[index],
                title: id,
                primaryType: "Album",
            })),
        });
        const federationWasEnabled = config.features.federation;
        config.features.federation = true;
        const runTransaction = prisma.$transaction.bind(prisma);
        const tombstoneCountsAfterCommit: number[] = [];
        jest.spyOn(prisma, "$transaction").mockImplementation((async (
            callback: (
                transaction: Prisma.TransactionClient,
            ) => Promise<unknown>,
            options: { maxWait: number; timeout: number },
        ) => {
            const result = await runTransaction(callback, options);
            tombstoneCountsAfterCommit.push(
                await prisma.federationTombstone.count({
                    where: { entityId: { in: [...albumIds, ...artistIds] } },
                }),
            );
            return result;
        }) as never);

        try {
            await expect(cleanupOrphanedLibraryEntities()).resolves.toEqual({
                albumsDeleted: entityCount,
                artistsDeleted: entityCount,
            });
        } finally {
            config.features.federation = federationWasEnabled;
        }

        await expect(
            prisma.federationTombstone.count({
                where: { entityId: { in: [...albumIds, ...artistIds] } },
            }),
        ).resolves.toBe(entityCount * 2);
        await expect(
            prisma.album.count({ where: { id: { in: albumIds } } }),
        ).resolves.toBe(0);
        await expect(
            prisma.artist.count({ where: { id: { in: artistIds } } }),
        ).resolves.toBe(0);
        expect(tombstoneCountsAfterCommit).toEqual([
            ORPHAN_CLEANUP_BATCH_SIZE,
            entityCount,
            entityCount + ORPHAN_CLEANUP_BATCH_SIZE,
            entityCount * 2,
        ]);
    });
});
