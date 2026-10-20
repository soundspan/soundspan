import type { Request, Response } from "express";
import type { Prisma } from "@prisma/client";
import { Client } from "pg";

const mockGetReleaseGroups = jest.fn();
const mockSearchArtist = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSetEx = jest.fn();
const mockGetArtistInfo = jest.fn();

jest.mock("../src/services/lastfm", () => ({
    lastFmService: { getArtistInfo: mockGetArtistInfo },
}));
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
import artistsRouter from "../src/routes/artists";
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

const USER_ID = "artist-catalog-release-groups-user";
const ARTIST_A_ID = "artist-catalog-release-groups-a";
const ARTIST_A_MBID = "11111111-1111-4111-8111-111111111191";
const ARTIST_B_ID = "artist-catalog-release-groups-b";
const ARTIST_B_MBID = "22222222-2222-4222-8222-222222222292";
const EMPTY_ARTIST_ID = "artist-catalog-release-groups-empty";
const EMPTY_ARTIST_MBID = "33333333-3333-4333-8333-333333333393";
const SHRINK_ARTIST_ID = "artist-catalog-release-groups-shrink";
const SHRINK_ARTIST_MBID = "44444444-4444-4444-8444-444444444494";
const NORMAL_RG_MBID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const EP_RG_MBID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const DEMO_RG_MBID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const LIVE_RG_MBID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const COLLAB_RG_MBID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
const HIDDEN_RG_MBID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6";
const SHRINK_ONE_RG_MBID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const SHRINK_TWO_RG_MBID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const OLD_CATALOG_TOUCH = new Date("2020-01-01T00:00:00.000Z");
const POLL_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 50;

type RouteResponse = {
    statusCode: number;
    body: unknown;
    status(code: number): RouteResponse;
    json(body: unknown): RouteResponse;
    type(contentType: string): RouteResponse;
    send(body: unknown): RouteResponse;
};

type ArtistAlbum = {
    id: string;
    title: string;
    year: number | null;
    type?: string;
    primaryType?: string;
    source: string;
};

type ArtistResponseBody = { albums: ArtistAlbum[] };

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
            user: { id: USER_ID },
        } as unknown as Request<{ id: string }>,
        response as unknown as Response,
    );
    return response;
}

