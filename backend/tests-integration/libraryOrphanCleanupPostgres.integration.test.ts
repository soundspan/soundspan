import type { Prisma } from "@prisma/client";
import { Client } from "pg";
import { cleanupOrphanedLibraryEntities } from "../src/services/libraryOrphanCleanup";
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

const ids = {
    emptyAlbum: "orphan-cleanup-empty-album",
    emptyArtist: "orphan-cleanup-empty-artist",
    providerAlbum: "orphan-cleanup-provider-album",
    providerArtist: "orphan-cleanup-provider-artist",
    racedAlbum: "orphan-cleanup-raced-album",
    racedAlbumArtist: "orphan-cleanup-raced-album-artist",
    racedArtist: "orphan-cleanup-raced-artist",
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
    ]) {
        await createArtist(artistId);
    }
    await createAlbum(ids.emptyAlbum, ids.emptyArtist);
    await createAlbum(ids.providerAlbum, ids.providerArtist);
    await createAlbum(ids.racedAlbum, ids.racedAlbumArtist);
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
        jest.restoreAllMocks();
        await prisma.$disconnect();
        await database?.end();
        if (admin && databaseName) {
            await dropScaleDatabase(admin, databaseName);
        }
    });

    it("preserves provider-backed and raced entities while deleting true orphans", async () => {
        const findAlbums = prisma.album.findMany.bind(
            prisma.album,
        ) as unknown as (
            args: Prisma.AlbumFindManyArgs,
        ) => Promise<Array<{ id: string }>>;
        const findArtists = prisma.artist.findMany.bind(
            prisma.artist,
        ) as unknown as (
            args: Prisma.ArtistFindManyArgs,
        ) => Promise<Array<{ id: string }>>;

        jest.spyOn(prisma.album, "findMany").mockImplementationOnce((async (
            args?: Prisma.AlbumFindManyArgs,
        ) => {
            const candidates = await findAlbums(args ?? {});
            await insertRacedAlbumLink(database);
            return candidates;
        }) as never);
        jest.spyOn(prisma.artist, "findMany").mockImplementationOnce((async (
            args?: Prisma.ArtistFindManyArgs,
        ) => {
            const candidates = await findArtists(args ?? {});
            await insertRacedArtistLink(database);
            return candidates;
        }) as never);

        await expect(cleanupOrphanedLibraryEntities()).resolves.toEqual({
            albumsDeleted: 1,
            artistsDeleted: 1,
        });
        await expect(entityIds()).resolves.toEqual({
            albums: [ids.providerAlbum, ids.racedAlbum].sort(),
            artists: [
                ids.providerArtist,
                ids.racedAlbumArtist,
                ids.racedArtist,
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
});
