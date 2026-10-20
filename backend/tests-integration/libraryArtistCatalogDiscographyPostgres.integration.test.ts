import type { Request, Response } from "express";
import type { Prisma } from "@prisma/client";
import { Client } from "pg";

const mockGetReleaseGroups = jest.fn();
const mockSearchArtist = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSetEx = jest.fn();

// The route's external enrichment and cache boundaries stay mocked while PostgreSQL remains real.
jest.mock("../src/services/lastfm", () => ({ lastFmService: {} }));
jest.mock("../src/services/musicbrainz", () => ({
    musicBrainzService: {
        getReleaseGroups: mockGetReleaseGroups,
        searchArtist: mockSearchArtist,
    },
}));
jest.mock("../src/services/dataCache", () => ({
    dataCacheService: { getArtistImage: jest.fn(async () => null) },
}));
jest.mock("../src/services/metadata/albumCoverResolver", () => ({
    resolveAlbumCover: jest.fn(),
}));
jest.mock("../src/services/metadata/artistImageResolver", () => ({
    resolveArtistImage: jest.fn(),
}));
jest.mock("../src/utils/redis", () => ({
    redisClient: { get: mockRedisGet, setEx: mockRedisSetEx },
}));

import { config } from "../src/config";
import { handleGetArtist } from "../src/routes/library/artists";
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

const ARTIST_A_ID = "catalog-discography-artist-a";
const ARTIST_A_MBID = "11111111-1111-4111-8111-111111111111";
const ARTIST_A_LIBRARY_ALBUM_ID = "catalog-discography-owned-album";
const ARTIST_A_LIBRARY_RG_MBID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ARTIST_A_CATALOG_ALBUM_RG_MBID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const ARTIST_A_CATALOG_EP_RG_MBID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const ARTIST_B_CATALOG_RG_MBID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const ARTIST_C_ID = "catalog-discography-artist-c";
const ARTIST_C_MBID = "33333333-3333-4333-8333-333333333333";
const ARTIST_C_LIBRARY_ALBUM_ID = "catalog-discography-stale-owned";
const ARTIST_C_LIBRARY_RG_MBID = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const FALLBACK_RG_MBID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const OLD_CATALOG_TOUCH = new Date("2020-01-01T00:00:00.000Z");
const POLL_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 50;
const SEEDED_ALBUMS = [
    {
        id: ARTIST_A_LIBRARY_ALBUM_ID,
        rgMbid: ARTIST_A_LIBRARY_RG_MBID,
        artistId: ARTIST_A_ID,
        title: "Owned Album",
        year: 2024,
        primaryType: "Album",
        location: "LIBRARY",
    },
    {
        id: "catalog-discography-album-a",
        rgMbid: ARTIST_A_CATALOG_ALBUM_RG_MBID,
        artistId: ARTIST_A_ID,
        title: "Persisted Album",
        year: 2021,
        primaryType: "Album",
        location: "CATALOG",
        catalogTouchedAt: OLD_CATALOG_TOUCH,
    },
    {
        id: "catalog-discography-ep-a",
        rgMbid: ARTIST_A_CATALOG_EP_RG_MBID,
        artistId: ARTIST_A_ID,
        title: "Persisted EP",
        year: 2019,
        primaryType: "EP",
        location: "CATALOG",
        catalogTouchedAt: OLD_CATALOG_TOUCH,
    },
    {
        id: "catalog-discography-album-b",
        rgMbid: ARTIST_B_CATALOG_RG_MBID,
        artistId: "catalog-discography-artist-b",
        title: "Other Artist Catalog Album",
        year: 2022,
        primaryType: "Album",
        location: "CATALOG",
        catalogTouchedAt: OLD_CATALOG_TOUCH,
    },
    {
        id: ARTIST_C_LIBRARY_ALBUM_ID,
        rgMbid: ARTIST_C_LIBRARY_RG_MBID,
        artistId: ARTIST_C_ID,
        title: "Stale Artist Owned Album",
        year: 2018,
        primaryType: "Album",
        location: "LIBRARY",
    },
    {
        id: "catalog-discography-stale-album",
        rgMbid: "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
        artistId: ARTIST_C_ID,
        title: "Stale Persisted Album",
        year: 2017,
        primaryType: "Album",
        location: "CATALOG",
        catalogTouchedAt: OLD_CATALOG_TOUCH,
    },
] satisfies Prisma.AlbumCreateManyInput[];

type RouteResponse = {
    statusCode: number;
    body: unknown;
    status(code: number): RouteResponse;
    json(body: unknown): RouteResponse;
    type(contentType: string): RouteResponse;
    send(body: unknown): RouteResponse;
};