function getDiscoveryHandler() {
    const layer = (artistsRouter as any).stack.find(
        (entry: any) =>
            entry.route?.path === "/discover/:nameOrMbid" &&
            entry.route?.methods?.get,
    );
    if (!layer) throw new Error("Discovery route not found");
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function discoverArtist(artistName: string): Promise<RouteResponse> {
    const response = createRouteResponse();
    await getDiscoveryHandler()(
        {
            params: { nameOrMbid: artistName },
            query: {
                includeDiscography: "true",
                includeTopTracks: "false",
                includeSimilarArtists: "false",
            },
            user: { id: USER_ID },
        } as unknown as Request<{ nameOrMbid: string }>,
        response as unknown as Response,
    );
    return response;
}

function releaseGroup(
    id: string,
    title: string,
    firstReleaseDate: string,
    primaryType = "Album",
    secondaryTypes: string[] = [],
) {
    return {
        id,
        title,
        "first-release-date": firstReleaseDate,
        "primary-type": primaryType,
        "secondary-types": secondaryTypes,
    };
}

async function seedUserAndArtists(): Promise<void> {
    await prisma.user.create({
        data: {
            id: USER_ID,
            username: USER_ID,
            displayName: "Catalog Test User",
        },
    });
    await prisma.artist.createMany({
        data: [
            { id: ARTIST_A_ID, mbid: ARTIST_A_MBID, name: "Artist A" },
            { id: ARTIST_B_ID, mbid: ARTIST_B_MBID, name: "Artist B" },
            {
                id: EMPTY_ARTIST_ID,
                mbid: EMPTY_ARTIST_MBID,
                name: "Empty Artist",
            },
            {
                id: SHRINK_ARTIST_ID,
                mbid: SHRINK_ARTIST_MBID,
                name: "Shrinking Artist",
            },
        ],
    });
}

async function seedHeldAlbums(): Promise<void> {
    const albums = [
        {
            id: "artist-catalog-hidden-album",
            rgMbid: HIDDEN_RG_MBID,
            artistId: ARTIST_A_ID,
            title: "Held Hidden Album",
            year: 2016,
            primaryType: "Album",
            location: "LIBRARY",
        },
        {
            id: "artist-catalog-collaboration-album",
            rgMbid: COLLAB_RG_MBID,
            artistId: ARTIST_B_ID,
            title: "Artist B Collaboration Album",
            year: 2017,
            primaryType: "Album",
            location: "LIBRARY",
        },
    ] satisfies Prisma.AlbumCreateManyInput[];
    await prisma.album.createMany({ data: albums });
    await prisma.track.createMany({
        data: [
            {
                id: "artist-catalog-hidden-track",
                albumId: "artist-catalog-hidden-album",
                title: "Removed Track",
                trackNo: 1,
                duration: 180,
                fileModified: new Date("2026-10-19T00:00:00.000Z"),
                fileSize: 1,
                removedAt: new Date("2026-10-19T00:00:00.000Z"),
            },
            {
                id: "artist-catalog-collaboration-track",
                albumId: "artist-catalog-collaboration-album",
                title: "Collaboration Track",
                trackNo: 1,
                duration: 181,
                fileModified: new Date("2026-10-19T00:00:00.000Z"),
                fileSize: 1,
            },
        ],
    });
}

async function waitForCatalogSync(
    artistId: string,
    after: Date | null = null,
): Promise<Date> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
        const artist = await prisma.artist.findUnique({
            where: { id: artistId },
            select: { catalogSyncedAt: true },
        });
        const syncedAt = artist?.catalogSyncedAt ?? null;
        if (syncedAt && (after === null || syncedAt > after)) return syncedAt;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`Catalog sync did not complete for ${artistId}`);
}

async function waitForCatalogTouch(rgMbid: string, after: Date): Promise<Date> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
        const album = await prisma.album.findUnique({
            where: { rgMbid },
            select: { catalogTouchedAt: true, location: true },
        });
        const touchedAt =
            album?.location === "CATALOG" ? album.catalogTouchedAt : null;
        if (touchedAt && touchedAt > after) return touchedAt;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`Catalog touch did not complete for ${rgMbid}`);
}

async function resetCatalogTouch(rgMbid: string): Promise<void> {
    const result = await prisma.album.updateMany({
        where: { rgMbid, location: "CATALOG" },
        data: { catalogTouchedAt: OLD_CATALOG_TOUCH },
    });
    expect(result.count).toBe(1);
}

async function expectCatalogSyncToStayNull(artistId: string): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const artist = await prisma.artist.findUnique({
            where: { id: artistId },
            select: { catalogSyncedAt: true },
        });
        expect(artist?.catalogSyncedAt).toBeNull();
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

function albumSummary(body: ArtistResponseBody) {
    return body.albums.map((album) => ({
        id: album.id,
        title: album.title,
        year: album.year,
        type: album.type ?? album.primaryType,
        source: album.source,
    }));
}

