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
            ],
        });
        await seedRemoteOnlyAlbum();
        await seedLocalAlbumWithProviderCopy();
        await seedLocalAlbumWithOnlyProviderCopy();
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
});
