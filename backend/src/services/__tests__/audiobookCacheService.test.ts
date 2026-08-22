import path from "path";
import { Prisma } from "@prisma/client";

const mockGetAllAudiobooks = jest.fn();
const mockGetAudiobook = jest.fn();
jest.mock("../audiobookshelf", () => ({
    audiobookshelfService: {
        getAllAudiobooks: (...args: any[]) => mockGetAllAudiobooks(...args),
        getAudiobook: (...args: any[]) => mockGetAudiobook(...args),
    },
}));

const logger = {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};
jest.mock("../../utils/logger", () => ({
    logger,
}));

const prisma = {
    audiobook: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({
    prisma,
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

jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/srv/music",
        },
    },
}));

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

describe("audiobook cache service behavior", () => {
    const fetchMock = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();

        (global as any).fetch = fetchMock;

        mockGetAllAudiobooks.mockResolvedValue([]);
        mockGetAudiobook.mockResolvedValue(null);

        fsPromises.mkdir.mockResolvedValue(undefined);
        fsPromises.writeFile.mockResolvedValue(undefined);
        fsPromises.readdir.mockResolvedValue([]);
        fsPromises.unlink.mockResolvedValue(undefined);

        prisma.audiobook.upsert.mockResolvedValue({});
        prisma.audiobook.findUnique.mockResolvedValue(null);
        prisma.audiobook.findMany.mockResolvedValue([]);

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

    it("syncs only audiobooks missing from the local ABS cache", async () => {
        const service = new AudiobookCacheService();

        mockGetAllAudiobooks.mockResolvedValue([
            buildBook({ id: "book-1" }),
            buildBook({ id: "book-2" }),
        ]);
        prisma.audiobook.findMany.mockResolvedValueOnce([{ id: "book-1" }]);

        const result = await service.syncMissing();

        expect(prisma.audiobook.findMany).toHaveBeenCalledWith({
            where: { peerId: null },
            select: { id: true },
        });
        expect(result).toEqual({
            synced: 1,
            failed: 0,
            skipped: 1,
            errors: [],
        });
        expect(prisma.audiobook.upsert).toHaveBeenCalledTimes(1);
        expect(prisma.audiobook.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "book-2" },
            }),
        );
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