describeWithPostgres(
    "artist catalog release groups PostgreSQL behavior",
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
        });

        beforeEach(async () => {
            await prisma.user.deleteMany({ where: { id: USER_ID } });
            await prisma.artist.deleteMany({
                where: {
                    id: {
                        in: [
                            ARTIST_A_ID,
                            ARTIST_B_ID,
                            EMPTY_ARTIST_ID,
                            SHRINK_ARTIST_ID,
                        ],
                    },
                },
            });
            await seedUserAndArtists();
            jest.clearAllMocks();
            mockRedisGet.mockResolvedValue(null);
            mockRedisSetEx.mockResolvedValue("OK");
            mockSearchArtist.mockResolvedValue([]);
            mockGetArtistInfo.mockResolvedValue(null);
        });

        afterAll(async () => {
            config.catalogPersistence.enabled =
                originalCatalogPersistenceEnabled;
            await prisma.$disconnect();
            if (admin && databaseName)
                await dropScaleDatabase(admin, databaseName);
        });

        it("serves the same artist catalog after MusicBrainz persistence", async () => {
            await seedHeldAlbums();
            const providerGroups = [
                releaseGroup(NORMAL_RG_MBID, "Normal Album", "2024-01-02"),
                releaseGroup(EP_RG_MBID, "Catalog EP", "2023-03", "EP"),
                releaseGroup(DEMO_RG_MBID, "Demo Album", "2022", "Album", [
                    "Demo",
                ]),
                releaseGroup(LIVE_RG_MBID, "Live Album", "2021", "Album", [
                    "Live",
                ]),
                releaseGroup(COLLAB_RG_MBID, "Collaboration", "2017"),
                releaseGroup(HIDDEN_RG_MBID, "Held Hidden Album", "2016"),
            ];
            mockGetReleaseGroups.mockResolvedValue(providerGroups);

            const providerResponse = await getArtist(ARTIST_A_ID);
            expect(providerResponse.statusCode).toBe(200);
            await waitForCatalogSync(ARTIST_A_ID);

            const providerIds = (
                providerResponse.body as ArtistResponseBody
            ).albums.map((album) => album.id);
            expect(providerIds).toEqual(
                expect.arrayContaining([
                    NORMAL_RG_MBID,
                    EP_RG_MBID,
                    COLLAB_RG_MBID,
                    HIDDEN_RG_MBID,
                ]),
            );
            expect(providerIds).not.toContain(DEMO_RG_MBID);
            expect(providerIds).not.toContain(LIVE_RG_MBID);
            expect(mockGetReleaseGroups).toHaveBeenCalledTimes(1);

            await resetCatalogTouch(NORMAL_RG_MBID);
            const catalogResponse = await getArtist(ARTIST_A_ID);
            expect(catalogResponse.statusCode).toBe(200);
            await waitForCatalogTouch(NORMAL_RG_MBID, OLD_CATALOG_TOUCH);
            expect(mockGetReleaseGroups).toHaveBeenCalledTimes(1);
            expect(
                albumSummary(catalogResponse.body as ArtistResponseBody),
            ).toEqual(
                albumSummary(providerResponse.body as ArtistResponseBody),
            );
        });

        it("does not mark an empty provider fallback as synced", async () => {
            mockGetReleaseGroups.mockResolvedValue([]);

            expect((await getArtist(EMPTY_ARTIST_ID)).statusCode).toBe(200);
            await expectCatalogSyncToStayNull(EMPTY_ARTIST_ID);
            expect((await getArtist(EMPTY_ARTIST_ID)).statusCode).toBe(200);

            expect(mockGetReleaseGroups).toHaveBeenCalledTimes(2);
            const artist = await prisma.artist.findUnique({
                where: { id: EMPTY_ARTIST_ID },
                select: { catalogSyncedAt: true },
            });
            expect(artist?.catalogSyncedAt).toBeNull();
        });

        it("preserves secondary types when discovery seeds the library catalog", async () => {
            mockSearchArtist.mockResolvedValueOnce([
                { id: ARTIST_A_MBID, name: "Artist A" },
            ]);
            mockGetReleaseGroups.mockResolvedValueOnce([
                releaseGroup(NORMAL_RG_MBID, "Normal Album", "2024-01-02"),
                releaseGroup(DEMO_RG_MBID, "Demo Album", "2022", "Album", [
                    "Demo",
                ]),
            ]);

            const discoveryResponse = await discoverArtist("Artist A");
            expect(discoveryResponse.statusCode).toBe(200);
            expect(
                (discoveryResponse.body as ArtistResponseBody).albums.map(
                    (album) => album.id,
                ),
            ).toEqual([NORMAL_RG_MBID, DEMO_RG_MBID]);
            await waitForCatalogSync(ARTIST_A_ID);

            await resetCatalogTouch(NORMAL_RG_MBID);
            const libraryResponse = await getArtist(ARTIST_A_ID);
            expect(libraryResponse.statusCode).toBe(200);
            await waitForCatalogTouch(NORMAL_RG_MBID, OLD_CATALOG_TOUCH);
            expect(mockGetReleaseGroups).toHaveBeenCalledTimes(1);
            expect(
                (libraryResponse.body as ArtistResponseBody).albums.map(
                    (album) => album.id,
                ),
            ).toEqual([NORMAL_RG_MBID]);
        });

        it("serves discovery from a catalog persisted by the library page", async () => {
            mockGetReleaseGroups.mockResolvedValueOnce([
                releaseGroup(NORMAL_RG_MBID, "Normal Album", "2024-01-02"),
                releaseGroup(DEMO_RG_MBID, "Demo Album", "2022", "Album", [
                    "Demo",
                ]),
                releaseGroup(LIVE_RG_MBID, "Live Album", "2021", "Album", [
                    "Live",
                ]),
            ]);
            mockSearchArtist.mockResolvedValueOnce([
                { id: ARTIST_A_MBID, name: "Artist A" },
            ]);

            const libraryResponse = await getArtist(ARTIST_A_ID);
            expect(libraryResponse.statusCode).toBe(200);
            await waitForCatalogSync(ARTIST_A_ID);

            await resetCatalogTouch(NORMAL_RG_MBID);
            const discoveryResponse = await discoverArtist("Artist A");
            expect(discoveryResponse.statusCode).toBe(200);
            await waitForCatalogTouch(NORMAL_RG_MBID, OLD_CATALOG_TOUCH);

            expect(mockGetReleaseGroups).toHaveBeenCalledTimes(1);
            expect(
                (discoveryResponse.body as ArtistResponseBody).albums.map(
                    (album) => album.id,
                ),
            ).toEqual([NORMAL_RG_MBID, DEMO_RG_MBID]);
        });

        it("replaces a later catalog with the provider's smaller list", async () => {
            mockGetReleaseGroups
                .mockResolvedValueOnce([
                    releaseGroup(SHRINK_ONE_RG_MBID, "Removed Later", "2022"),
                    releaseGroup(SHRINK_TWO_RG_MBID, "Kept Later", "2023"),
                ])
                .mockResolvedValueOnce([
                    releaseGroup(SHRINK_TWO_RG_MBID, "Kept Later", "2023"),
                ]);

            expect((await getArtist(SHRINK_ARTIST_ID)).statusCode).toBe(200);
            await waitForCatalogSync(SHRINK_ARTIST_ID);

            const staleTime = new Date("2020-01-01T00:00:00.000Z");
            await prisma.artist.update({
                where: { id: SHRINK_ARTIST_ID },
                data: { catalogSyncedAt: staleTime },
            });
            expect((await getArtist(SHRINK_ARTIST_ID)).statusCode).toBe(200);
            await waitForCatalogSync(SHRINK_ARTIST_ID, staleTime);

            await resetCatalogTouch(SHRINK_TWO_RG_MBID);
            const catalogResponse = await getArtist(SHRINK_ARTIST_ID);
            await waitForCatalogTouch(SHRINK_TWO_RG_MBID, OLD_CATALOG_TOUCH);
            const ids = (catalogResponse.body as ArtistResponseBody).albums.map(
                (album) => album.id,
            );
            expect(mockGetReleaseGroups).toHaveBeenCalledTimes(2);
            expect(ids).toContain(SHRINK_TWO_RG_MBID);
            expect(ids).not.toContain(SHRINK_ONE_RG_MBID);
        });
    },
);