type ArtistResponseBody = {
    albums: Array<{
        id: string;
        source: string;
        owned: boolean;
        title: string;
        year: number | null;
        type?: string;
    }>;
    discographyComplete: boolean;
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
        type() {
            return this;
        },
        send(body) {
            this.body = body;
            return this;
        },
    };
}

async function getArtist(artistId: string): Promise<RouteResponse> {
    const response = createRouteResponse();
    await handleGetArtist(
        {
            params: { id: artistId },
            query: {
                includeDiscography: "true",
                includeTopTracks: "false",
                includeSimilarArtists: "false",
            },
            user: { id: "catalog-discography-user" },
        } as unknown as Request<{ id: string }>,
        response as unknown as Response,
    );
    return response;
}

async function seedArtists(): Promise<void> {
    const now = Date.now();
    await prisma.artist.createMany({
        data: [
            {
                id: ARTIST_A_ID,
                mbid: ARTIST_A_MBID,
                name: "Fresh Catalog Artist",
                catalogSyncedAt: new Date(now - 24 * 60 * 60 * 1000),
            },
            {
                id: "catalog-discography-artist-b",
                mbid: "22222222-2222-4222-8222-222222222222",
                name: "Other Catalog Artist",
            },
            {
                id: ARTIST_C_ID,
                mbid: ARTIST_C_MBID,
                name: "Stale Catalog Artist",
                catalogSyncedAt: new Date(now - 8 * 24 * 60 * 60 * 1000),
            },
        ],
    });
}

async function seedAlbums(): Promise<void> {
    await prisma.album.createMany({ data: SEEDED_ALBUMS });
}

async function seedCatalogReleaseGroups(): Promise<void> {
    await prisma.artistCatalogReleaseGroup.createMany({
        data: [
            {
                artistId: ARTIST_A_ID,
                rgMbid: ARTIST_A_CATALOG_ALBUM_RG_MBID,
                position: 0,
                title: "Persisted Album",
                firstReleaseDate: "2021",
                primaryType: "Album",
                secondaryTypes: [],
            },
            {
                artistId: ARTIST_A_ID,
                rgMbid: ARTIST_A_CATALOG_EP_RG_MBID,
                position: 1,
                title: "Persisted EP",
                firstReleaseDate: "2019",
                primaryType: "EP",
                secondaryTypes: [],
            },
        ],
    });
}

async function seedOwnedTracks(): Promise<void> {
    const fileModified = new Date("2026-10-19T00:00:00.000Z");
    await prisma.track.createMany({
        data: [
            {
                id: "catalog-discography-owned-track",
                albumId: ARTIST_A_LIBRARY_ALBUM_ID,
                title: "Owned Track",
                trackNo: 1,
                duration: 180,
                fileModified,
                fileSize: 1_000,
            },
            {
                id: "catalog-discography-stale-owned-track",
                albumId: ARTIST_C_LIBRARY_ALBUM_ID,
                title: "Stale Artist Owned Track",
                trackNo: 1,
                duration: 181,
                fileModified,
                fileSize: 1_001,
            },
        ],
    });
}

async function waitForArtistACatalogTouch(): Promise<void> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
        const albums = await prisma.album.findMany({
            where: { artistId: ARTIST_A_ID, location: "CATALOG" },
            select: { catalogTouchedAt: true },
        });
        const touches = albums.flatMap((album) =>
            album.catalogTouchedAt === null ? [] : [album.catalogTouchedAt],
        );
        if (
            touches.length === 2 &&
            touches.every((touch) => touch > OLD_CATALOG_TOUCH)
        ) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(
        `Catalog touch did not complete within ${POLL_ATTEMPTS} polls`,
    );
}

async function waitForPersistedReleaseGroup(rgMbid: string): Promise<void> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
        const album = await prisma.album.findUnique({
            where: { rgMbid },
            select: { id: true },
        });
        if (album) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(
        `Catalog write-through did not complete within ${POLL_ATTEMPTS} polls`,
    );
}

