import type { Request, Response } from "express";
import { Client } from "pg";
import { handleGetAlbums } from "../src/routes/library/albums";
import {
    loadLibrarySongsPage,
    loadRemoteLibrarySet,
} from "../src/services/remoteLibrary";
import { prisma } from "../src/utils/db";
import { invalidateSystemSettingsCache } from "../src/utils/systemSettings";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && databaseName ? describe : describe.skip;
const USER_ID = "remote-songs-user";
const OTHER_USER_ID = "remote-songs-other";
const HELD_PLACEHOLDER_ID = "remote-songs-held-placeholder";
const UNHELD_PLACEHOLDER_ID = "remote-songs-unheld-placeholder";
const HELD_RELEASE_GROUP = "remote-songs-held-release-group";

type RouteResponse = {
    statusCode: number;
    body: unknown;
    status(code: number): RouteResponse;
    json(body: unknown): RouteResponse;
};

function createRouteResponse(): RouteResponse {
    return {
        statusCode: 200,
        body: undefined,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

async function getAllAlbums(): Promise<RouteResponse> {
    const response = createRouteResponse();
    await handleGetAlbums(
        {
            query: { origin: "all", filter: "all" },
            user: { id: USER_ID },
        } as unknown as Request,
        response as unknown as Response,
    );
    return response;
}

async function seedTrack(input: {
    id: string;
    albumId: string;
    title: string;
    origin?: "LOCAL" | "FEDERATED";
    peerId?: string;
    dedupOfTrackId?: string;
    removed?: boolean;
}): Promise<void> {
    await prisma.track.create({
        data: {
            id: input.id,
            albumId: input.albumId,
            title: input.title,
            trackNo: 1,
            duration: 180,
            fileModified: new Date("2026-10-01T00:00:00.000Z"),
            fileSize: 1_000,
            origin: input.origin ?? "LOCAL",
            peerId: input.peerId,
            remoteId: input.peerId ? `remote-${input.id}` : undefined,
            dedupOfTrackId: input.dedupOfTrackId,
            removedAt: input.removed
                ? new Date("2026-10-02T00:00:00.000Z")
                : null,
        },
    });
}

async function seedTidal(input: {
    id: string;
    tidalId: number;
    title: string;
    userId: string;
    mappedTrackId?: string;
    albumId?: string;
}): Promise<void> {
    await prisma.trackTidal.create({
        data: {
            id: input.id,
            tidalId: input.tidalId,
            title: input.title,
            artist: "Integration Artist",
            album: "Integration Album",
            duration: 180,
            artistId: input.albumId ? "remote-songs-artist" : undefined,
            albumId: input.albumId,
        },
    });
    await prisma.likedRemoteTrack.create({
        data: { userId: input.userId, trackTidalId: input.id },
    });
    if (input.mappedTrackId) {
        await prisma.trackMapping.create({
            data: {
                trackId: input.mappedTrackId,
                trackTidalId: input.id,
                confidence: 1,
                source: "manual",
            },
        });
    }
}

async function seedFixture(): Promise<void> {
    await prisma.user.createMany({
        data: [
            { id: USER_ID, username: USER_ID },
            { id: OTHER_USER_ID, username: OTHER_USER_ID },
        ],
    });
    await prisma.userSettings.createMany({
        data: [
            { userId: USER_ID, tidalOAuthJson: "token" },
            { userId: OTHER_USER_ID, tidalOAuthJson: "other-token" },
        ],
    });
    await prisma.systemSettings.upsert({
        where: { id: "default" },
        create: {
            id: "default",
            tidalEnabled: true,
            ytMusicEnabled: true,
        },
        update: { tidalEnabled: true, ytMusicEnabled: true },
    });
    invalidateSystemSettingsCache();
    await prisma.artist.create({
        data: {
            id: "remote-songs-artist",
            mbid: "remote-songs-artist-mbid",
            name: "Integration Artist",
        },
    });
    await prisma.federationPeer.create({
        data: {
            id: "remote-songs-peer",
            name: "Integration Peer",
            direction: "CONSUMER",
            createdById: USER_ID,
        },
    });
    await prisma.album.createMany({
        data: [
            {
                id: "remote-songs-local-album",
                rgMbid: "remote-songs-local-album-mbid",
                artistId: "remote-songs-artist",
                title: "Local Album",
                primaryType: "Album",
                location: "LIBRARY",
            },
            {
                id: "remote-songs-peer-album",
                rgMbid: "remote-songs-peer-album-mbid",
                artistId: "remote-songs-artist",
                title: "Peer Album",
                primaryType: "Album",
                location: "FEDERATED",
                peerId: "remote-songs-peer",
                remoteId: "peer-album",
            },
            {
                id: "remote-songs-held-library-album",
                rgMbid: HELD_RELEASE_GROUP,
                artistId: "remote-songs-artist",
                title: "Held Library Album",
                primaryType: "Album",
                location: "LIBRARY",
            },
            {
                id: HELD_PLACEHOLDER_ID,
                rgMbid: "remote:songs-held-placeholder",
                matchedRgMbid: HELD_RELEASE_GROUP,
                artistId: "remote-songs-artist",
                title: "Held Placeholder",
                primaryType: "Album",
                location: "REMOTE",
            },
            {
                id: UNHELD_PLACEHOLDER_ID,
                rgMbid: "remote:songs-unheld-placeholder",
                matchedRgMbid: "remote-songs-unheld-release-group",
                artistId: "remote-songs-artist",
                title: "Unheld Placeholder",
                primaryType: "Album",
                location: "REMOTE",
            },
        ],
    });
    await seedTrack({
        id: "local-alpha",
        albumId: "remote-songs-local-album",
        title: "Alpha",
    });
    await seedTrack({
        id: "local-visible",
        albumId: "remote-songs-local-album",
        title: "Mapped Local",
    });
    await seedTrack({
        id: "local-removed",
        albumId: "remote-songs-local-album",
        title: "Removed Local",
        removed: true,
    });
    await seedTrack({
        id: "peer-visible",
        albumId: "remote-songs-peer-album",
        title: "Mapped Peer",
        origin: "FEDERATED",
        peerId: "remote-songs-peer",
    });
    await seedTrack({
        id: "peer-hidden-duplicate",
        albumId: "remote-songs-peer-album",
        title: "Hidden mapped peer",
        origin: "FEDERATED",
        peerId: "remote-songs-peer",
        dedupOfTrackId: "local-visible",
    });
    await seedTrack({
        id: "remote-songs-held-local-track",
        albumId: "remote-songs-held-library-album",
        title: "Held local track",
    });
    await seedTidal({
        id: "tidal-visible-local",
        tidalId: 8101,
        title: "Mapped Local",
        userId: USER_ID,
        mappedTrackId: "local-visible",
    });
    await seedTidal({
        id: "tidal-visible-peer",
        tidalId: 8102,
        title: "Mapped Peer",
        userId: USER_ID,
        mappedTrackId: "peer-visible",
    });
    await seedTidal({
        id: "tidal-removed",
        tidalId: 8103,
        title: "Removed Remote",
        userId: USER_ID,
        mappedTrackId: "local-removed",
    });
    await seedTidal({
        id: "tidal-hidden-peer",
        tidalId: 8104,
        title: "Hidden mapped peer",
        userId: USER_ID,
        mappedTrackId: "peer-hidden-duplicate",
    });
    await seedTidal({
        id: "tidal-tie-a",
        tidalId: 8106,
        title: "Tie",
        userId: USER_ID,
    });
    await seedTidal({
        id: "tidal-tie-b",
        tidalId: 8107,
        title: "Tie",
        userId: USER_ID,
    });
    await prisma.trackYtMusic.create({
        data: {
            id: "youtube-tie",
            videoId: "youtube-tie-video",
            title: "Tie",
            artist: "Integration Artist",
            album: "Integration Album",
            duration: 180,
        },
    });
    await prisma.likedRemoteTrack.create({
        data: { userId: USER_ID, trackYtMusicId: "youtube-tie" },
    });
    await seedTidal({
        id: "tidal-other-user",
        tidalId: 8105,
        title: "Other User",
        userId: OTHER_USER_ID,
    });
    await seedTidal({
        id: "tidal-held-placeholder",
        tidalId: 8108,
        title: "Held placeholder song",
        userId: USER_ID,
        albumId: HELD_PLACEHOLDER_ID,
    });
    await seedTidal({
        id: "tidal-unheld-placeholder",
        tidalId: 8109,
        title: "Unheld placeholder song",
        userId: USER_ID,
        albumId: UNHELD_PLACEHOLDER_ID,
    });
}

describeWithPostgres("remote Library Songs PostgreSQL behavior", () => {
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

    it("excludes visible mappings, includes removed mappings, and scopes likes", async () => {
        const remote = await loadRemoteLibrarySet(USER_ID);

        expect(remote.tracks.map((row) => row.providerRowId).sort()).toEqual([
            "tidal-held-placeholder",
            "tidal-removed",
            "tidal-tie-a",
            "tidal-tie-b",
            "tidal-unheld-placeholder",
            "youtube-tie",
        ]);
    });

    it.each([
        [
            "name",
            [
                "local-alpha",
                "remote-songs-held-local-track",
                "tidal:8108",
                "local-visible",
                "peer-visible",
                "tidal:8103",
                "tidal:8106",
                "tidal:8107",
                "yt:youtube-tie-video",
                "tidal:8109",
            ],
        ],
        [
            "name-desc",
            [
                "tidal:8109",
                "tidal:8106",
                "tidal:8107",
                "yt:youtube-tie-video",
                "tidal:8103",
                "peer-visible",
                "local-visible",
                "tidal:8108",
                "remote-songs-held-local-track",
                "local-alpha",
            ],
        ],
    ] as const)(
        "orders the union deterministically for %s",
        async (sortBy, expected) => {
            const remoteLibrary = await loadRemoteLibrarySet(USER_ID);
            const page = await loadLibrarySongsPage({
                origin: "all",
                remoteLibrary,
                sortBy,
                limit: 20,
                offset: 0,
            });

            expect(page.tracks.map((track) => track.id)).toEqual(expected);
            expect(page.total).toBe(10);
        },
    );

    it("paginates without duplicates or gaps", async () => {
        const remoteLibrary = await loadRemoteLibrarySet(USER_ID);
        const full = await loadLibrarySongsPage({
            origin: "all",
            remoteLibrary,
            sortBy: "name",
            limit: 20,
            offset: 0,
        });
        const pages = await Promise.all(
            [0, 2, 4, 6, 8].map((offset) =>
                loadLibrarySongsPage({
                    origin: "all",
                    remoteLibrary,
                    sortBy: "name",
                    limit: 2,
                    offset,
                }),
            ),
        );
        const pagedIds = pages.flatMap((page) =>
            page.tracks.map((track) => track.id),
        );

        expect(pagedIds).toEqual(full.tracks.map((track) => track.id));
        expect(full.total).toBe(10);
        expect(pages.every((page) => page.total === 10)).toBe(true);
        expect(new Set(pagedIds).size).toBe(pagedIds.length);
    });

    it("marks held song albums and filters only held placeholders from albums", async () => {
        const remoteLibrary = await loadRemoteLibrarySet(USER_ID);
        const page = await loadLibrarySongsPage({
            origin: "all",
            remoteLibrary,
            sortBy: "name",
            limit: 20,
            offset: 0,
        });
        const heldSong = page.tracks.find((track) => track.id === "tidal:8108");
        const albumsResponse = await getAllAlbums();
        const albums = (
            albumsResponse.body as {
                albums: Array<{ id: string }>;
            }
        ).albums;

        expect(heldSong).toEqual(
            expect.objectContaining({
                album: expect.objectContaining({
                    id: HELD_PLACEHOLDER_ID,
                    matchedInLibrary: true,
                }),
            }),
        );
        expect(albumsResponse.statusCode).toBe(200);
        expect(albums).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: HELD_PLACEHOLDER_ID }),
            ]),
        );
        expect(albums).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: UNHELD_PLACEHOLDER_ID }),
            ]),
        );
    });
});
