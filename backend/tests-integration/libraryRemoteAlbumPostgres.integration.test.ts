import type { Request, Response } from "express";
import { Client } from "pg";
import { handleGetAlbum } from "../src/routes/library/albums";
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

const LIKER_ID = "remote-album-liker";
const OTHER_USER_ID = "remote-album-other-user";
const ARTIST_ID = "remote-album-artist";
const REMOTE_ALBUM_ID = "remote-only-album";
const LOCAL_ALBUM_ID = "local-album-with-provider-copy";
const LOCAL_PROVIDER_ONLY_ALBUM_ID = "local-album-with-only-provider-copy";
const HELD_RELEASE_GROUP = "matched-held-release-group";
const REMOVED_RELEASE_GROUP = "matched-removed-release-group";
const FEDERATED_RELEASE_GROUP = "matched-federated-release-group";
const ADOPTED_RELEASE_GROUP = "matched-adopted-release-group";
const REMOTE_HELD_ALBUM_ID = "matched-remote-held";
const REMOTE_REMOVED_ALBUM_ID = "matched-remote-removed";
const REMOTE_FEDERATED_ALBUM_ID = "matched-remote-federated";
const REMOTE_UNHELD_ALBUM_ID = "matched-remote-unheld";
const ADOPTED_ALBUM_ID = "matched-adopted-placeholder";
const FEDERATED_PEER_ID = "matched-federated-peer";

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

async function getAlbum(
    albumId: string,
    userId: string,
    includeTracks: boolean,
): Promise<RouteResponse> {
    const response = createRouteResponse();
    await handleGetAlbum(
        {
            params: { id: albumId },
            query: { includeTracks: String(includeTracks) },
            user: { id: userId },
        } as unknown as Request<{ id: string }>,
        response as unknown as Response,
    );
    return response;
}

async function seedRemoteOnlyAlbum(): Promise<void> {
    const tidalTrack = await prisma.trackTidal.create({
        data: {
            id: "remote-only-tidal-track",
            tidalId: 666001,
            title: "Remote Song",
            artist: "Remote Artist",
            album: "Remote Album",
            duration: 240,
            artistId: ARTIST_ID,
            albumId: REMOTE_ALBUM_ID,
        },
    });
    await prisma.likedRemoteTrack.create({
        data: { userId: LIKER_ID, trackTidalId: tidalTrack.id },
    });
    const ytTrack = await prisma.trackYtMusic.create({
        data: {
            id: "remote-only-yt-track",
            videoId: "remote-only-video",
            title: "Remote Song",
            artist: "Remote Artist",
            album: "Remote Album",
            duration: 240,
            artistId: ARTIST_ID,
            albumId: REMOTE_ALBUM_ID,
        },
    });
    await prisma.likedRemoteTrack.create({
        data: { userId: LIKER_ID, trackYtMusicId: ytTrack.id },
    });
    await prisma.trackMapping.create({
        data: {
            trackTidalId: tidalTrack.id,
            trackYtMusicId: ytTrack.id,
            confidence: 1,
            source: "manual",
        },
    });
    const unsharedYtTrack = await prisma.trackYtMusic.create({
        data: {
            id: "remote-unshared-yt-track",
            videoId: "remote-unshared-video",
            title: "Remote Bonus",
            artist: "Remote Artist",
            album: "Remote Album",
            duration: 200,
            artistId: ARTIST_ID,
            albumId: REMOTE_ALBUM_ID,
        },
    });
    await prisma.likedRemoteTrack.create({
        data: { userId: LIKER_ID, trackYtMusicId: unsharedYtTrack.id },
    });
}

