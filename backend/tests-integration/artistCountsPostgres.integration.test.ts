import { Client } from "pg";
import {
    calculateArtistCounts,
    updateMultipleArtistCounts,
} from "../src/services/artistCountsService";
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

const artistIds = ["artist-counts-a", "artist-counts-b"] as const;

async function seedArtist(id: string): Promise<void> {
    await prisma.artist.create({
        data: { id, mbid: `${id}-mbid`, name: id, normalizedName: id },
    });
}

async function seedAlbum(
    id: string,
    artistId: string,
    location: "LIBRARY" | "DISCOVER" | "REMOTE" | "FEDERATED",
): Promise<void> {
    await prisma.album.create({
        data: {
            id,
            artistId,
            rgMbid: `${id}-rg-mbid`,
            title: id,
            primaryType: "Album",
            location,
        },
    });
}

async function seedTrack(
    id: string,
    albumId: string,
    options: { origin?: "LOCAL" | "FEDERATED"; removedAt?: Date } = {},
): Promise<void> {
    await prisma.track.create({
        data: {
            id,
            albumId,
            title: id,
            trackNo: 1,
            discNo: 1,
            duration: 180,
            fileModified: new Date("2026-08-20T12:00:00.000Z"),
            fileSize: 1_024,
            origin: options.origin ?? "LOCAL",
            removedAt: options.removedAt,
        },
    });
}

async function seedFixture(): Promise<void> {
    await Promise.all(artistIds.map(seedArtist));
    await seedAlbum("artist-counts-library", artistIds[0], "LIBRARY");
    await seedAlbum("artist-counts-empty", artistIds[0], "LIBRARY");
    await seedAlbum("artist-counts-discover", artistIds[0], "DISCOVER");
    await seedAlbum("artist-counts-remote", artistIds[0], "REMOTE");
    await seedAlbum("artist-counts-federated", artistIds[1], "FEDERATED");
    await seedTrack("artist-counts-local-1", "artist-counts-library");
    await seedTrack("artist-counts-local-2", "artist-counts-library");
    await seedTrack("artist-counts-discover-track", "artist-counts-discover");
    await seedTrack("artist-counts-remote-track", "artist-counts-remote");
    await seedTrack(
        "artist-counts-federated-track",
        "artist-counts-federated",
        {
            origin: "FEDERATED",
        },
    );
    await seedTrack("artist-counts-removed", "artist-counts-library", {
        removedAt: new Date("2026-08-21T12:00:00.000Z"),
    });
    await prisma.trackTidal.create({
        data: {
            id: "artist-counts-tidal",
            tidalId: 777001,
            title: "Tidal",
            artist: "Artist A",
            album: "Remote",
            duration: 180,
            artistId: artistIds[0],
        },
    });
    await prisma.trackYtMusic.create({
        data: {
            id: "artist-counts-youtube",
            videoId: "artist-counts-video",
            title: "YouTube",
            artist: "Artist A",
            album: "Remote",
            duration: 180,
            artistId: artistIds[0],
        },
    });
}

describeWithPostgres("artist count PostgreSQL behavior", () => {
    let admin: Client;

    beforeAll(async () => {
        admin = await createScaleDatabase(
            integrationDatabaseUrl!,
            databaseName!,
        );
        await applyScaleMigrations(process.env.DATABASE_URL!);
        await seedFixture();
    });

    afterAll(async () => {
        await prisma.$disconnect();
        if (admin && databaseName) await dropScaleDatabase(admin, databaseName);
    });

    it("matches the legacy single-artist calculation for every scoped artist", async () => {
        const expected = await Promise.all(
            artistIds.map((artistId) => calculateArtistCounts(artistId)),
        );
        await prisma.artist.updateMany({
            where: { id: { in: [...artistIds] } },
            data: {
                libraryAlbumCount: 99,
                discoveryAlbumCount: 99,
                totalTrackCount: 99,
                remoteTrackCount: 99,
                countsLastUpdated: null,
            },
        });

        await expect(
            updateMultipleArtistCounts([...artistIds]),
        ).resolves.toEqual({ updated: 2, errors: 0 });

        const actual = await prisma.artist.findMany({
            where: { id: { in: [...artistIds] } },
            orderBy: { id: "asc" },
            select: {
                libraryAlbumCount: true,
                discoveryAlbumCount: true,
                totalTrackCount: true,
                remoteTrackCount: true,
                countsLastUpdated: true,
            },
        });
        expect(
            actual.map(
                ({ countsLastUpdated: _timestamp, ...counts }) => counts,
            ),
        ).toEqual(expected);
        expect(
            actual.every((row) => row.countsLastUpdated instanceof Date),
        ).toBe(true);
    });
});
