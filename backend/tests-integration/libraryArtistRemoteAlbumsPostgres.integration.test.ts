import type { Request, Response } from "express";
import { Client } from "pg";

// The enrichment import graph crashes on ESM-only p-queue in CommonJS Jest.
// These requests set includeDiscography, includeTopTracks, and
// includeSimilarArtists to false, so the handler never calls these mocks.
jest.mock("../src/services/lastfm", () => ({ lastFmService: {} }));
jest.mock("../src/services/musicbrainz", () => ({ musicBrainzService: {} }));
jest.mock("../src/services/dataCache", () => ({ dataCacheService: {} }));
jest.mock("../src/services/metadata/albumCoverResolver", () => ({
    resolveAlbumCover: jest.fn(),
}));
jest.mock("../src/services/metadata/artistImageResolver", () => ({
    resolveArtistImage: jest.fn(),
}));
jest.mock("../src/services/metadata/catalogPersistence", () => ({
    logCatalogPersistenceError: jest.fn(),
    persistCatalogReleaseGroups: jest.fn(),
    readFreshCatalogReleaseGroups: jest.fn(),
}));

import { handleGetArtist as handleLibraryGetArtist } from "../src/routes/library/artists";
import { handleGetArtist as handleSubsonicGetArtist } from "../src/routes/subsonic/browsing";
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

const LIKER_ID = "artist-remote-liker";
const OTHER_USER_ID = "artist-remote-other";
const ARTIST_ID = "artist-remote-detail";
const LOCAL_ALBUM_ID = "artist-remote-local-album";
const TIDAL_ALBUM_ID = "artist-remote-tidal-album";
const YOUTUBE_ALBUM_ID = "artist-remote-youtube-album";
const MAPPED_ALBUM_ID = "artist-remote-mapped-album";
const LOCAL_TRACK_ID = "artist-remote-local-track";

type RouteResponse = {
    statusCode: number;
    body: unknown;
    locals: Record<string, unknown>;
    status(code: number): RouteResponse;
    json(body: unknown): RouteResponse;
    type(contentType: string): RouteResponse;
    send(body: unknown): RouteResponse;
};

function createRouteResponse(): RouteResponse {
    return {
        statusCode: 200,
        body: undefined,
        locals: {},
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
        type() {
            return this;
        },
        send(body) {
            this.body = body;
            return this;
        },
    };
}

async function getLibraryArtist(userId: string): Promise<RouteResponse> {
    const response = createRouteResponse();
    await handleLibraryGetArtist(
        {
            params: { id: ARTIST_ID },
            query: {
                includeDiscography: "false",
                includeTopTracks: "false",
                includeSimilarArtists: "false",
            },
            user: { id: userId },
        } as unknown as Request<{ id: string }>,
        response as unknown as Response,
    );
    return response;
}

async function getSubsonicArtist(userId: string): Promise<RouteResponse> {
    const response = createRouteResponse();
    await handleSubsonicGetArtist(
        {
            query: { id: `ar-${ARTIST_ID}`, f: "json" },
            user: { id: userId },
        } as unknown as Request,
        response as unknown as Response,
    );
    return response;
}