async function seedLocalAlbumWithProviderCopy(): Promise<void> {
    await prisma.track.create({
        data: {
            id: "local-album-track",
            albumId: LOCAL_ALBUM_ID,
            title: "Local Song",
            trackNo: 1,
            duration: 180,
            fileModified: new Date("2026-08-20T00:00:00.000Z"),
            fileSize: 1_000,
        },
    });
    const providerTrack = await prisma.trackTidal.create({
        data: {
            id: "local-album-provider-copy",
            tidalId: 666002,
            title: "Local Song",
            artist: "Remote Artist",
            album: "Local Album",
            duration: 180,
            artistId: ARTIST_ID,
            albumId: LOCAL_ALBUM_ID,
        },
    });
    await prisma.likedRemoteTrack.create({
        data: { userId: LIKER_ID, trackTidalId: providerTrack.id },
    });
}

async function seedLocalAlbumWithOnlyProviderCopy(): Promise<void> {
    const providerTrack = await prisma.trackTidal.create({
        data: {
            id: "local-provider-only-copy",
            tidalId: 666003,
            title: "Provider-only Song",
            artist: "Remote Artist",
            album: "Provider-only Local Album",
            duration: 180,
            artistId: ARTIST_ID,
            albumId: LOCAL_PROVIDER_ONLY_ALBUM_ID,
        },
    });
    await prisma.likedRemoteTrack.create({
        data: { userId: LIKER_ID, trackTidalId: providerTrack.id },
    });
}

async function seedMatchedLocalTracks(): Promise<void> {
    const common = {
        trackNo: 1,
        duration: 180,
        fileModified: new Date("2026-10-19T00:00:00.000Z"),
        fileSize: 1_000,
    };
    await prisma.track.createMany({
        data: [
            {
                ...common,
                id: "matched-held-local-track",
                albumId: "matched-held-library-album",
                title: "Held local track",
            },
            {
                ...common,
                id: "matched-removed-local-track",
                albumId: "matched-removed-library-album",
                title: "Removed local track",
                removedAt: new Date("2026-10-19T01:00:00.000Z"),
            },
            {
                ...common,
                id: "matched-federated-track",
                albumId: "matched-federated-library-album",
                title: "Federated track",
                origin: "FEDERATED",
                peerId: FEDERATED_PEER_ID,
                remoteId: "remote-matched-federated-track",
            },
            {
                ...common,
                id: "matched-adopted-local-track",
                albumId: ADOPTED_ALBUM_ID,
                title: "Adopted local track",
            },
            {
                ...common,
                id: "matched-adopted-holder-track",
                albumId: "matched-adopted-library-album",
                title: "Adopted holder track",
            },
        ],
    });
}

async function seedMatchedLikedTracks(): Promise<void> {
    const tracks = [
        ["matched-held-tidal", 666101, REMOTE_HELD_ALBUM_ID],
        ["matched-removed-tidal", 666102, REMOTE_REMOVED_ALBUM_ID],
        ["matched-federated-tidal", 666105, REMOTE_FEDERATED_ALBUM_ID],
        ["matched-unheld-tidal", 666103, REMOTE_UNHELD_ALBUM_ID],
        ["matched-adopted-tidal", 666104, ADOPTED_ALBUM_ID],
    ] as const;
    await Promise.all(
        tracks.map(async ([id, tidalId, albumId]) => {
            await prisma.trackTidal.create({
                data: {
                    id,
                    tidalId,
                    title: id,
                    artist: "Remote Artist",
                    album: albumId,
                    duration: 180,
                    artistId: ARTIST_ID,
                    albumId,
                },
            });
            await prisma.likedRemoteTrack.create({
                data: { userId: LIKER_ID, trackTidalId: id },
            });
        }),
    );
}

async function expectMatchedInLibrary(
    albumId: string,
    expected: boolean,
): Promise<void> {
    const response = await getAlbum(albumId, LIKER_ID, false);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(
        expect.objectContaining({ matchedInLibrary: expected }),
    );
}

