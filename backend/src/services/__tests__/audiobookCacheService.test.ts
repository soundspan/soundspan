import path from "path";
import { Prisma } from "@prisma/client";

const mockGetAllAudiobooks = jest.fn();
const mockGetAudiobookListing = jest.fn();
const mockGetAudiobook = jest.fn();
jest.mock("../audiobookshelf", () => ({
    audiobookshelfService: {
        getAllAudiobooks: (...args: any[]) => mockGetAllAudiobooks(...args),
        getAudiobookListing: (...args: any[]) =>
            mockGetAudiobookListing(...args),
        getAudiobook: (...args: any[]) => mockGetAudiobook(...args),
    },
}));

const logger = {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
logger.child.mockReturnValue(logger);
jest.mock("../../utils/logger", () => ({
    logger,
}));

const prisma = {
    audiobook: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        deleteMany: jest.fn(),
    },
    audiobookProgress: {
        deleteMany: jest.fn(),
    },
    playbackState: {
        updateMany: jest.fn(),
    },
    federationTombstone: {
        createMany: jest.fn(),
    },
    $transaction: jest.fn(),
};
const transactionClient = {
    audiobook: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    audiobookProgress: {
        deleteMany: jest.fn(),
    },
    playbackState: {
        updateMany: jest.fn(),
    },
    federationTombstone: {
        createMany: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({
    prisma,
}));

const mockRunWithSchedulerClaim = jest.fn();
jest.mock("../../utils/schedulerClaim", () => ({
    AUDIOBOOK_SYNC_CLAIM_KEY: "scheduler-claim:audiobook-auto-sync",
    AUDIOBOOK_SYNC_CLAIM_TTL_MS: 2 * 60 * 60 * 1000,
    AUDIOBOOK_SYNC_WORK_TIMEOUT_MS: 2 * 60 * 60 * 1000 - 10 * 60_000,
    runWithSchedulerClaim: (...args: any[]) =>
        mockRunWithSchedulerClaim(...args),
}));

const fsPromises = {
    mkdir: jest.fn(),
    writeFile: jest.fn(),
    readdir: jest.fn(),
    unlink: jest.fn(),
};
jest.mock("fs/promises", () => ({
    __esModule: true,
    default: fsPromises,
}));

const mockGetSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: (...args: any[]) => mockGetSystemSettings(...args),
}));

const mockConfig = {
    music: {
        musicPath: "/srv/music",
    },
    features: {
        federation: false,
    },
};
jest.mock("../../config", () => ({ config: mockConfig }));

import { AudiobookCacheService } from "../audiobookCache";
import { MAX_EXTERNAL_IMAGE_BYTES } from "../imageProxy";

function buildBook(overrides: Record<string, any> = {}) {
    return {
        id: "book-1",
        title: "The Book",
        media: {
            duration: 3600,
            numTracks: 1,
            numChapters: 20,
            chapters: [
                { title: "Opening", start: 0, end: 1800 },
                { title: "Closing", start: 1800, end: 3600 },
            ],
            audioFiles: [{ filename: "The Book.m4b", duration: 3600 }],
            coverPath: "items/book-1/cover",
            metadata: {
                title: "The Book",
                authorName: "Author A",
                narratorName: "Narrator A",
                description: "Book description",
                publishedYear: "2024",
                publisher: "Publisher A",
                isbn: "isbn-1",
                asin: "asin-1",
                language: "en",
                genres: ["Fantasy"],
                seriesName: "Saga #2",
            },
        },
        tags: ["tag-1"],
        size: "1024",
        libraryId: "library-1",
        ...overrides,
    };
}

function createDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

type AudiobookFixtureRow = {
    id: string;
    localCoverPath?: string | null;
    lastSyncedAt?: Date;
    libraryId?: string | null;
    peerId?: string | null;
};

function fixtureValue<T extends keyof AudiobookFixtureRow>(
    row: AudiobookFixtureRow,
    key: T,
    fallback: AudiobookFixtureRow[T],
): AudiobookFixtureRow[T] {
    return Object.prototype.hasOwnProperty.call(row, key) ? row[key] : fallback;
}

function matchesAudiobookWhere(
    row: AudiobookFixtureRow,
    where: Record<string, any>,
): boolean {
    const peerId = fixtureValue(row, "peerId", null);
    const libraryId = fixtureValue(row, "libraryId", "library-1");
    const lastSyncedAt = fixtureValue(row, "lastSyncedAt", new Date(0)) as Date;
    if (where.peerId === null && peerId !== null) return false;
    if (where.peerId?.not === null && peerId === null) return false;
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (where.lastSyncedAt?.lt && lastSyncedAt >= where.lastSyncedAt.lt) {
        return false;
    }
    if (where.libraryId?.in && !where.libraryId.in.includes(libraryId)) {
        return false;
    }
    if (typeof where.libraryId === "string" && libraryId !== where.libraryId) {
        return false;
    }
    if (where.libraryId?.not === null && libraryId === null) return false;
    if (where.libraryId?.notIn?.includes(libraryId)) return false;
    if (where.libraryId === null && libraryId !== null) return false;
    return true;
}

function mockAudiobookQueries({
    federatedRows = [],
    pruneRows = [],
    cachedRows = [],
}: {
    federatedRows?: any[];
    pruneRows?: any[];
    cachedRows?: any[];
} = {}) {
    const rows = [...federatedRows, ...pruneRows, ...cachedRows];
    prisma.audiobook.findMany.mockImplementation(async ({ where }) => {
        return rows.filter((row) => matchesAudiobookWhere(row, where ?? {}));
    });
    prisma.audiobook.count.mockImplementation(
        async ({ where }) =>
            rows.filter((row) => matchesAudiobookWhere(row, where ?? {}))
                .length,
    );
}