async function seedUsersAndProviders(): Promise<void> {
    await prisma.user.createMany({
        data: [
            { id: LIKER_ID, username: LIKER_ID },
            { id: OTHER_USER_ID, username: OTHER_USER_ID },
        ],
    });
    await prisma.userSettings.createMany({
        data: [
            { userId: LIKER_ID, tidalOAuthJson: "liker-token" },
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
}

async function seedArtistAlbums(): Promise<void> {
    await prisma.artist.create({
        data: {
            id: ARTIST_ID,
            mbid: "artist-remote-detail-mbid",
            name: "Remote Detail Artist",
        },
    });
    await prisma.album.createMany({
        data: [
            {
                id: LOCAL_ALBUM_ID,
                rgMbid: "artist-remote-local-rg",
                artistId: ARTIST_ID,
                title: "Local Album",
                primaryType: "Album",
                location: "LIBRARY",
            },
            {
                id: TIDAL_ALBUM_ID,
                rgMbid: "remote:artist-tidal",
                artistId: ARTIST_ID,
                title: "Tidal Album",
                primaryType: "Album",
                location: "REMOTE",
            },
            {
                id: YOUTUBE_ALBUM_ID,
                rgMbid: "remote:artist-youtube",
                artistId: ARTIST_ID,
                title: "YouTube Album",
                primaryType: "Album",
                location: "REMOTE",
            },
            {
                id: MAPPED_ALBUM_ID,
                rgMbid: "remote:artist-mapped",
                artistId: ARTIST_ID,
                title: "Mapped Album",
                primaryType: "Album",
                location: "REMOTE",
            },
        ],
    });
    await prisma.track.create({
        data: {
            id: LOCAL_TRACK_ID,
            albumId: LOCAL_ALBUM_ID,
            title: "Local Song",
            trackNo: 1,
            duration: 180,
            fileModified: new Date("2026-10-19T00:00:00.000Z"),
            fileSize: 1_000,
        },
    });
}

async function seedTidalAlbumLike(): Promise<void> {
    await prisma.trackTidal.create({
        data: {
            id: "artist-remote-tidal-track",
            tidalId: 927001,
            title: "Tidal Song",
            artist: "Remote Detail Artist",
            album: "Tidal Album",
            duration: 181,
            artistId: ARTIST_ID,
            albumId: TIDAL_ALBUM_ID,
        },
    });
    await prisma.likedRemoteTrack.create({
        data: {
            userId: LIKER_ID,
            trackTidalId: "artist-remote-tidal-track",
        },
    });
}

async function seedYoutubeAlbumLike(): Promise<void> {
    await prisma.trackYtMusic.create({
        data: {
            id: "artist-remote-youtube-track",
            videoId: "artist-remote-youtube-video",
            title: "YouTube Song",
            artist: "Remote Detail Artist",
            album: "YouTube Album",
            duration: 182,
            artistId: ARTIST_ID,
            albumId: YOUTUBE_ALBUM_ID,
        },
    });
    await prisma.likedRemoteTrack.create({
        data: {
            userId: OTHER_USER_ID,
            trackYtMusicId: "artist-remote-youtube-track",
        },
    });
}

async function seedMappedAlbumLike(): Promise<void> {
    await prisma.trackTidal.create({
        data: {
            id: "artist-remote-mapped-track",
            tidalId: 927002,
            title: "Mapped Song",
            artist: "Remote Detail Artist",
            album: "Mapped Album",
            duration: 183,
            artistId: ARTIST_ID,
            albumId: MAPPED_ALBUM_ID,
        },
    });
    await prisma.likedRemoteTrack.create({
        data: {
            userId: LIKER_ID,
            trackTidalId: "artist-remote-mapped-track",
        },
    });
    await prisma.trackMapping.create({
        data: {
            trackId: LOCAL_TRACK_ID,
            trackTidalId: "artist-remote-mapped-track",
            confidence: 1,
            source: "manual",
            stale: false,
        },
    });
}

async function seedRemoteTracks(): Promise<void> {
    await seedTidalAlbumLike();
    await seedYoutubeAlbumLike();
    await seedMappedAlbumLike();
}

describeWithPostgres("artist remote album PostgreSQL behavior", () => {
    let admin: Client;

    beforeAll(async () => {
        admin = await createScaleDatabase(
            integrationDatabaseUrl!,
            databaseName!,
        );
        await applyScaleMigrations(process.env.DATABASE_URL!);
        await seedUsersAndProviders();
        await seedArtistAlbums();
        await seedRemoteTracks();
    });

    afterAll(async () => {
        await prisma.$disconnect();
        if (admin && databaseName) await dropScaleDatabase(admin, databaseName);
    });

    it("lists only the requesting TIDAL user's visible remote album", async () => {
        const response = await getLibraryArtist(LIKER_ID);
        const body = response.body as {
            albums: Array<{
                id: string;
                source: string;
                remoteSources?: string[];
                provenanceSource: string;
                owned: boolean;
            }>;
        };

        expect(response.statusCode).toBe(200);
        expect(body.albums.map((album) => album.id).sort()).toEqual(
            [LOCAL_ALBUM_ID, TIDAL_ALBUM_ID].sort(),
        );
        expect(body.albums).toContainEqual(
            expect.objectContaining({
                id: TIDAL_ALBUM_ID,
                source: "remote",
                remoteSources: ["tidal"],
                provenanceSource: "remote",
                owned: false,
            }),
        );
    });

    it("lists only the requesting YouTube user's visible remote album", async () => {
        const response = await getLibraryArtist(OTHER_USER_ID);
        const body = response.body as {
            albums: Array<{
                id: string;
                remoteSources?: string[];
            }>;
        };

        expect(response.statusCode).toBe(200);
        expect(body.albums.map((album) => album.id).sort()).toEqual(
            [LOCAL_ALBUM_ID, YOUTUBE_ALBUM_ID].sort(),
        );
        expect(body.albums).toContainEqual(
            expect.objectContaining({
                id: YOUTUBE_ALBUM_ID,
                remoteSources: ["youtube"],
            }),
        );
    });

    it("keeps the Subsonic artist response limited to local albums", async () => {
        const response = await getSubsonicArtist(LIKER_ID);
        const body = JSON.parse(String(response.body)) as {
            "subsonic-response": {
                artist: { album: Array<{ id: string }> };
            };
        };

        expect(response.statusCode).toBe(200);
        expect(
            body["subsonic-response"].artist.album.map((album) => album.id),
        ).toEqual([`al-${LOCAL_ALBUM_ID}`]);
    });
});