describeWithPostgres("remote album route PostgreSQL behavior", () => {
    let admin: Client;

    beforeAll(async () => {
        admin = await createScaleDatabase(
            integrationDatabaseUrl!,
            databaseName!,
        );
        await applyScaleMigrations(process.env.DATABASE_URL!);
        await prisma.user.createMany({
            data: [
                { id: LIKER_ID, username: LIKER_ID },
                { id: OTHER_USER_ID, username: OTHER_USER_ID },
            ],
        });
        await prisma.artist.create({
            data: {
                id: ARTIST_ID,
                mbid: "remote-album-artist-mbid",
                name: "Remote Artist",
            },
        });
        await prisma.federationPeer.create({
            data: {
                id: FEDERATED_PEER_ID,
                name: "Matched Federated Peer",
                direction: "CONSUMER",
                createdById: LIKER_ID,
            },
        });
        await prisma.album.createMany({
            data: [
                {
                    id: REMOTE_ALBUM_ID,
                    rgMbid: "remote:integration-album",
                    artistId: ARTIST_ID,
                    title: "Remote Album",
                    primaryType: "Album",
                    location: "REMOTE",
                },
                {
                    id: LOCAL_ALBUM_ID,
                    rgMbid: "local-integration-album",
                    artistId: ARTIST_ID,
                    title: "Local Album",
                    primaryType: "Album",
                    location: "LIBRARY",
                },
                {
                    id: LOCAL_PROVIDER_ONLY_ALBUM_ID,
                    rgMbid: "local-provider-only-integration-album",
                    artistId: ARTIST_ID,
                    title: "Provider-only Local Album",
                    primaryType: "Album",
                    location: "LIBRARY",
                },
                {
                    id: "matched-held-library-album",
                    rgMbid: HELD_RELEASE_GROUP,
                    artistId: ARTIST_ID,
                    title: "Held Library Album",
                    primaryType: "Album",
                    location: "LIBRARY",
                },
                {
                    id: "matched-removed-library-album",
                    rgMbid: REMOVED_RELEASE_GROUP,
                    artistId: ARTIST_ID,
                    title: "Removed Library Album",
                    primaryType: "Album",
                    location: "LIBRARY",
                },
                {
                    id: "matched-federated-library-album",
                    rgMbid: FEDERATED_RELEASE_GROUP,
                    artistId: ARTIST_ID,
                    title: "Federated-track Library Album",
                    primaryType: "Album",
                    location: "LIBRARY",
                },
                {
                    id: "matched-adopted-library-album",
                    rgMbid: ADOPTED_RELEASE_GROUP,
                    artistId: ARTIST_ID,
                    title: "Adopted Holder Album",
                    primaryType: "Album",
                    location: "LIBRARY",
                },
                {
                    id: REMOTE_HELD_ALBUM_ID,
                    rgMbid: "remote:matched-held",
                    matchedRgMbid: HELD_RELEASE_GROUP,
                    artistId: ARTIST_ID,
                    title: "Held Remote Placeholder",
                    primaryType: "Album",
                    location: "REMOTE",
                },
                {
                    id: REMOTE_REMOVED_ALBUM_ID,
                    rgMbid: "remote:matched-removed",
                    matchedRgMbid: REMOVED_RELEASE_GROUP,
                    artistId: ARTIST_ID,
                    title: "Removed Remote Placeholder",
                    primaryType: "Album",
                    location: "REMOTE",
                },
                {
                    id: REMOTE_FEDERATED_ALBUM_ID,
                    rgMbid: "remote:matched-federated",
                    matchedRgMbid: FEDERATED_RELEASE_GROUP,
                    artistId: ARTIST_ID,
                    title: "Federated-track Remote Placeholder",
                    primaryType: "Album",
                    location: "REMOTE",
                },
                {
                    id: REMOTE_UNHELD_ALBUM_ID,
                    rgMbid: "remote:matched-unheld",
                    matchedRgMbid: "matched-unheld-release-group",
                    artistId: ARTIST_ID,
                    title: "Unheld Remote Placeholder",
                    primaryType: "Album",
                    location: "REMOTE",
                },
                {
                    id: ADOPTED_ALBUM_ID,
                    rgMbid: "remote:matched-adopted",
                    matchedRgMbid: ADOPTED_RELEASE_GROUP,
                    artistId: ARTIST_ID,
                    title: "Adopted Placeholder",
                    primaryType: "Album",
                    location: "LIBRARY",
                },
            ],
        });
        await seedRemoteOnlyAlbum();
        await seedLocalAlbumWithProviderCopy();
        await seedLocalAlbumWithOnlyProviderCopy();
        await seedMatchedLocalTracks();
        await seedMatchedLikedTracks();
    });

    afterAll(async () => {
        await prisma.$disconnect();
        if (admin && databaseName) {
            await dropScaleDatabase(admin, databaseName);
        }
    });

    it.each([true, false])(
        "loads the liked remote-only album with includeTracks=%s",
        async (includeTracks) => {
            const response = await getAlbum(
                REMOTE_ALBUM_ID,
                LIKER_ID,
                includeTracks,
            );
            const body = response.body as {
                source: string;
                owned: boolean;
                tracks: Array<{ id: string }>;
            };

            expect(response.statusCode).toBe(200);
            expect(body.source).toBe("remote");
            expect(body.owned).toBe(false);
            expect(body.tracks.map((track) => track.id)).toEqual(
                includeTracks
                    ? ["tidal:666001", "yt:remote-unshared-video"]
                    : [],
            );
            expect(body).not.toHaveProperty("tracksTidal");
            expect(body).not.toHaveProperty("tracksYtMusic");
        },
    );

    it("prefers TIDAL when liked provider rows share an active canonical mapping", async () => {
        const response = await getAlbum(REMOTE_ALBUM_ID, LIKER_ID, true);
        const body = response.body as { tracks: Array<{ id: string }> };

        expect(response.statusCode).toBe(200);
        expect(body.tracks.map((track) => track.id)).toEqual([
            "tidal:666001",
            "yt:remote-unshared-video",
        ]);
    });

    it.each([true, false])(
        "keeps an unliked remote-only album private with includeTracks=%s",
        async (includeTracks) => {
            const response = await getAlbum(
                REMOTE_ALBUM_ID,
                OTHER_USER_ID,
                includeTracks,
            );

            expect(response.statusCode).toBe(404);
            expect(response.body).toEqual({ error: "Album not found" });
        },
    );

    it("does not append a liked provider copy to a local album", async () => {
        const response = await getAlbum(LOCAL_ALBUM_ID, LIKER_ID, true);
        const body = response.body as { tracks: Array<{ id: string }> };

        expect(response.statusCode).toBe(200);
        expect(body.tracks.map((track) => track.id)).toEqual([
            "local-album-track",
        ]);
        expect(body).not.toHaveProperty("tracksTidal");
        expect(body).not.toHaveProperty("tracksYtMusic");
    });

    it("returns 404 for a local album with only a liked provider relation", async () => {
        const response = await getAlbum(
            LOCAL_PROVIDER_ONLY_ALBUM_ID,
            LIKER_ID,
            true,
        );

        expect(response.statusCode).toBe(404);
        expect(response.body).toEqual({ error: "Album not found" });
    });

    it("reports a REMOTE placeholder as held by a visible local album", async () => {
        await expectMatchedInLibrary(REMOTE_HELD_ALBUM_ID, true);
    });

    it("does not treat a soft-removed local track as holding a match", async () => {
        await expectMatchedInLibrary(REMOTE_REMOVED_ALBUM_ID, false);
    });

    it("does not treat a visible federated track as holding a match", async () => {
        await expectMatchedInLibrary(REMOTE_FEDERATED_ALBUM_ID, false);
    });

    it("reports a matched REMOTE placeholder as unheld without a holder", async () => {
        await expectMatchedInLibrary(REMOTE_UNHELD_ALBUM_ID, false);
    });

    it("reports an adopted LIBRARY placeholder as held by another album", async () => {
        await expectMatchedInLibrary(ADOPTED_ALBUM_ID, true);
    });
});