describe("audiobook cache service behavior", () => {
    const fetchMock = jest.fn();

    beforeEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        jest.resetAllMocks();
        logger.child.mockReturnValue(logger);

        (global as any).fetch = fetchMock;

        mockGetAllAudiobooks.mockResolvedValue([]);
        mockGetAudiobookListing.mockImplementation(async () => {
            const books = await mockGetAllAudiobooks();
            return {
                books,
                verifiedCompleteLibraryIds: new Set(
                    books
                        .map((book: any) => book.libraryId)
                        .filter(
                            (libraryId: unknown): libraryId is string =>
                                typeof libraryId === "string" &&
                                libraryId.length > 0,
                        ),
                ),
            };
        });
        mockGetAudiobook.mockResolvedValue(null);

        fsPromises.mkdir.mockResolvedValue(undefined);
        fsPromises.writeFile.mockResolvedValue(undefined);
        fsPromises.readdir.mockResolvedValue([]);
        fsPromises.unlink.mockResolvedValue(undefined);

        prisma.audiobook.upsert.mockResolvedValue({});
        prisma.audiobook.findUnique.mockResolvedValue(null);
        mockAudiobookQueries();
        transactionClient.audiobook.findMany.mockResolvedValue([]);
        transactionClient.audiobook.deleteMany.mockImplementation(
            async ({ where }: { where: { id: { in: string[] } } }) => ({
                count: where.id.in.length,
            }),
        );
        transactionClient.audiobookProgress.deleteMany.mockResolvedValue({
            count: 0,
        });
        transactionClient.playbackState.updateMany.mockResolvedValue({
            count: 0,
        });
        transactionClient.federationTombstone.createMany.mockResolvedValue({
            count: 0,
        });
        prisma.$transaction.mockImplementation(
            async (
                operation: (
                    transaction: typeof transactionClient,
                ) => Promise<any>,
            ) => operation(transactionClient),
        );
        mockRunWithSchedulerClaim.mockImplementation(
            async (
                _claimKey: string,
                _ttlMs: number,
                _operationName: string,
                operation: () => Promise<unknown>,
            ) => ({ acquired: true, value: await operation() }),
        );
        mockConfig.features.federation = false;

        mockGetSystemSettings.mockResolvedValue({
            audiobookshelfUrl: "http://abs.local",
            audiobookshelfApiKey: "api-key",
        });

        fetchMock.mockResolvedValue(
            new Response(new Uint8Array(8), { status: 200 }),
        );
    });

    it("syncs all audiobooks, parses series metadata, and tracks per-book failures", async () => {
        const service = new AudiobookCacheService();

        mockGetAllAudiobooks.mockResolvedValue([
            buildBook({ id: "book-1" }),
            buildBook({
                id: "book-2",
                media: {
                    metadata: {
                        title: "Broken Book",
                    },
                    coverPath: "items/book-2/cover",
                },
            }),
        ]);
        prisma.audiobook.upsert
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error("db write failed"));

        const result = await service.syncAll();

        expect(result).toEqual({
            synced: 1,
            failed: 1,
            skipped: 0,
            deleted: 0,
            errors: [expect.stringContaining("Failed to sync Broken Book")],
        });
        expect(prisma.audiobook.upsert).toHaveBeenCalledTimes(2);

        const firstUpsertArg = prisma.audiobook.upsert.mock.calls[0][0];
        expect(firstUpsertArg.create).not.toHaveProperty("numChapters");
        expect(firstUpsertArg.create).toEqual(
            expect.objectContaining({
                id: "book-1",
                title: "The Book",
                author: "Author A",
                series: "Saga",
                seriesSequence: "2",
                libraryId: "library-1",
                coverUrl: "items/book-1/cover",
                localCoverPath: path.join(
                    "/srv/music",
                    "cover-cache",
                    "audiobooks",
                    "book-1.jpg",
                ),
                sections: {
                    kind: "chapters",
                    sections: [
                        { index: 0, title: "Opening", startSeconds: 0 },
                        {
                            index: 1,
                            title: "Closing",
                            startSeconds: 1800,
                        },
                    ],
                },
            }),
        );
        expect(firstUpsertArg.update.sections).toEqual(
            firstUpsertArg.create.sections,
        );
        expect(firstUpsertArg.update.libraryId).toBe("library-1");

        expect(fetchMock).toHaveBeenCalledWith(
            "http://abs.local/api/items/book-1/cover",
            {
                headers: {
                    Authorization: "Bearer api-key",
                },
                signal: expect.anything(),
            },
        );
    });

    it("throws when another audiobook sync holds the scheduler claim", async () => {
        const service = new AudiobookCacheService();
        mockRunWithSchedulerClaim.mockResolvedValueOnce({ acquired: false });

        await expect(service.syncAll()).rejects.toThrow(
            "audiobook sync already running",
        );
        expect(mockGetAllAudiobooks).not.toHaveBeenCalled();
        expect(mockRunWithSchedulerClaim).toHaveBeenCalledWith(
            "scheduler-claim:audiobook-auto-sync",
            2 * 60 * 60 * 1000,
            "full audiobook sync",
            expect.any(Function),
        );
    });

    it("skips syncMissing when another audiobook sync holds the scheduler claim", async () => {
        const service = new AudiobookCacheService();
        mockRunWithSchedulerClaim.mockResolvedValueOnce({ acquired: false });

        await expect(service.syncMissing()).resolves.toEqual({
            synced: 0,
            failed: 0,
            skipped: 0,
            deleted: 0,
            errors: [],
        });
        expect(mockGetAllAudiobooks).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(
            "Skipped incremental audiobook sync because another audiobook sync is running",
        );
        expect(mockRunWithSchedulerClaim).toHaveBeenCalledWith(
            "scheduler-claim:audiobook-auto-sync",
            2 * 60 * 60 * 1000,
            "incremental audiobook sync",
            expect.any(Function),
        );
    });

    it("releases the scheduler claim after a successful sync", async () => {
        const service = new AudiobookCacheService();
        let lockHeld = false;
        mockRunWithSchedulerClaim.mockImplementation(
            async (
                _claimKey: string,
                _ttlMs: number,
                _operationName: string,
                operation: () => Promise<unknown>,
            ) => {
                if (lockHeld) return { acquired: false };
                lockHeld = true;
                try {
                    return { acquired: true, value: await operation() };
                } finally {
                    lockHeld = false;
                }
            },
        );

        await expect(service.syncAll()).resolves.toEqual(
            expect.objectContaining({ deleted: 0 }),
        );
        expect(lockHeld).toBe(false);
        await expect(service.syncMissing()).resolves.toEqual(
            expect.objectContaining({ synced: 0 }),
        );
    });

    it("releases the scheduler claim after a failed sync", async () => {
        const service = new AudiobookCacheService();
        let lockHeld = false;
        mockRunWithSchedulerClaim.mockImplementation(
            async (
                _claimKey: string,
                _ttlMs: number,
                _operationName: string,
                operation: () => Promise<unknown>,
            ) => {
                if (lockHeld) return { acquired: false };
                lockHeld = true;
                try {
                    return { acquired: true, value: await operation() };
                } finally {
                    lockHeld = false;
                }
            },
        );
        mockGetAudiobookListing.mockRejectedValueOnce(new Error("sync failed"));

        await expect(service.syncAll()).rejects.toThrow("sync failed");
        expect(lockHeld).toBe(false);

        await expect(service.syncAll()).resolves.toEqual(
            expect.objectContaining({ deleted: 0 }),
        );
    });

    it("keeps the claim until timed-out full sync work actually settles", async () => {
        jest.useFakeTimers();
        const service = new AudiobookCacheService();
        const listingRequested = createDeferred();
        const releaseListing = createDeferred();
        const bodySettled = createDeferred();
        let lockHeld = false;
        mockGetAudiobookListing.mockImplementationOnce(async () => {
            listingRequested.resolve();
            await releaseListing.promise;
            return { books: [], verifiedCompleteLibraryIds: new Set() };
        });
        mockRunWithSchedulerClaim.mockImplementationOnce(
            async (
                _claimKey: string,
                _ttlMs: number,
                _operationName: string,
                operation: () => Promise<unknown>,
            ) => {
                lockHeld = true;
                try {
                    return { acquired: true, value: await operation() };
                } finally {
                    lockHeld = false;
                    bodySettled.resolve();
                }
            },
        );

        const sync = service.syncAll();
        await listingRequested.promise;
        const rejection = expect(sync).rejects.toThrow(
            "Full audiobook sync timed out after 6600000ms",
        );
        await jest.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 - 10 * 60_000);
        await rejection;
        expect(lockHeld).toBe(true);

        releaseListing.resolve();
        await bodySettled.promise;
        expect(lockHeld).toBe(false);
    });

    it("does not overwrite a federated audiobook whose id collides with ABS", async () => {
        const service = new AudiobookCacheService();
        const federatedRow = {
            id: "colliding-book",
            peerId: "peer-1",
            title: "Federated Title",
            localCoverPath: "/federated/cover.jpg",
        };
        mockGetAllAudiobooks.mockResolvedValue([
            buildBook({ id: "colliding-book" }),
        ]);
        mockAudiobookQueries({ federatedRows: [federatedRow] });

        const result = await service.syncAll();

        expect(prisma.audiobook.upsert).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(result).toEqual({
            synced: 0,
            failed: 0,
            skipped: 1,
            deleted: 0,
            errors: [],
        });
        expect(logger.warn).toHaveBeenCalledWith(
            "Skipped ABS book whose id collides with a federated audiobook",
            { audiobookId: "colliding-book" },
        );
    });

    it("prunes local audiobooks missing from a full ABS listing", async () => {
        const service = new AudiobookCacheService();
        const coverPath = path.join(
            "/srv/music",
            "cover-cache",
            "audiobooks",
            "stale-cover.jpg",
        );

        mockGetAllAudiobooks.mockResolvedValue([
            buildBook({ id: "current-book" }),
        ]);
        mockAudiobookQueries({
            pruneRows: [{ id: "stale-book", localCoverPath: coverPath }],
        });

        const result = await service.syncAll();

        expect(prisma.audiobook.findMany).toHaveBeenCalledWith({
            where: {
                peerId: null,
                libraryId: { in: ["library-1"] },
                lastSyncedAt: { lt: expect.any(Date) },
            },
            select: { id: true, localCoverPath: true },
        });
        expect(transactionClient.audiobook.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["stale-book"] },
                peerId: null,
                lastSyncedAt: { lt: expect.any(Date) },
            },
        });
        expect(
            transactionClient.audiobookProgress.deleteMany,
        ).toHaveBeenCalledWith({
            where: { audiobookshelfId: { in: ["stale-book"] } },
        });
        expect(transactionClient.playbackState.updateMany).toHaveBeenCalledWith(
            {
                where: { audiobookId: { in: ["stale-book"] } },
                data: { audiobookId: null },
            },
        );
        expect(
            transactionClient.federationTombstone.createMany,
        ).not.toHaveBeenCalled();
        expect(prisma.audiobook.deleteMany).not.toHaveBeenCalled();
        expect(prisma.audiobookProgress.deleteMany).not.toHaveBeenCalled();
        expect(prisma.playbackState.updateMany).not.toHaveBeenCalled();
        expect(prisma.federationTombstone.createMany).not.toHaveBeenCalled();
        expect(fsPromises.unlink).toHaveBeenCalledWith(coverPath);
        expect(result.deleted).toBe(1);
    });

    it("prunes only rows from libraries with verified-complete listings", async () => {
        const service = new AudiobookCacheService();
        const libraryABook = buildBook({
            id: "library-a-current",
            libraryId: "library-a",
        });
        mockGetAllAudiobooks.mockResolvedValue([libraryABook]);
        mockGetAudiobookListing.mockResolvedValue({
            books: [libraryABook],
            verifiedCompleteLibraryIds: new Set(["library-a"]),
        });
        mockAudiobookQueries({
            pruneRows: [
                {
                    id: "library-a-stale",
                    libraryId: "library-a",
                    localCoverPath: null,
                },
                {
                    id: "library-b-stale",
                    libraryId: "library-b",
                    localCoverPath: null,
                },
            ],
        });

        const result = await service.syncAll();

        expect(result.deleted).toBe(1);
        expect(transactionClient.audiobook.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["library-a-stale"] },
                peerId: null,
                lastSyncedAt: { lt: expect.any(Date) },
            },
        });
        expect(prisma.audiobook.findMany).toHaveBeenCalledWith({
            where: {
                peerId: null,
                libraryId: { in: ["library-a"] },
                lastSyncedAt: { lt: expect.any(Date) },
            },
            select: { id: true, localCoverPath: true },
        });
        expect(logger.debug).toHaveBeenCalledWith(
            "Skipped 1 audiobooks from libraries without verified-complete listings during prune",
        );
    });

    it("spares a verified library with a bogus-empty listing", async () => {
        const service = new AudiobookCacheService();
        const libraryABook = buildBook({
            id: "library-a-current",
            libraryId: "library-a",
        });
        mockGetAudiobookListing.mockResolvedValue({
            books: [libraryABook],
            verifiedCompleteLibraryIds: new Set(["library-a", "library-b"]),
        });
        mockAudiobookQueries({
            pruneRows: [
                {
                    id: "library-a-stale",
                    libraryId: "library-a",
                    localCoverPath: null,
                },
                {
                    id: "library-b-stale",
                    libraryId: "library-b",
                    localCoverPath: null,
                },
            ],
        });

        const result = await service.syncAll();

        expect(result.deleted).toBe(1);
        expect(transactionClient.audiobook.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["library-a-stale"] },
                peerId: null,
                lastSyncedAt: { lt: expect.any(Date) },
            },
        });
        expect(prisma.audiobook.findMany).toHaveBeenCalledWith({
            where: {
                peerId: null,
                libraryId: { in: ["library-a"] },
                lastSyncedAt: { lt: expect.any(Date) },
            },
            select: { id: true, localCoverPath: true },
        });
        expect(logger.warn).toHaveBeenCalledWith(
            "Skipped pruning audiobook library library-b because Audiobookshelf returned an empty listing while 1 local rows exist",
        );
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("never prunes rows with an unknown library and warns once with the count", async () => {
        const service = new AudiobookCacheService();
        const currentBook = buildBook({
            id: "library-a-current",
            libraryId: "library-a",
        });
        mockGetAllAudiobooks.mockResolvedValue([currentBook]);
        mockGetAudiobookListing.mockResolvedValue({
            books: [currentBook],
            verifiedCompleteLibraryIds: new Set(["library-a"]),
        });
        mockAudiobookQueries({
            pruneRows: [
                {
                    id: "unknown-library-book",
                    libraryId: null,
                    localCoverPath: null,
                },
            ],
        });

        const result = await service.syncAll();

        expect(result.deleted).toBe(0);
        expect(transactionClient.audiobook.deleteMany).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            "skipped 1 audiobooks with unknown library during prune",
        );
    });

    it("syncs books from an unverified listing without pruning that library", async () => {
        const service = new AudiobookCacheService();
        const currentBook = buildBook({
            id: "unverified-current",
            libraryId: "unverified-library",
        });
        mockGetAllAudiobooks.mockResolvedValue([currentBook]);
        mockGetAudiobookListing.mockResolvedValue({
            books: [currentBook],
            verifiedCompleteLibraryIds: new Set(),
        });
        mockAudiobookQueries({
            pruneRows: [
                {
                    id: "unverified-stale",
                    libraryId: "unverified-library",
                    localCoverPath: null,
                },
            ],
        });

        const result = await service.syncAll();

        expect(result.synced).toBe(1);
        expect(result.deleted).toBe(0);
        expect(transactionClient.audiobook.deleteMany).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(
            "Skipped 1 audiobooks from libraries without verified-complete listings during prune",
        );
    });

    it("does not select or prune federated audiobook mirrors", async () => {
        const service = new AudiobookCacheService();
        const federatedRow = {
            id: "federated-book",
            peerId: "peer-1",
            localCoverPath: null,
        };
        mockGetAllAudiobooks.mockResolvedValue([
            buildBook({ id: "current-book" }),
        ]);
        mockAudiobookQueries({ federatedRows: [federatedRow] });

        const result = await service.syncAll();

        expect(result.deleted).toBe(0);
        expect(transactionClient.audiobook.deleteMany).not.toHaveBeenCalled();
        expect(prisma.audiobook.findMany).toHaveBeenCalledWith({
            where: {
                peerId: null,
                libraryId: { in: ["library-1"] },
                lastSyncedAt: { lt: expect.any(Date) },
            },
            select: { id: true, localCoverPath: true },
        });
    });

    it("skips pruning when the ABS listing contains an item without an id", async () => {
        const service = new AudiobookCacheService();
        mockGetAllAudiobooks.mockResolvedValue([
            buildBook({ id: "current-book" }),
            {},
        ]);
        mockAudiobookQueries({
            pruneRows: [{ id: "stale-book", localCoverPath: null }],
        });

        const result = await service.syncAll();

        expect(prisma.audiobook.upsert).toHaveBeenCalledTimes(1);
        expect(transactionClient.audiobook.deleteMany).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                "Skipped pruning audiobooks because Audiobookshelf returned a malformed listing",
            ),
        );
        expect(result.deleted).toBe(0);
    });

    it("skips pruning when ABS returns an empty listing but local books exist", async () => {
        const service = new AudiobookCacheService();
        mockAudiobookQueries({
            pruneRows: [{ id: "local-book", localCoverPath: null }],
        });

        const result = await service.syncAll();

        expect(transactionClient.audiobook.deleteMany).not.toHaveBeenCalled();
        expect(
            transactionClient.audiobookProgress.deleteMany,
        ).not.toHaveBeenCalled();
        expect(
            transactionClient.playbackState.updateMany,
        ).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                "Skipped pruning audiobooks because Audiobookshelf returned an empty listing",
            ),
        );
        expect(result).toEqual({
            synced: 0,
            failed: 0,
            skipped: 0,
            deleted: 0,
            errors: [],
        });
    });

    it("completes an empty full sync when no local books exist", async () => {
        const service = new AudiobookCacheService();

        const result = await service.syncAll();

        expect(transactionClient.audiobook.deleteMany).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalledWith(
            expect.stringContaining("Skipped pruning audiobooks"),
        );
        expect(result.deleted).toBe(0);
    });

    it("writes audiobook tombstones for pruned rows when federation is enabled", async () => {
        const service = new AudiobookCacheService();
        mockConfig.features.federation = true;
        mockGetAllAudiobooks.mockResolvedValue([
            buildBook({ id: "current-book" }),
        ]);
        mockAudiobookQueries({
            pruneRows: [
                { id: "stale-1", localCoverPath: null },
                { id: "stale-2", localCoverPath: null },
            ],
        });

        const result = await service.syncAll();

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(
            transactionClient.federationTombstone.createMany,
        ).toHaveBeenCalledWith({
            data: [
                { entityType: "audiobook", entityId: "stale-1" },
                { entityType: "audiobook", entityId: "stale-2" },
            ],
        });
        expect(transactionClient.audiobook.deleteMany).toHaveBeenCalledTimes(1);
        expect(
            transactionClient.audiobookProgress.deleteMany,
        ).toHaveBeenCalledTimes(1);
        expect(
            transactionClient.playbackState.updateMany,
        ).toHaveBeenCalledTimes(1);
        expect(prisma.audiobook.deleteMany).not.toHaveBeenCalled();
        expect(prisma.audiobookProgress.deleteMany).not.toHaveBeenCalled();
        expect(prisma.playbackState.updateMany).not.toHaveBeenCalled();
        expect(prisma.federationTombstone.createMany).not.toHaveBeenCalled();
        expect(result.deleted).toBe(2);
    });

    it("tolerates missing and failed cover cleanup after pruning", async () => {
        const service = new AudiobookCacheService();
        const missingError = Object.assign(new Error("missing"), {
            code: "ENOENT",
        });
        mockGetAllAudiobooks.mockResolvedValue([
            buildBook({ id: "current-book" }),
        ]);
        mockAudiobookQueries({
            pruneRows: [
                { id: "stale-missing", localCoverPath: null },
                { id: "stale-denied", localCoverPath: null },
            ],
        });
        fsPromises.unlink
            .mockRejectedValueOnce(missingError)
            .mockRejectedValueOnce(new Error("EACCES"));

        await expect(service.syncAll()).resolves.toEqual(
            expect.objectContaining({ deleted: 2 }),
        );
        expect(fsPromises.unlink).toHaveBeenNthCalledWith(
            1,
            path.join(
                "/srv/music",
                "cover-cache",
                "audiobooks",
                "stale-missing.jpg",
            ),
        );
        expect(fsPromises.unlink).toHaveBeenNthCalledWith(
            2,
            path.join(
                "/srv/music",
                "cover-cache",
                "audiobooks",
                "stale-denied.jpg",
            ),
        );
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Failed to delete audiobook cover"),
            expect.objectContaining({ audiobookId: "stale-denied" }),
        );
    });

    it("prunes a row with an unsafe stored cover path without unlinking that path", async () => {
        const service = new AudiobookCacheService();
        const unsafePath = "/srv/music/Albums/song.flac";
        mockGetAllAudiobooks.mockResolvedValue([
            buildBook({ id: "current-book" }),
        ]);
        mockAudiobookQueries({
            pruneRows: [{ id: "stale-book", localCoverPath: unsafePath }],
        });

        const result = await service.syncAll();

        expect(result.deleted).toBe(1);
        expect(transactionClient.audiobook.deleteMany).toHaveBeenCalledTimes(1);
        expect(fsPromises.unlink).not.toHaveBeenCalledWith(unsafePath);
        expect(logger.warn).toHaveBeenCalledWith(
            "Skipped unsafe audiobook cover path",
            { audiobookId: "stale-book" },
        );
    });

    it("spares a row refreshed after the prune cutoff", async () => {
        const service = new AudiobookCacheService();
        let pruneCutoff: Date | undefined;
        let refreshedAt: Date | undefined;
        mockGetAllAudiobooks.mockResolvedValue([
            buildBook({ id: "current-book" }),
        ]);
        prisma.audiobook.findMany.mockImplementation(async ({ where }) => {
            if (where?.peerId?.not === null) return [];
            if (where?.peerId === null && where?.lastSyncedAt) {
                const selectedCutoff = where.lastSyncedAt.lt as Date;
                pruneCutoff = selectedCutoff;
                refreshedAt = new Date(selectedCutoff.getTime() + 1_000);
                return [
                    {
                        id: "concurrently-refreshed-book",
                        localCoverPath: null,
                        lastSyncedAt: refreshedAt,
                    },
                ];
            }
            if (where?.id?.in) {
                return [{ id: "concurrently-refreshed-book" }];
            }
            return [];
        });
        transactionClient.audiobook.deleteMany.mockImplementationOnce(
            async ({ where }) => {
                const deleteCutoff = where.lastSyncedAt?.lt;
                const isProtected =
                    deleteCutoff instanceof Date &&
                    refreshedAt instanceof Date &&
                    refreshedAt >= deleteCutoff;
                return { count: isProtected ? 0 : 1 };
            },
        );
        transactionClient.audiobook.findMany.mockResolvedValueOnce([
            { id: "concurrently-refreshed-book" },
        ]);

        const result = await service.syncAll();

        expect(pruneCutoff).toBeInstanceOf(Date);
        expect(refreshedAt!.getTime()).toBeGreaterThan(pruneCutoff!.getTime());
        expect(transactionClient.audiobook.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["concurrently-refreshed-book"] },
                peerId: null,
                lastSyncedAt: { lt: pruneCutoff },
            },
        });
        expect(result.deleted).toBe(0);
        expect(fsPromises.unlink).not.toHaveBeenCalled();
    });

    it("prunes stale audiobooks in batches of at most 100", async () => {
        const service = new AudiobookCacheService();
        const staleRows = Array.from({ length: 101 }, (_, index) => ({
            id: `stale-${index}`,
            localCoverPath: null,
        }));
        mockGetAllAudiobooks.mockResolvedValue([
            buildBook({ id: "current-book" }),
        ]);
        mockAudiobookQueries({ pruneRows: staleRows });

        const result = await service.syncAll();

        expect(transactionClient.audiobook.deleteMany).toHaveBeenCalledTimes(2);
        for (const [args] of transactionClient.audiobook.deleteMany.mock
            .calls) {
            expect(args.where.id.in.length).toBeLessThanOrEqual(100);
        }
        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(result.deleted).toBe(101);
    });

    it("surfaces an expired deadline before opening a prune transaction", async () => {
        const service = new AudiobookCacheService();

        await expect(
            (service as any).pruneAudiobookBatches(
                [{ id: "stale-book", localCoverPath: null }],
                new Date(),
                Date.now() - 1,
            ),
        ).rejects.toMatchObject({
            name: "AudiobookSyncTimeoutError",
            message: "Full audiobook sync timed out after 6600000ms",
        });
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("cleans a committed prune batch before surfacing an expired deadline", async () => {
        const service = new AudiobookCacheService();
        const staleRows = Array.from({ length: 101 }, (_, index) => ({
            id: `stale-${index}`,
            localCoverPath: null,
        }));
        let now = 99;
        jest.spyOn(Date, "now").mockImplementation(() => now);
        prisma.$transaction.mockImplementationOnce(
            async (
                operation: (
                    transaction: typeof transactionClient,
                ) => Promise<any>,
            ) => {
                const deletedRows = await operation(transactionClient);
                now = 100;
                return deletedRows;
            },
        );

        await expect(
            (service as any).pruneAudiobookBatches(staleRows, new Date(), 100),
        ).rejects.toMatchObject({ name: "AudiobookSyncTimeoutError" });

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(fsPromises.unlink).toHaveBeenCalledTimes(100);
        expect(fsPromises.unlink).not.toHaveBeenCalledWith(
            path.join(
                "/srv/music",
                "cover-cache",
                "audiobooks",
                "stale-100.jpg",
            ),
        );
    });

    it("stops syncing at the next book boundary when the deadline expires", async () => {
        const service = new AudiobookCacheService();
        jest.spyOn(Date, "now").mockReturnValueOnce(99).mockReturnValue(100);
        const result = {
            synced: 0,
            failed: 0,
            skipped: 0,
            deleted: 0,
            errors: [],
        };

        await expect(
            (service as any).syncBooks(
                [buildBook({ id: "book-1" }), buildBook({ id: "book-2" })],
                result,
                { logEachBook: false },
                100,
            ),
        ).rejects.toMatchObject({ name: "AudiobookSyncTimeoutError" });
        expect(prisma.audiobook.upsert).toHaveBeenCalledTimes(1);
        expect(prisma.audiobook.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: "book-1" } }),
        );
    });

    it("surfaces a second prune batch failure after cleaning only the first batch covers", async () => {
        const service = new AudiobookCacheService();
        const staleRows = Array.from({ length: 101 }, (_, index) => ({
            id: `stale-${index}`,
            localCoverPath: null,
        }));
        mockGetAllAudiobooks.mockResolvedValue([
            buildBook({ id: "current-book" }),
        ]);
        mockAudiobookQueries({ pruneRows: staleRows });
        prisma.$transaction
            .mockImplementationOnce(
                async (
                    operation: (
                        transaction: typeof transactionClient,
                    ) => Promise<any>,
                ) => operation(transactionClient),
            )
            .mockRejectedValueOnce(new Error("second batch failed"));

        await expect(service.syncAll()).rejects.toThrow("second batch failed");

        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(transactionClient.audiobook.deleteMany).toHaveBeenCalledTimes(1);
        expect(
            transactionClient.audiobook.deleteMany.mock.calls[0][0].where.id.in,
        ).toHaveLength(100);
        expect(fsPromises.unlink).toHaveBeenCalledTimes(100);
        expect(fsPromises.unlink).not.toHaveBeenCalledWith(
            path.join(
                "/srv/music",
                "cover-cache",
                "audiobooks",
                "stale-100.jpg",
            ),
        );
    });

    it("waits for a batch transaction to resolve before unlinking its covers", async () => {
        const service = new AudiobookCacheService();
        const transactionStarted = createDeferred();
        const releaseTransaction = createDeferred();
        mockGetAllAudiobooks.mockResolvedValue([
            buildBook({ id: "current-book" }),
        ]);
        mockAudiobookQueries({
            pruneRows: [{ id: "stale-book", localCoverPath: null }],
        });
        prisma.$transaction.mockImplementationOnce(
            async (
                operation: (
                    transaction: typeof transactionClient,
                ) => Promise<any>,
            ) => {
                const deletedRows = await operation(transactionClient);
                transactionStarted.resolve();
                await releaseTransaction.promise;
                return deletedRows;
            },
        );

        const sync = service.syncAll();
        await transactionStarted.promise;

        expect(fsPromises.unlink).not.toHaveBeenCalled();
        releaseTransaction.resolve();
        await expect(sync).resolves.toEqual(
            expect.objectContaining({ deleted: 1 }),
        );
        expect(fsPromises.unlink).toHaveBeenCalledTimes(1);
    });

    it("syncs only audiobooks missing from the local ABS cache", async () => {
        const service = new AudiobookCacheService();

        mockGetAllAudiobooks.mockResolvedValue([
            buildBook({ id: "book-1" }),
            buildBook({ id: "book-2" }),
        ]);
        mockAudiobookQueries({ cachedRows: [{ id: "book-1" }] });

        const result = await service.syncMissing();

        expect(prisma.audiobook.findMany).toHaveBeenCalledWith({
            where: { peerId: null },
            select: { id: true },
        });
        expect(result).toEqual({
            synced: 1,
            failed: 0,
            skipped: 1,
            deleted: 0,
            errors: [],
        });
        expect(prisma.audiobook.upsert).toHaveBeenCalledTimes(1);
        expect(prisma.audiobook.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "book-2" },
            }),
        );
        expect(transactionClient.audiobook.deleteMany).not.toHaveBeenCalled();
        expect(
            transactionClient.audiobookProgress.deleteMany,
        ).not.toHaveBeenCalled();
        expect(
            transactionClient.playbackState.updateMany,
        ).not.toHaveBeenCalled();
        expect(
            transactionClient.federationTombstone.createMany,
        ).not.toHaveBeenCalled();
    });

    it("records the error message when a missing audiobook fails to sync", async () => {
        const service = new AudiobookCacheService();

        mockGetAllAudiobooks.mockResolvedValue([
            buildBook({
                id: "book-broken",
                media: {
                    metadata: { title: "Broken Book" },
                },
            }),
        ]);
        prisma.audiobook.upsert.mockRejectedValueOnce(
            new Error("db write failed"),
        );

        const result = await service.syncMissing();

        expect(result.failed).toBe(1);
        expect(result.errors[0]).toBe(
            "Failed to sync Broken Book: db write failed",
        );
    });

    it("preserves stored sections on minified updates and creates them as unknown", async () => {
        const service = new AudiobookCacheService();
        mockGetAllAudiobooks.mockResolvedValue([
            buildBook({
                id: "book-minified",
                media: {
                    duration: 3600,
                    numTracks: 1,
                    metadata: {
                        title: "Minified Book",
                        authorName: "Author A",
                    },
                },
            }),
        ]);

        await service.syncAll();

        const upsert = prisma.audiobook.upsert.mock.calls[0][0];
        expect(upsert.update).not.toHaveProperty("sections");
        expect(upsert.create.sections).toBe(Prisma.DbNull);
    });

    it("passes a timeout AbortSignal when downloading a cover", async () => {
        const service = new AudiobookCacheService();
        (service as any).coverCacheAvailable = true;

        await (service as any).downloadCover(
            "book-timeout",
            "http://abs.local/timeout.jpg",
        );

        expect(fetchMock).toHaveBeenCalledWith(
            "http://abs.local/timeout.jpg",
            expect.objectContaining({
                signal: expect.any(AbortSignal),
            }),
        );
    });

    it("continues syncing when cover cache directory is unavailable", async () => {
        const service = new AudiobookCacheService();
        fsPromises.mkdir.mockRejectedValueOnce(new Error("EACCES"));
        mockGetAllAudiobooks.mockResolvedValue([
            buildBook({ id: "book-nocache" }),
        ]);

        const result = await service.syncAll();

        expect(result.synced).toBe(1);
        expect(result.failed).toBe(0);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Cover cache directory unavailable"),
        );
    });

    it("rethrows syncAll fatal failures", async () => {
        const service = new AudiobookCacheService();
        mockGetAllAudiobooks.mockRejectedValueOnce(
            new Error("upstream failure"),
        );

        await expect(service.syncAll()).rejects.toThrow("upstream failure");
        expect(logger.error).toHaveBeenCalledWith(
            " Audiobook sync failed:",
            expect.any(Error),
        );
    });

    it("skips a single audiobook when title is missing", async () => {
        const service = new AudiobookCacheService();

        await (service as any).syncAudiobook({
            id: "missing-title-book",
            media: { metadata: {} },
        });

        expect(prisma.audiobook.upsert).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("missing title"),
        );
    });

    it("resolves full cover URL with settings and handles missing/error settings", async () => {
        const service = new AudiobookCacheService();

        await expect(
            (service as any).getFullCoverUrl("items/book-9/cover"),
        ).resolves.toBe("http://abs.local/api/items/book-9/cover");

        mockGetSystemSettings.mockResolvedValueOnce({});
        await expect(
            (service as any).getFullCoverUrl("items/book-9/cover"),
        ).resolves.toBeNull();

        mockGetSystemSettings.mockRejectedValueOnce(
            new Error("settings failed"),
        );
        await expect(
            (service as any).getFullCoverUrl("items/book-9/cover"),
        ).resolves.toBeNull();
        expect(logger.error).toHaveBeenCalledWith(
            "Failed to get Audiobookshelf base URL:",
            "settings failed",
        );
    });

    it("rejects a traversal-bearing cover path and logs a warning", async () => {
        const service = new AudiobookCacheService();

        await expect(
            (service as any).getFullCoverUrl("items/../../me/cover"),
        ).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("items/../../me/cover"),
        );
    });

    it("skips cover download and caching for a traversal-bearing audiobook id", async () => {
        const service = new AudiobookCacheService();
        mockGetAllAudiobooks.mockResolvedValue([buildBook({ id: "../../me" })]);

        const result = await service.syncAll();

        expect(result).toEqual({
            synced: 1,
            failed: 0,
            skipped: 0,
            deleted: 0,
            errors: [],
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(fsPromises.writeFile).not.toHaveBeenCalled();
        expect(prisma.audiobook.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    id: "../../me",
                    localCoverPath: null,
                }),
            }),
        );
    });

    it.each(["./victim", "..%2Fx"])(
        "does not write a cover for unsafe audiobook id %s",
        async (audiobookId) => {
            const service = new AudiobookCacheService();
            (service as any).coverCacheAvailable = true;

            await expect(
                (service as any).downloadCover(
                    audiobookId,
                    "http://abs.local/cover.jpg",
                ),
            ).resolves.toBeNull();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(fsPromises.writeFile).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledWith(
                "Skipped audiobook cover operation for unsafe audiobook id",
                { audiobookId },
            );
        },
    );

    it.each(["./victim", "..%2Fx"])(
        "does not unlink a fallback cover for unsafe audiobook id %s",
        async (audiobookId) => {
            const service = new AudiobookCacheService();
            mockGetAllAudiobooks.mockResolvedValue([
                buildBook({ id: "current-book" }),
            ]);
            mockAudiobookQueries({
                pruneRows: [{ id: audiobookId, localCoverPath: null }],
            });

            await expect(service.syncAll()).resolves.toEqual(
                expect.objectContaining({ deleted: 1 }),
            );
            expect(fsPromises.unlink).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledWith(
                "Skipped audiobook cover operation for unsafe audiobook id",
                { audiobookId },
            );
        },
    );

    it("round-trips a normal ABS id through cover write and unlink fallback", async () => {
        const service = new AudiobookCacheService();
        const audiobookId = "abs_book-1.2";
        const expectedPath = path.join(
            "/srv/music",
            "cover-cache",
            "audiobooks",
            `${audiobookId}.jpg`,
        );
        (service as any).coverCacheAvailable = true;

        await expect(
            (service as any).downloadCover(
                audiobookId,
                "http://abs.local/cover.jpg",
            ),
        ).resolves.toBe(expectedPath);
        await (service as any).unlinkAudiobookCover({
            id: audiobookId,
            localCoverPath: null,
        });

        expect(fsPromises.writeFile).toHaveBeenCalledWith(
            expectedPath,
            expect.any(Buffer),
        );
        expect(fsPromises.unlink).toHaveBeenCalledWith(expectedPath);
    });

    it("handles cover downloads for unavailable cache, HTTP failures, and success", async () => {
        const service = new AudiobookCacheService();

        await expect(
            (service as any).downloadCover("book-a", "http://abs.local/a.jpg"),
        ).resolves.toBeNull();

        (service as any).coverCacheAvailable = true;

        mockGetSystemSettings.mockResolvedValueOnce({
            audiobookshelfApiKey: null,
        });
        await expect(
            (service as any).downloadCover("book-b", "http://abs.local/b.jpg"),
        ).resolves.toBeNull();

        mockGetSystemSettings.mockResolvedValueOnce({
            audiobookshelfApiKey: "api-key",
        });
        const cancel = jest.fn().mockResolvedValue(undefined);
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 403,
            statusText: "Forbidden",
            body: { cancel },
        });
        await expect(
            (service as any).downloadCover("book-c", "http://abs.local/c.jpg"),
        ).resolves.toBeNull();
        expect(cancel).toHaveBeenCalledTimes(1);

        mockGetSystemSettings.mockResolvedValueOnce({
            audiobookshelfApiKey: "api-key",
        });
        fetchMock.mockResolvedValueOnce(
            new Response(new Uint8Array(16), { status: 200 }),
        );

        const savedPath = await (service as any).downloadCover(
            "book-d",
            "http://abs.local/d.jpg",
        );

        expect(savedPath).toBe(
            path.join("/srv/music", "cover-cache", "audiobooks", "book-d.jpg"),
        );
        expect(fsPromises.writeFile).toHaveBeenCalledWith(
            path.join("/srv/music", "cover-cache", "audiobooks", "book-d.jpg"),
            expect.any(Buffer),
        );
    });

    it("rejects a declared oversized cover and cancels its body", async () => {
        const service = new AudiobookCacheService();
        (service as any).coverCacheAvailable = true;
        const cancel = jest.fn();
        const body = new ReadableStream({ cancel });
        fetchMock.mockResolvedValueOnce(
            new Response(body, {
                status: 200,
                headers: {
                    "content-length": String(MAX_EXTERNAL_IMAGE_BYTES + 1),
                },
            }),
        );

        const savedPath = await (service as any).downloadCover(
            "book-oversized",
            "http://abs.local/oversized.jpg",
        );

        expect(savedPath).toBeNull();
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(fsPromises.writeFile).not.toHaveBeenCalled();
    });

    it("returns fresh cache immediately and refreshes stale cache when needed", async () => {
        const service = new AudiobookCacheService();
        const freshRecord = {
            id: "book-fresh",
            lastSyncedAt: new Date(),
        };
        prisma.audiobook.findUnique.mockResolvedValueOnce(freshRecord);

        const fresh = await service.getAudiobook("book-fresh");
        expect(fresh).toBe(freshRecord);
        expect(mockGetAudiobook).not.toHaveBeenCalled();

        const staleRecord = {
            id: "book-stale",
            lastSyncedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        };
        prisma.audiobook.findUnique
            .mockResolvedValueOnce(staleRecord)
            .mockResolvedValueOnce({
                id: "book-stale",
                title: "Refreshed",
                lastSyncedAt: new Date(),
            });
        mockGetAudiobook.mockResolvedValueOnce(buildBook({ id: "book-stale" }));

        const refreshed = await service.getAudiobook("book-stale");
        expect(mockGetAudiobook).toHaveBeenCalledWith("book-stale");
        expect(prisma.audiobook.upsert).toHaveBeenCalled();
        expect(refreshed).toEqual(
            expect.objectContaining({ title: "Refreshed" }),
        );
    });

    it("refreshes a fresh cache row whose sections are still unknown", async () => {
        const service = new AudiobookCacheService();
        const unknownSectionsRecord = {
            id: "book-unknown-sections",
            sections: null,
            lastSyncedAt: new Date(),
        };
        const refreshedRecord = {
            id: "book-unknown-sections",
            title: "Refreshed",
            sections: {
                kind: "chapters",
                sections: [
                    { index: 0, title: "Opening", startSeconds: 0 },
                    { index: 1, title: "Closing", startSeconds: 1800 },
                ],
            },
            lastSyncedAt: new Date(),
        };
        prisma.audiobook.findUnique
            .mockResolvedValueOnce(unknownSectionsRecord)
            .mockResolvedValueOnce(refreshedRecord);
        mockGetAudiobook.mockResolvedValueOnce(
            buildBook({ id: "book-unknown-sections" }),
        );

        const result = await service.getAudiobook("book-unknown-sections");

        expect(mockGetAudiobook).toHaveBeenCalledTimes(1);
        expect(mockGetAudiobook).toHaveBeenCalledWith("book-unknown-sections");
        expect(prisma.audiobook.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    sections: {
                        kind: "chapters",
                        sections: [
                            { index: 0, title: "Opening", startSeconds: 0 },
                            {
                                index: 1,
                                title: "Closing",
                                startSeconds: 1800,
                            },
                        ],
                    },
                }),
            }),
        );
        expect(result).toBe(refreshedRecord);
    });

    it("falls back to stale cache when refresh fails and throws when no cache exists", async () => {
        const service = new AudiobookCacheService();
        const staleRecord = {
            id: "book-stale-fallback",
            lastSyncedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
        };
        prisma.audiobook.findUnique.mockResolvedValueOnce(staleRecord);
        mockGetAudiobook.mockRejectedValueOnce(new Error("network down"));

        const staleResult = await service.getAudiobook("book-stale-fallback");
        expect(staleResult).toBe(staleRecord);

        prisma.audiobook.findUnique.mockResolvedValueOnce(null);
        mockGetAudiobook.mockRejectedValueOnce(new Error("not reachable"));

        await expect(service.getAudiobook("book-missing")).rejects.toThrow(
            "Audiobook not found in cache and sync failed: not reachable",
        );
    });

    it("cleans orphaned local covers and tolerates read failures", async () => {
        const service = new AudiobookCacheService();

        fsPromises.mkdir.mockRejectedValueOnce(new Error("mkdir denied"));
        await expect(service.cleanupOrphanedCovers()).resolves.toBe(0);

        fsPromises.mkdir.mockResolvedValue(undefined);
        prisma.audiobook.findMany.mockResolvedValueOnce([
            {
                localCoverPath: path.join(
                    "/srv/music",
                    "cover-cache",
                    "audiobooks",
                    "keep.jpg",
                ),
            },
            { localCoverPath: null },
        ]);
        fsPromises.readdir.mockResolvedValueOnce(["keep.jpg", "orphan.jpg"]);

        await expect(service.cleanupOrphanedCovers()).resolves.toBe(1);
        expect(fsPromises.unlink).toHaveBeenCalledWith(
            path.join("/srv/music", "cover-cache", "audiobooks", "orphan.jpg"),
        );

        prisma.audiobook.findMany.mockResolvedValueOnce([]);
        fsPromises.readdir.mockRejectedValueOnce(new Error("readdir failed"));
        await expect(service.cleanupOrphanedCovers()).resolves.toBe(0);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Failed to read cover cache directory"),
        );
    });
});
