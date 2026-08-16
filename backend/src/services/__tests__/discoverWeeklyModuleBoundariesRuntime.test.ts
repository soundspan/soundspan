const prisma = {
    $connect: jest.fn(async () => undefined),
    $transaction: jest.fn(async (operation: unknown) => {
        if (typeof operation === "function") {
            return (operation as (client: unknown) => Promise<unknown>)({});
        }
        return operation;
    }),
    album: {
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
    },
    artist: {
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
    },
    discoverExclusion: { findFirst: jest.fn(async () => null) },
    discoveryAlbum: { findFirst: jest.fn(async () => null) },
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
    ownedAlbum: {
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
    },
    play: { findMany: jest.fn(async () => []) },
    track: { findMany: jest.fn(async () => []) },
    userDiscoverConfig: { findUnique: jest.fn(async () => null) },
};

jest.mock("../../utils/db", () => ({ prisma }));

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

jest.mock("../../utils/logger", () => ({ logger: mockLogger }));
jest.mock("../../utils/artistNormalization", () => ({
    normalizeArtistName: jest.fn((name: string) => name),
}));
jest.mock("axios", () => ({
    __esModule: true,
    default: { get: jest.fn(), delete: jest.fn() },
}));
jest.mock("../lastfm", () => ({
    lastFmService: {
        getSimilarArtists: jest.fn(async () => []),
        getArtistTopAlbums: jest.fn(async () => []),
        getTopAlbumsByTag: jest.fn(async () => []),
    },
}));
jest.mock("../musicbrainz", () => ({
    musicBrainzService: { searchAlbum: jest.fn(async () => null) },
}));
jest.mock("../lidarr", () => ({
    lidarrService: {
        getDiscoveryArtists: jest.fn(async () => []),
        removeDiscoveryTagByMbid: jest.fn(async () => ({ success: true })),
        deleteArtistById: jest.fn(async () => ({ success: true })),
        deleteAlbum: jest.fn(async () => ({ success: true })),
        getArtistAlbums: jest.fn(async () => []),
        deleteArtist: jest.fn(async () => ({ success: true })),
    },
}));
jest.mock("../../workers/queues", () => ({
    scanQueue: { add: jest.fn(async () => undefined) },
}));
jest.mock("date-fns", () => ({
    startOfWeek: jest.fn(() => new Date("2026-08-10T00:00:00.000Z")),
    subWeeks: jest.fn((date: Date) => date),
}));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(async () => ({})),
}));

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

jest.mock("../discoveryLogger", () => ({ discoveryLogger }));
jest.mock("../acquisitionService", () => ({
    acquisitionService: { acquireAlbum: jest.fn() },
}));
jest.mock("../discovery", () => ({
    discoveryBatchLogger: {
        warn: jest.fn(async () => undefined),
        error: jest.fn(async () => undefined),
        info: jest.fn(async () => undefined),
    },
    discoveryAlbumLifecycle: {
        processBeforeGeneration: jest.fn(async () => undefined),
    },
    discoverySeeding: {
        getSeedArtists: jest.fn(async () => []),
        isAlbumOwned: jest.fn(async () => false),
    },
}));
jest.mock("../../utils/shuffle", () => ({
    shuffleArray: jest.fn((values: unknown[]) => values),
}));
jest.mock("../artistCountsService", () => ({
    updateArtistCounts: jest.fn(async () => undefined),
}));
jest.mock("../../config", () => ({
    config: { music: { musicPath: "/music" } },
}));
jest.mock("@prisma/client", () => ({
    Prisma: {
        PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
            code = "P1001";
        },
        PrismaClientRustPanicError: class PrismaClientRustPanicError extends Error {},
        PrismaClientUnknownRequestError: class PrismaClientUnknownRequestError extends Error {},
    },
}));

import {
    __discoverWeeklyTestables,
    discoverWeeklyService,
} from "../discoverWeekly";
import { CandidateSelectionService } from "../discoverWeekly/candidateSelection";
import { RecommendationStrategiesService } from "../discoverWeekly/recommendationStrategies";
import { LidarrCleanupService } from "../discoverWeekly/lidarrCleanup";
import { PlaylistPersistenceService } from "../discoverWeekly/playlistPersistence";
import { BatchLifecycleService } from "../discoverWeekly/batchLifecycle";

describe("discover weekly service module boundaries", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.discoveryBatch.findMany.mockResolvedValue([]);
        prisma.discoveryBatch.findUnique.mockResolvedValue(null);
        prisma.downloadJob.findMany.mockResolvedValue([]);
        prisma.userDiscoverConfig.findUnique.mockResolvedValue(null);
    });

    it("preserves retry and tier helpers through the facade", async () => {
        const model = { findMany: jest.fn(async () => ["track-1"]) };
        const client = { model };
        const retryingClient = __discoverWeeklyTestables.createPrismaRetryProxy(
            client,
            "boundary",
        );

        await expect(retryingClient.model.findMany()).resolves.toEqual([
            "track-1",
        ]);
        expect(__discoverWeeklyTestables.getTierFromSimilarity(0.7)).toBe(
            "high",
        );
    });

    it("classifies candidate membership through the facade", async () => {
        expect(discoverWeeklyService).toBeInstanceOf(CandidateSelectionService);

        await expect(
            Reflect.apply(
                Reflect.get(discoverWeeklyService, "isArtistInLibrary"),
                discoverWeeklyService,
                [
                    "Boundary Artist",
                    "boundary-mbid",
                    {
                        mbidHasAlbum: new Map([["boundary-mbid", true]]),
                        nameHasAlbum: new Map<string, boolean>(),
                    },
                ],
            ),
        ).resolves.toBe(true);
    });

    it("runs recommendation fallback through the facade", async () => {
        expect(discoverWeeklyService).toBeInstanceOf(
            RecommendationStrategiesService,
        );

        await expect(
            discoverWeeklyService.findReplacementAlbum(
                { metadata: {} },
                { id: "batch-1", userId: "user-1" },
            ),
        ).resolves.toBeNull();
    });

    it("runs Lidarr cleanup through the facade", async () => {
        expect(discoverWeeklyService).toBeInstanceOf(LidarrCleanupService);

        await expect(
            Reflect.apply(
                Reflect.get(discoverWeeklyService, "cleanupExtraAlbums"),
                discoverWeeklyService,
                [[], "user-1"],
            ),
        ).resolves.toBeUndefined();
    });

    it("runs playlist persistence through the facade", async () => {
        expect(discoverWeeklyService).toBeInstanceOf(
            PlaylistPersistenceService,
        );

        await expect(
            discoverWeeklyService.buildFinalPlaylist("missing-batch"),
        ).resolves.toBeUndefined();
        expect(prisma.downloadJob.findMany).not.toHaveBeenCalled();
    });

    it("runs batch lifecycle checks through the facade", async () => {
        expect(discoverWeeklyService).toBeInstanceOf(BatchLifecycleService);

        await expect(discoverWeeklyService.checkStuckBatches()).resolves.toBe(
            0,
        );
    });

    it("runs generation through the facade without changing errors", async () => {
        await expect(
            discoverWeeklyService.generatePlaylist("user-1"),
        ).rejects.toThrow("Discovery Weekly not enabled");
        expect(discoveryLogger.end).toHaveBeenCalledWith(false, "Not enabled");
    });
});
