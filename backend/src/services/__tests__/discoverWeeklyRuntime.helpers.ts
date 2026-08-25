export function setupDiscoverWeeklyMocks() {
    const axiosMock = {
        get: jest.fn(async () => ({ data: {} })),
        delete: jest.fn(async () => ({ data: {} })),
    };
    const lidarrService = {
        getDiscoveryArtists: jest.fn(async () => []),
        removeDiscoveryTagByMbid: jest.fn(async () => ({ success: true })),
        deleteArtistById: jest.fn(async () => ({ success: true })),
        deleteAlbum: jest.fn(async () => ({ success: true })),
        getArtistAlbums: jest.fn(async () => []),
        deleteArtist: jest.fn(async () => ({ success: true })),
    };
    const lastFmService = {
        getSimilarArtists: jest.fn(async () => []),
        getArtistTopAlbums: jest.fn(async () => []),
        getTopAlbumsByTag: jest.fn(async () => []),
    };
    const musicBrainzService = {
        searchAlbum: jest.fn(async () => null),
    };
    const tx = {
        unavailableAlbum: {
            upsert: jest.fn(async () => undefined),
        },
        discoveryBatch: {
            create: jest.fn(async () => ({ id: "batch-created" })),
            update: jest.fn(async () => undefined),
        },
        discoveryAlbum: {
            upsert: jest.fn(async () => ({ id: "disc-album-1" })),
            create: jest.fn(async () => ({ id: "disc-album-1" })),
        },
        discoveryTrack: {
            create: jest.fn(async () => undefined),
            findFirst: jest.fn(async () => null),
        },
        userDiscoverConfig: {
            findUnique: jest.fn(async () => null),
        },
        discoverExclusion: {
            upsert: jest.fn(async () => undefined),
        },
        downloadJob: {
            findFirst: jest.fn(async () => null),
            create: jest.fn(async () => undefined),
        },
    };

    const prisma = {
        $connect: jest.fn(async () => undefined),
        $transaction: jest.fn(async (arg: unknown) => {
            if (typeof arg === "function") {
                return (arg as (client: typeof tx) => Promise<unknown>)(tx);
            }
            return arg;
        }),
        user: {
            findUnique: jest.fn(async () => ({ role: "admin" })),
        },
        discoveryBatch: {
            findMany: jest.fn(async () => []),
            findUnique: jest.fn(async () => null),
            update: jest.fn(async () => undefined),
        },
        downloadJob: {
            findMany: jest.fn(async () => []),
            update: jest.fn(async () => undefined),
            updateMany: jest.fn(async () => ({ count: 0 })),
        },
        track: {
            findMany: jest.fn(async () => []),
            createMany: jest.fn(async () => ({ count: 0 })),
        },
        album: {
            findMany: jest.fn(async () => []),
            findFirst: jest.fn(async () => null),
        },
        unavailableAlbum: {
            upsert: jest.fn(async () => undefined),
        },
        userDiscoverConfig: {
            findUnique: jest.fn(async () => null),
        },
        discoveryAlbum: {
            findFirst: jest.fn(async () => null),
        },
        ownedAlbum: {
            findFirst: jest.fn(async () => null),
            findMany: jest.fn(async () => []),
        },
        artist: {
            findFirst: jest.fn(async () => null),
            // Default: nobody matches the batched membership prefetch (see
            // prefetchArtistLibraryMembership), i.e. every candidate
            // classifies as not-in-library unless a test overrides this or
            // spies on isArtistInLibrary directly (which still wins --
            // jest.spyOn replaces the whole method regardless of this mock).
            findMany: jest.fn(async () => []),
        },
        discoverExclusion: {
            findFirst: jest.fn(async () => null),
        },
        play: {
            findMany: jest.fn(async () => []),
        },
    };

    const scanQueue = {
        add: jest.fn(async () => undefined),
    };
    const discoveryBatchLogger = {
        warn: jest.fn(async () => undefined),
        error: jest.fn(async () => undefined),
        info: jest.fn(async () => undefined),
    };
    const acquisitionService = {
        acquireAlbum: jest.fn(async () => ({
            success: true,
            source: "soulseek",
            correlationId: "corr-1",
        })),
    };
    const discoveryLogger = {
        start: jest.fn(() => "/tmp/discovery.log"),
        info: jest.fn(),
        section: jest.fn(),
        table: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        success: jest.fn(),
        list: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
    };

    jest.doMock("../../utils/db", () => ({ prisma }));
    jest.doMock("../../utils/logger", () => ({
        logger: {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        },
    }));
    jest.doMock("../../utils/artistNormalization", () => ({
        normalizeArtistName: jest.fn((name: string) => name),
    }));
    jest.doMock("axios", () => ({
        __esModule: true,
        default: axiosMock,
    }));
    jest.doMock("../lastfm", () => ({ lastFmService }));
    jest.doMock("../musicbrainz", () => ({ musicBrainzService }));
    jest.doMock("../lidarr", () => ({ lidarrService }));
    jest.doMock("../../workers/queues", () => ({ scanQueue }));
    jest.doMock("date-fns", () => ({
        startOfWeek: jest.fn(() => new Date("2026-02-16T00:00:00.000Z")),
        subWeeks: jest.fn((date: Date) => date),
    }));
    jest.doMock("../../utils/systemSettings", () => ({
        getSystemSettings: jest.fn(async () => ({})),
    }));
    jest.doMock("../discoveryLogger", () => ({
        discoveryLogger,
    }));
    jest.doMock("../acquisitionService", () => ({ acquisitionService }));
    jest.doMock("../discovery", () => ({
        discoveryBatchLogger,
        discoveryAlbumLifecycle: {
            processBeforeGeneration: jest.fn(async () => undefined),
        },
        discoverySeeding: {
            getSeedArtists: jest.fn(async () => []),
            isAlbumOwned: jest.fn(async () => false),
        },
    }));
    jest.doMock("../../utils/shuffle", () => ({
        shuffleArray: jest.fn((arr: unknown[]) => arr),
    }));
    jest.doMock("../artistCountsService", () => ({
        updateArtistCounts: jest.fn(async () => undefined),
    }));
    jest.doMock("../../config", () => ({
        config: { music: { musicPath: "/music" } },
    }));
    jest.doMock("@prisma/client", () => ({
        Prisma: {
            PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
                code = "P1001";
            },
            PrismaClientRustPanicError: class PrismaClientRustPanicError extends Error {},
            PrismaClientUnknownRequestError: class PrismaClientUnknownRequestError extends Error {},
        },
    }));

    return {
        prisma,
        tx,
        scanQueue,
        discoveryBatchLogger,
        discoveryLogger,
        acquisitionService,
        lidarrService,
        lastFmService,
        musicBrainzService,
        axiosMock,
    };
}