function expectFreshArtistAAlbums(body: ArtistResponseBody): void {
    expect(body.albums).toContainEqual(
        expect.objectContaining({
            id: ARTIST_A_LIBRARY_ALBUM_ID,
            source: "database",
            title: "Owned Album",
        }),
    );
    expect(body.albums).toContainEqual(
        expect.objectContaining({
            id: ARTIST_A_CATALOG_ALBUM_RG_MBID,
            source: "musicbrainz",
            owned: false,
            title: "Persisted Album",
            year: 2021,
            type: "Album",
        }),
    );
    expect(body.albums).toContainEqual(
        expect.objectContaining({
            id: ARTIST_A_CATALOG_EP_RG_MBID,
            source: "musicbrainz",
            owned: false,
            title: "Persisted EP",
            year: 2019,
            type: "EP",
        }),
    );
    expect(body.albums.map((album) => album.id)).not.toContain(
        ARTIST_B_CATALOG_RG_MBID,
    );
}

function expectArtistACatalogCached(): void {
    expect(mockRedisSetEx).toHaveBeenCalledWith(
        `discography:${ARTIST_A_MBID}`,
        86_400,
        expect.any(String),
    );
    const cacheCall = mockRedisSetEx.mock.calls.find(
        ([key]) => key === `discography:${ARTIST_A_MBID}`,
    );
    expect(cacheCall).toBeDefined();
    const cachedGroups = JSON.parse(String(cacheCall?.[2])) as Array<{
        id: string;
    }>;
    expect(cachedGroups.map((group) => group.id).sort()).toEqual(
        [ARTIST_A_CATALOG_ALBUM_RG_MBID, ARTIST_A_CATALOG_EP_RG_MBID].sort(),
    );
}

describeWithPostgres(
    "library artist catalog discography PostgreSQL behavior",
    () => {
        let admin: Client;
        let originalCatalogPersistenceEnabled: boolean;

        beforeAll(async () => {
            originalCatalogPersistenceEnabled =
                config.catalogPersistence.enabled;
            config.catalogPersistence.enabled = true;
            admin = await createScaleDatabase(
                integrationDatabaseUrl!,
                databaseName!,
            );
            await applyScaleMigrations(process.env.DATABASE_URL!);
            await seedArtists();
            await seedAlbums();
            await seedCatalogReleaseGroups();
            await seedOwnedTracks();
        });

        beforeEach(() => {
            config.catalogPersistence.enabled = true;
            mockRedisGet.mockResolvedValue(null);
            mockRedisSetEx.mockResolvedValue("OK");
            mockGetReleaseGroups.mockResolvedValue([]);
            mockSearchArtist.mockResolvedValue([]);
        });

        afterAll(async () => {
            config.catalogPersistence.enabled =
                originalCatalogPersistenceEnabled;
            await prisma.$disconnect();
            if (admin && databaseName)
                await dropScaleDatabase(admin, databaseName);
        });

        it("serves a fresh persisted catalog when the discography cache misses", async () => {
            const response = await getArtist(ARTIST_A_ID);
            const body = response.body as ArtistResponseBody;

            expect(response.statusCode).toBe(200);
            expect(mockGetReleaseGroups).not.toHaveBeenCalled();
            expectFreshArtistAAlbums(body);
            expect(body.discographyComplete).toBe(true);
            expectArtistACatalogCached();
            await waitForArtistACatalogTouch();
        });

        it("falls back to MusicBrainz when the persisted catalog is stale", async () => {
            mockGetReleaseGroups.mockResolvedValueOnce([
                {
                    id: FALLBACK_RG_MBID,
                    title: "Provider Album",
                    "first-release-date": "2020-04-03",
                    "primary-type": "Album",
                    "secondary-types": [],
                },
            ]);

            const response = await getArtist(ARTIST_C_ID);
            const body = response.body as {
                albums: Array<{ id: string; source: string }>;
            };

            expect(response.statusCode).toBe(200);
            expect(mockGetReleaseGroups).toHaveBeenCalledTimes(1);
            expect(mockGetReleaseGroups).toHaveBeenCalledWith(
                ARTIST_C_MBID,
                ["album", "ep"],
                100,
            );
            expect(body.albums).toContainEqual(
                expect.objectContaining({
                    id: FALLBACK_RG_MBID,
                    source: "musicbrainz",
                }),
            );
            await waitForPersistedReleaseGroup(FALLBACK_RG_MBID);
        });

        it("falls back to MusicBrainz when catalog persistence is disabled", async () => {
            config.catalogPersistence.enabled = false;

            try {
                const response = await getArtist(ARTIST_A_ID);

                expect(response.statusCode).toBe(200);
                expect(mockGetReleaseGroups).toHaveBeenCalledTimes(1);
                expect(mockGetReleaseGroups).toHaveBeenCalledWith(
                    ARTIST_A_MBID,
                    ["album", "ep"],
                    100,
                );
            } finally {
                config.catalogPersistence.enabled = true;
            }
        });
    },
);
