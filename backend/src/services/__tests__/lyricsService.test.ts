import axios from "axios";
import * as fs from "fs";

const mockPrisma = {
    trackLyrics: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
    },
    track: {
        findUnique: jest.fn(),
    },
};

const mockRedisClient = {
    get: jest.fn(),
    setEx: jest.fn(),
};

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

const mockParseFile = jest.fn();

jest.mock("axios");
jest.mock("../../utils/db", () => ({ prisma: mockPrisma }));
jest.mock("../../utils/redis", () => ({ redisClient: mockRedisClient }));
jest.mock("../../utils/logger", () => ({ logger: mockLogger }));
jest.mock("fs", () => ({ existsSync: jest.fn() }));
jest.mock("music-metadata", () => ({
    parseFile: mockParseFile,
}), { virtual: true });

import { getLyrics, clearLyricsCache } from "../lyrics";

const buildAxiosError = (
    status: number,
    headers: Record<string, unknown> = {}
) => {
    const error = new Error(`HTTP ${status}`) as any;
    error.response = { status, headers };
    return error;
};

describe("lyrics service", () => {
    const mockAxiosGet = axios.get as jest.MockedFunction<typeof axios.get>;
    const mockFsExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;

    beforeEach(() => {
        jest.clearAllMocks();

        mockPrisma.trackLyrics.findUnique.mockResolvedValue(null);
        mockPrisma.trackLyrics.upsert.mockResolvedValue({});
        mockPrisma.trackLyrics.deleteMany.mockResolvedValue({ count: 1 });
        mockPrisma.track.findUnique.mockResolvedValue(null);

        mockRedisClient.get.mockResolvedValue(null);
        mockRedisClient.setEx.mockResolvedValue("OK");

        mockFsExistsSync.mockReturnValue(false);
        mockParseFile.mockResolvedValue({ common: {} } as any);

        mockAxiosGet.mockResolvedValue({ data: [] } as any);
    });

    it("returns cached lyrics from the database", async () => {
        mockPrisma.trackLyrics.findUnique.mockResolvedValue({
            syncedLyrics: null,
            plainLyrics: "cached plain lyrics",
            source: "embedded",
        });

        const result = await getLyrics("track-cache-hit");

        expect(result).toEqual({
            syncedLyrics: null,
            plainLyrics: "cached plain lyrics",
            source: "embedded",
            synced: false,
        });
        expect(mockPrisma.track.findUnique).not.toHaveBeenCalled();
        expect(mockPrisma.trackLyrics.upsert).not.toHaveBeenCalled();
        expect(mockRedisClient.get).not.toHaveBeenCalled();
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it("returns external cached lyrics when track metadata is missing", async () => {
        const lookupContext = {
            artistName: "Artist! Name",
            trackName: "Song (Live)",
            albumName: "Album #1",
            duration: 123.2,
        };
        mockPrisma.track.findUnique.mockResolvedValue(null);
        mockRedisClient.get.mockResolvedValueOnce(
            JSON.stringify({
                syncedLyrics: null,
                plainLyrics: "cached external",
                source: "lrclib",
                synced: false,
            })
        );

        const result = await getLyrics("track-missing", lookupContext);

        expect(result).toEqual({
            syncedLyrics: null,
            plainLyrics: "cached external",
            source: "lrclib",
            synced: false,
        });
        expect(mockRedisClient.get).toHaveBeenCalledWith(
            "lyrics:external:artist name:song live:album 1:123"
        );
        expect(mockPrisma.trackLyrics.upsert).not.toHaveBeenCalled();
        expect(mockRedisClient.setEx).not.toHaveBeenCalled();
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it("extracts embedded synchronized lyrics and caches them", async () => {
        mockPrisma.track.findUnique.mockResolvedValue({
            id: "track-embedded",
            filePath: "/music/embedded.mp3",
            displayTitle: "Embedded Song",
            title: "Embedded Song",
            duration: 200,
            album: {
                title: "Embedded Album",
                artist: { name: "Embedded Artist" },
            },
        });
        mockFsExistsSync.mockReturnValue(true);
        mockParseFile.mockResolvedValue({
            common: {
                lyrics: [
                    {
                        syncText: [
                            { timestamp: 1234, text: "First line" },
                            { timestamp: 4567, text: "Second line" },
                        ],
                    },
                ],
            },
        } as any);

        const result = await getLyrics("track-embedded");

        expect(result).toEqual({
            syncedLyrics: "[00:01.23] First line\n[00:04.56] Second line",
            plainLyrics: "First line\nSecond line",
            source: "embedded",
            synced: true,
        });
        expect(mockPrisma.trackLyrics.upsert).toHaveBeenCalledWith({
            where: { trackId: "track-embedded" },
            update: {
                syncedLyrics: "[00:01.23] First line\n[00:04.56] Second line",
                plainLyrics: "First line\nSecond line",
                source: "embedded",
            },
            create: {
                trackId: "track-embedded",
                syncedLyrics: "[00:01.23] First line\n[00:04.56] Second line",
                plainLyrics: "First line\nSecond line",
                source: "embedded",
            },
        });
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it("extracts embedded plain lyrics and marks result as unsynced", async () => {
        mockPrisma.track.findUnique.mockResolvedValue({
            id: "track-embedded-plain",
            filePath: "/music/plain.mp3",
            displayTitle: "Embedded Plain",
            title: "Embedded Plain",
            duration: 200,
            album: {
                title: "Embedded Album",
                artist: { name: "Embedded Artist" },
            },
        });
        mockFsExistsSync.mockReturnValue(true);
        mockParseFile.mockResolvedValue({
            common: {
                lyrics: [
                    {
                        text: "Intro line\nBridge line",
                    },
                ],
            },
        } as any);

        const result = await getLyrics("track-embedded-plain");

        expect(result).toEqual({
            syncedLyrics: null,
            plainLyrics: "Intro line\nBridge line",
            source: "embedded",
            synced: false,
        });
        expect(mockPrisma.trackLyrics.upsert).toHaveBeenCalledWith({
            where: { trackId: "track-embedded-plain" },
            update: {
                syncedLyrics: null,
                plainLyrics: "Intro line\nBridge line",
                source: "embedded",
            },
            create: {
                trackId: "track-embedded-plain",
                syncedLyrics: null,
                plainLyrics: "Intro line\nBridge line",
                source: "embedded",
            },
        });
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it("falls back to LRCLIB when embedded extraction errors", async () => {
        mockPrisma.track.findUnique.mockResolvedValue({
            id: "track-embedded-fallback",
            filePath: "/music/broken.mp3",
            displayTitle: "Fallback Song",
            title: "Fallback Song",
            duration: 180,
            album: {
                title: "Fallback Album",
                artist: { name: "Fallback Artist" },
            },
        });
        mockFsExistsSync.mockReturnValue(true);
        mockParseFile.mockRejectedValue(new Error("metadata parse fail"));
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url.endsWith("/get")) {
                return {
                    data: {
                        syncedLyrics: "[00:00.00] Fallback line",
                        plainLyrics: "Fallback line",
                    },
                } as any;
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await getLyrics("track-embedded-fallback");

        expect(result).toEqual({
            syncedLyrics: "[00:00.00] Fallback line",
            plainLyrics: "Fallback line",
            source: "lrclib",
            synced: true,
        });
        expect(mockPrisma.trackLyrics.upsert).toHaveBeenCalledWith({
            where: { trackId: "track-embedded-fallback" },
            update: {
                syncedLyrics: "[00:00.00] Fallback line",
                plainLyrics: "Fallback line",
                source: "lrclib",
            },
            create: {
                trackId: "track-embedded-fallback",
                syncedLyrics: "[00:00.00] Fallback line",
                plainLyrics: "Fallback line",
                source: "lrclib",
            },
        });
        const getCall = mockAxiosGet.mock.calls.find(([url]) =>
            String(url).endsWith("/get")
        );
        expect(getCall).toBeDefined();
    });

    it("resolves LRCLIB lyrics from /get and caches the result", async () => {
        mockPrisma.track.findUnique.mockResolvedValue({
            id: "track-lrclib-get",
            filePath: null,
            displayTitle: "Network Song",
            title: "Network Song",
            duration: 180,
            album: {
                title: "Network Album",
                artist: { name: "Network Artist" },
            },
        });
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url.endsWith("/get")) {
                return {
                    data: {
                        syncedLyrics: "[00:00.00] API line",
                        plainLyrics: "API line",
                    },
                } as any;
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await getLyrics("track-lrclib-get");

        expect(result).toEqual({
            syncedLyrics: "[00:00.00] API line",
            plainLyrics: "API line",
            source: "lrclib",
            synced: true,
        });
        expect(mockPrisma.trackLyrics.upsert).toHaveBeenCalledWith({
            where: { trackId: "track-lrclib-get" },
            update: {
                syncedLyrics: "[00:00.00] API line",
                plainLyrics: "API line",
                source: "lrclib",
            },
            create: {
                trackId: "track-lrclib-get",
                syncedLyrics: "[00:00.00] API line",
                plainLyrics: "API line",
                source: "lrclib",
            },
        });

        const getCall = mockAxiosGet.mock.calls.find(([url]) =>
            String(url).endsWith("/get")
        );
        expect(getCall).toBeDefined();
        expect(getCall?.[1]).toEqual(
            expect.objectContaining({
                params: expect.objectContaining({
                    artist_name: "Network Artist",
                    track_name: "Network Song",
                    duration: 180,
                }),
            })
        );
        expect(
            mockAxiosGet.mock.calls.some(([url]) => String(url).endsWith("/search"))
        ).toBe(false);
    });

    it("caches external misses for missing tracks and serves them from Redis", async () => {
        const lookupContext = {
            artistName: "Missing Artist",
            trackName: "Missing Track",
            albumName: "Missing Album",
            duration: 200.4,
        };
        const missCacheKey =
            "lyrics:external:missing artist:missing track:missing album:200";
        const missPayload = JSON.stringify({
            syncedLyrics: null,
            plainLyrics: null,
            source: "none",
            synced: false,
        });
        mockPrisma.track.findUnique.mockResolvedValue(null);
        mockRedisClient.get.mockResolvedValue(null);
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url.endsWith("/search")) {
                return { data: [] } as any;
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const first = await getLyrics("track-external-miss", lookupContext);

        mockAxiosGet.mockClear();
        mockRedisClient.get.mockImplementation(async (key: string) => {
            if (key === missCacheKey) {
                return missPayload;
            }
            return null;
        });

        const second = await getLyrics("track-external-miss", lookupContext);

        expect(first).toEqual({
            syncedLyrics: null,
            plainLyrics: null,
            source: "none",
            synced: false,
        });
        expect(second).toEqual(first);
        expect(mockAxiosGet).not.toHaveBeenCalled();
        expect(mockRedisClient.get).toHaveBeenCalledWith(missCacheKey);
        expect(mockRedisClient.setEx).toHaveBeenCalledWith(
            missCacheKey,
            30 * 24 * 60 * 60,
            missPayload
        );
    });

    it("falls back to LRCLIB /search when duration-based lookups miss", async () => {
        mockPrisma.track.findUnique.mockResolvedValue({
            id: "track-lrclib-search",
            filePath: null,
            displayTitle: "Fallback Song",
            title: "Fallback Song",
            duration: 1,
            album: {
                title: "Fallback Album",
                artist: { name: "Fallback Artist" },
            },
        });
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url.endsWith("/get")) {
                const notFoundError: any = new Error("Not found");
                notFoundError.response = { status: 404 };
                throw notFoundError;
            }
            if (url.endsWith("/search")) {
                return {
                    data: [
                        {
                            id: 101,
                            trackName: "Different Song",
                            artistName: "Different Artist",
                            albumName: "Different Album",
                            duration: 1,
                            instrumental: false,
                            plainLyrics: "wrong",
                            syncedLyrics: null,
                        },
                        {
                            id: 102,
                            trackName: "Fallback Song",
                            artistName: "Fallback Artist",
                            albumName: "Fallback Album",
                            duration: 1,
                            instrumental: false,
                            plainLyrics: "Fallback plain lyrics",
                            syncedLyrics: null,
                        },
                    ],
                } as any;
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await getLyrics("track-lrclib-search");

        expect(result).toEqual({
            syncedLyrics: null,
            plainLyrics: "Fallback plain lyrics",
            source: "lrclib",
            synced: false,
        });
        expect(mockPrisma.trackLyrics.upsert).toHaveBeenCalledWith({
            where: { trackId: "track-lrclib-search" },
            update: {
                syncedLyrics: null,
                plainLyrics: "Fallback plain lyrics",
                source: "lrclib",
            },
            create: {
                trackId: "track-lrclib-search",
                syncedLyrics: null,
                plainLyrics: "Fallback plain lyrics",
                source: "lrclib",
            },
        });

        const getCalls = mockAxiosGet.mock.calls.filter(([url]) =>
            String(url).endsWith("/get")
        );
        const searchCalls = mockAxiosGet.mock.calls.filter(([url]) =>
            String(url).endsWith("/search")
        );
        expect(getCalls.length).toBeGreaterThan(0);
        expect(searchCalls).toHaveLength(1);
    });

    it("sets LRCLIB backoff on 429 and skips further LRCLIB requests", async () => {
        mockPrisma.track.findUnique.mockResolvedValue({
            id: "track-backoff-429",
            filePath: null,
            displayTitle: "Backoff Song",
            title: "Backoff Song",
            duration: 210,
            album: {
                title: "Backoff Album",
                artist: { name: "Backoff Artist" },
            },
        });
        mockRedisClient.get.mockResolvedValue(null);
        mockAxiosGet.mockRejectedValue(buildAxiosError(429, { "retry-after": "12" }));

        const result = await getLyrics("track-backoff-429");

        expect(result).toEqual({
            syncedLyrics: null,
            plainLyrics: null,
            source: "none",
            synced: false,
        });
        expect(mockRedisClient.setEx).toHaveBeenCalledWith(
            "lyrics:lrclib:backoff_until",
            12,
            expect.any(String)
        );
    });

    it("caches misses when no lyrics are found", async () => {
        mockPrisma.track.findUnique.mockResolvedValue({
            id: "track-no-lyrics",
            filePath: null,
            displayTitle: "No Lyrics Song",
            title: "No Lyrics Song",
            duration: null,
            album: {
                title: "No Lyrics Album",
                artist: { name: "No Lyrics Artist" },
            },
        });
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url.endsWith("/search")) {
                return { data: [] } as any;
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await getLyrics("track-no-lyrics");

        expect(result).toEqual({
            syncedLyrics: null,
            plainLyrics: null,
            source: "none",
            synced: false,
        });
        expect(mockPrisma.trackLyrics.upsert).toHaveBeenCalledWith({
            where: { trackId: "track-no-lyrics" },
            update: {
                syncedLyrics: null,
                plainLyrics: null,
                source: "none",
            },
            create: {
                trackId: "track-no-lyrics",
                syncedLyrics: null,
                plainLyrics: null,
                source: "none",
            },
        });

        const getCalls = mockAxiosGet.mock.calls.filter(([url]) =>
            String(url).endsWith("/get")
        );
        const searchCalls = mockAxiosGet.mock.calls.filter(([url]) =>
            String(url).endsWith("/search")
        );
        expect(getCalls).toHaveLength(0);
        expect(searchCalls).toHaveLength(1);
    });

    it("parses Retry-After array value and honors active LRCLIB backoff", async () => {
        let backoffUntil: string | null = null;
        mockRedisClient.get.mockImplementation(async (key: string) => {
            if (key === "lyrics:lrclib:backoff_until") {
                return backoffUntil;
            }
            return null;
        });
        mockRedisClient.setEx.mockImplementation(async (key: string, _ttl: number, value: string) => {
            if (key === "lyrics:lrclib:backoff_until") {
                backoffUntil = value;
            }
            return "OK";
        });
        mockPrisma.track.findUnique.mockResolvedValue({
            id: "track-backoff-array",
            filePath: null,
            displayTitle: "Retry After Array Song",
            title: "Retry After Array Song",
            duration: 150,
            album: {
                title: "Retry After Array Album",
                artist: { name: "Retry After Array Artist" },
            },
        });
        mockAxiosGet.mockRejectedValue(buildAxiosError(429, { "retry-after": ["12"] }));

        const first = await getLyrics("track-backoff-array");
        expect(first.source).toBe("none");
        expect(mockRedisClient.setEx).toHaveBeenCalledWith(
            "lyrics:lrclib:backoff_until",
            12,
            expect.any(String)
        );

        mockAxiosGet.mockClear();
        const second = await getLyrics("track-backoff-array");

        expect(second).toEqual(first);
        expect(mockAxiosGet).not.toHaveBeenCalled();
        expect(mockPrisma.trackLyrics.upsert).toHaveBeenCalledWith({
            where: { trackId: "track-backoff-array" },
            update: {
                syncedLyrics: null,
                plainLyrics: null,
                source: "none",
            },
            create: {
                trackId: "track-backoff-array",
                syncedLyrics: null,
                plainLyrics: null,
                source: "none",
            },
        });
        mockRedisClient.get.mockResolvedValue(null);
        mockRedisClient.setEx.mockResolvedValue("OK");
    });

    it("parses Retry-After date header into backoff seconds", async () => {
        mockPrisma.track.findUnique.mockResolvedValue({
            id: "track-backoff-date",
            filePath: null,
            displayTitle: "Date Backoff Song",
            title: "Date Backoff Song",
            duration: 180,
            album: {
                title: "Date Backoff Album",
                artist: { name: "Date Backoff Artist" },
            },
        });
        mockAxiosGet.mockRejectedValue(
            buildAxiosError(429, {
                "retry-after": new Date(Date.now() + 15000).toUTCString(),
            })
        );

        const result = await getLyrics("track-backoff-date");

        expect(result.source).toBe("none");
        const backoffCall = mockRedisClient.setEx.mock.calls.find(
            ([key]) => key === "lyrics:lrclib:backoff_until"
        );
        expect(backoffCall).toBeDefined();
        const ttlSeconds = Number(backoffCall?.[1]);
        expect(ttlSeconds).toBeGreaterThanOrEqual(13);
        expect(ttlSeconds).toBeLessThanOrEqual(16);
    });

    it("falls back to default 429 backoff when Retry-After is invalid", async () => {
        mockPrisma.track.findUnique.mockResolvedValue({
            id: "track-backoff-invalid",
            filePath: null,
            displayTitle: "Invalid Backoff Song",
            title: "Invalid Backoff Song",
            duration: 180,
            album: {
                title: "Invalid Backoff Album",
                artist: { name: "Invalid Backoff Artist" },
            },
        });
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url.endsWith("/get")) {
                throw buildAxiosError(429, {
                    "retry-after": "not-a-valid-retry-after",
                } as unknown as Record<string, unknown>);
            }
            if (url.endsWith("/search")) {
                return { data: [] } as any;
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await getLyrics("track-backoff-invalid");

        expect(result).toEqual({
            syncedLyrics: null,
            plainLyrics: null,
            source: "none",
            synced: false,
        });
        expect(mockRedisClient.setEx).toHaveBeenCalledWith(
            "lyrics:lrclib:backoff_until",
            120,
            expect.any(String)
        );
    });

    it("falls back to LRCLIB when external cache data is invalid", async () => {
        const lookupContext = {
            artistName: "Data! Artist",
            trackName: "Data/Track",
            albumName: "Cache Album",
            duration: 200.4,
        };
        mockPrisma.track.findUnique.mockResolvedValue(null);
        mockRedisClient.get.mockResolvedValue("not-json");
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url.endsWith("/search")) {
                return {
                    data: [
                        {
                            id: 500,
                            trackName: "Data/Track",
                            artistName: "Data! Artist",
                            albumName: "Cache Album",
                            duration: 200,
                            instrumental: false,
                            plainLyrics: "Recovered lyric",
                            syncedLyrics: null,
                        },
                    ],
                } as any;
            }
            if (url.endsWith("/get")) {
                return { data: [] } as any;
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await getLyrics("track-invalid-cache", lookupContext);

        expect(result).toEqual({
            syncedLyrics: null,
            plainLyrics: "Recovered lyric",
            source: "lrclib",
            synced: false,
        });
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining("[Lyrics] Failed to read external lyrics cache")
        );
    });

    it("treats malformed external cache records as cache misses and continues", async () => {
        const lookupContext = {
            artistName: "Malformed",
            trackName: "Malformed Cache",
            albumName: "Malformed Album",
            duration: 120,
        };
        mockPrisma.track.findUnique.mockResolvedValue(null);
        mockRedisClient.get.mockResolvedValue(
            JSON.stringify({
                syncedLyrics: "[00:00.00] Cached line",
                plainLyrics: "Cached line",
                source: "lrclib",
            })
        );
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url.endsWith("/search")) {
                return {
                    data: [
                        {
                            id: 800,
                            trackName: "Malformed Cache",
                            artistName: "Malformed",
                            albumName: "Malformed Album",
                            duration: 120,
                            instrumental: false,
                            plainLyrics: "Recovered lyric",
                            syncedLyrics: null,
                        },
                    ],
                } as any;
            }
            if (url.endsWith("/get")) {
                return { data: [] } as any;
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await getLyrics("track-invalid-cache-shape", lookupContext);

        expect(result).toEqual({
            syncedLyrics: null,
            plainLyrics: "Recovered lyric",
            source: "lrclib",
            synced: false,
        });
        expect(mockLogger.warn).not.toHaveBeenCalledWith(
            expect.stringContaining("[Lyrics] Failed to read external lyrics cache")
        );
    });

    it("continues when LRCLIB backoff state read fails", async () => {
        mockRedisClient.get.mockImplementation(async (key: string) => {
            if (key === "lyrics:lrclib:backoff_until") {
                throw new Error("redis unavailable");
            }
            return null;
        });
        mockPrisma.track.findUnique.mockResolvedValue({
            id: "track-backoff-read-failure",
            filePath: null,
            displayTitle: "Backoff Read Failure Song",
            title: "Backoff Read Failure Song",
            duration: 240,
            album: {
                title: "Backoff Read Failure Album",
                artist: { name: "Backoff Read Failure Artist" },
            },
        });
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url.endsWith("/get")) {
                const notFoundError: any = new Error("Not found");
                notFoundError.response = { status: 404 };
                throw notFoundError;
            }
            if (url.endsWith("/search")) {
                return {
                    data: [
                        {
                            id: 901,
                            trackName: "Backoff Read Failure Song",
                            artistName: "Backoff Read Failure Artist",
                            albumName: "Backoff Read Failure Album",
                            duration: 240,
                            instrumental: false,
                            plainLyrics: "Recovered lyric",
                            syncedLyrics: null,
                        },
                    ],
                } as any;
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await getLyrics("track-backoff-read-failure");

        expect(result).toEqual({
            syncedLyrics: null,
            plainLyrics: "Recovered lyric",
            source: "lrclib",
            synced: false,
        });
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining("[Lyrics] Failed to read LRCLIB backoff state")
        );
        expect(mockAxiosGet).toHaveBeenCalledWith(
            expect.stringContaining("/get"),
            expect.anything()
        );
        expect(mockAxiosGet).toHaveBeenCalledWith(
            expect.stringContaining("/search"),
            expect.anything()
        );
    });

    it("continues when LRCLIB backoff write fails", async () => {
        mockRedisClient.get.mockResolvedValue(null);
        mockRedisClient.setEx.mockImplementation(async (key: string) => {
            if (key === "lyrics:lrclib:backoff_until") {
                throw new Error("failed to set");
            }
            return "OK";
        });
        mockPrisma.track.findUnique.mockResolvedValue({
            id: "track-backoff-write-failure",
            filePath: null,
            displayTitle: "Backoff Write Failure Song",
            title: "Backoff Write Failure Song",
            duration: 210,
            album: {
                title: "Backoff Write Failure Album",
                artist: { name: "Backoff Write Failure Artist" },
            },
        });
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url.endsWith("/get")) {
                throw buildAxiosError(429, { "retry-after": "12" });
            }
            if (url.endsWith("/search")) {
                return { data: [] } as any;
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await getLyrics("track-backoff-write-failure");

        expect(result).toEqual({
            syncedLyrics: null,
            plainLyrics: null,
            source: "none",
            synced: false,
        });
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining("[Lyrics] Failed to set LRCLIB backoff state")
        );
        expect(mockPrisma.trackLyrics.upsert).toHaveBeenCalledWith({
            where: { trackId: "track-backoff-write-failure" },
            update: {
                syncedLyrics: null,
                plainLyrics: null,
                source: "none",
            },
            create: {
                trackId: "track-backoff-write-failure",
                syncedLyrics: null,
                plainLyrics: null,
                source: "none",
            },
        });
        mockRedisClient.get.mockResolvedValue(null);
        mockRedisClient.setEx.mockResolvedValue("OK");
    });

    it("does not throw when LRCLIB /get and /search requests both fail", async () => {
        mockPrisma.track.findUnique.mockResolvedValue({
            id: "track-lrclib-failure-path",
            filePath: null,
            displayTitle: "Failure Path Song",
            title: "Failure Path Song",
            duration: 180,
            album: {
                title: "Failure Path Album",
                artist: { name: "Failure Path Artist" },
            },
        });
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url.endsWith("/get")) {
                const serverError: any = new Error("request failure");
                serverError.response = { status: 500 };
                throw serverError;
            }
            if (url.endsWith("/search")) {
                throw new Error("search failure");
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await getLyrics("track-lrclib-failure-path");

        expect(result).toEqual({
            syncedLyrics: null,
            plainLyrics: null,
            source: "none",
            synced: false,
        });
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining("[Lyrics] LRCLIB request failed for")
        );
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining("[Lyrics] LRCLIB search failed for")
        );
    });

    it("returns no lyrics when external lookup context is incomplete", async () => {
        const lookupContext = {
            albumName: "Only Album",
            duration: 123.4,
        };
        mockPrisma.track.findUnique.mockResolvedValue(null);
        mockRedisClient.get.mockResolvedValue(null);

        const result = await getLyrics("track-incomplete-external", lookupContext);

        expect(result).toEqual({
            syncedLyrics: null,
            plainLyrics: null,
            source: "none",
            synced: false,
        });
        expect(mockRedisClient.get).not.toHaveBeenCalled();
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it("falls back to LRCLIB search when embedded lyrics are missing", async () => {
        mockPrisma.track.findUnique.mockResolvedValue({
            id: "track-embedded-empty",
            filePath: "/music/empty.mp3",
            displayTitle: "Empty Embedded",
            title: "Empty Embedded",
            duration: null,
            album: {
                title: "Empty Album",
                artist: { name: "Empty Artist" },
            },
        });
        mockFsExistsSync.mockReturnValue(true);
        mockParseFile.mockResolvedValue({
            common: {
                lyrics: [],
            },
        } as any);
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url.endsWith("/search")) {
                return {
                    data: [
                        {
                            id: 700,
                            trackName: "Empty Embedded",
                            artistName: "Empty Artist",
                            albumName: "Empty Album",
                            duration: 0,
                            instrumental: false,
                            plainLyrics: "Recovered lyric",
                            syncedLyrics: null,
                        },
                    ],
                } as any;
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await getLyrics("track-embedded-empty");

        expect(mockParseFile).toHaveBeenCalledWith(
            "/music/empty.mp3",
            expect.objectContaining({
                duration: false,
                skipCovers: true,
            })
        );
        expect(mockAxiosGet).toHaveBeenCalledWith(
            expect.stringContaining("/search"),
            expect.anything()
        );
        expect(mockAxiosGet).not.toHaveBeenCalledWith(
            expect.stringContaining("/get"),
            expect.anything()
        );
        expect(result).toEqual({
            syncedLyrics: null,
            plainLyrics: "Recovered lyric",
            source: "lrclib",
            synced: false,
        });
        expect(mockPrisma.trackLyrics.upsert).toHaveBeenCalledWith({
            where: { trackId: "track-embedded-empty" },
            update: {
                syncedLyrics: null,
                plainLyrics: "Recovered lyric",
                source: "lrclib",
            },
            create: {
                trackId: "track-embedded-empty",
                syncedLyrics: null,
                plainLyrics: "Recovered lyric",
                source: "lrclib",
            },
        });
    });

    it("applies 5xx LRCLIB backoff and still caches no lyrics", async () => {
        mockPrisma.track.findUnique.mockResolvedValue({
            id: "track-lrclib-5xx",
            filePath: null,
            displayTitle: "5xx Song",
            title: "5xx Song",
            duration: 180,
            album: {
                title: "5xx Album",
                artist: { name: "5xx Artist" },
            },
        });
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url.endsWith("/get")) {
                const serverError: any = new Error("server error");
                serverError.response = { status: 500 };
                throw serverError;
            }
            if (url.endsWith("/search")) {
                return { data: [] } as any;
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await getLyrics("track-lrclib-5xx");

        expect(result).toEqual({
            syncedLyrics: null,
            plainLyrics: null,
            source: "none",
            synced: false,
        });
        expect(mockRedisClient.setEx).toHaveBeenCalledWith(
            "lyrics:lrclib:backoff_until",
            30,
            expect.any(String)
        );
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining("LRCLIB request failed for \"5xx Song\" by \"5xx Artist\"")
        );
    });

    it("uses partial LRCLIB search scoring for artist, track, and album matches", async () => {
        const lookupContext = {
            artistName: "The Bright",
            trackName: "Lonely",
            albumName: "Acoustic",
        };
        mockPrisma.track.findUnique.mockResolvedValue(null);
        mockRedisClient.get.mockResolvedValue(null);
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url.endsWith("/search")) {
                return {
                    data: [
                        {
                            id: 501,
                            trackName: "Lonely Again",
                            artistName: "Bright",
                            albumName: "Acoustic Sessions",
                            duration: 0,
                            instrumental: false,
                            plainLyrics: "Scored lyric",
                            syncedLyrics: null,
                        },
                    ],
                } as any;
            }
            if (url.endsWith("/get")) {
                return { data: [] } as any;
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await getLyrics("track-search-scoring", lookupContext);

        expect(result).toEqual({
            syncedLyrics: null,
            plainLyrics: "Scored lyric",
            source: "lrclib",
            synced: false,
        });
        const getCalls = mockAxiosGet.mock.calls.filter(([url]) =>
            String(url).endsWith("/get")
        );
        const searchCalls = mockAxiosGet.mock.calls.filter(([url]) =>
            String(url).endsWith("/search")
        );
        expect(getCalls).toHaveLength(0);
        expect(searchCalls).toHaveLength(1);
    });

    it("uses default LRCLIB backoff duration when Retry-After is missing and skips follow-up requests", async () => {
        let backoffUntil: string | null = null;
        mockRedisClient.get.mockImplementation(async (key: string) => {
            if (key === "lyrics:lrclib:backoff_until") {
                return backoffUntil;
            }
            return null;
        });
        mockRedisClient.setEx.mockImplementation(async (key: string, ttl: number, value: string) => {
            if (key === "lyrics:lrclib:backoff_until") {
                backoffUntil = value;
            }
            return "OK";
        });
        mockPrisma.track.findUnique.mockResolvedValue({
            id: "track-backoff-default",
            filePath: null,
            displayTitle: "No Retry Header",
            title: "No Retry Header",
            duration: null,
            album: {
                title: "No Retry Album",
                artist: { name: "No Retry Artist" },
            },
        });
        mockAxiosGet.mockRejectedValue(buildAxiosError(429));

        const first = await getLyrics("track-backoff-default");
        const setBackoffCall = mockRedisClient.setEx.mock.calls.find(
            ([key]) => key === "lyrics:lrclib:backoff_until"
        );
        expect(setBackoffCall?.[1]).toBe(120);
        expect(first).toEqual({
            syncedLyrics: null,
            plainLyrics: null,
            source: "none",
            synced: false,
        });

        mockAxiosGet.mockClear();
        const second = await getLyrics("track-backoff-default");

        expect(second).toEqual(first);
        expect(mockAxiosGet).not.toHaveBeenCalled();
        mockRedisClient.get.mockResolvedValue(null);
        mockRedisClient.setEx.mockResolvedValue("OK");
    });

    it("falls back to LRCLIB search when local file path no longer exists", async () => {
        mockPrisma.track.findUnique.mockResolvedValue({
            id: "track-missing-file",
            filePath: "/music/missing.mp3",
            displayTitle: "Missing File",
            title: "Missing File",
            duration: null,
            album: {
                title: "Missing Album",
                artist: { name: "Missing Artist" },
            },
        });
        mockFsExistsSync.mockReturnValue(false);
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url.endsWith("/search")) {
                return {
                    data: [
                        {
                            id: 600,
                            trackName: "Missing File",
                            artistName: "Missing Artist",
                            albumName: "Missing Album",
                            duration: 0,
                            instrumental: false,
                            plainLyrics: "Search lyric",
                            syncedLyrics: null,
                        },
                    ],
                } as any;
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await getLyrics("track-missing-file");

        expect(result).toEqual({
            syncedLyrics: null,
            plainLyrics: "Search lyric",
            source: "lrclib",
            synced: false,
        });
        expect(mockParseFile).not.toHaveBeenCalled();
        expect(mockAxiosGet).toHaveBeenCalledWith(
            expect.stringContaining("/search"),
            expect.anything()
        );
        expect(mockAxiosGet).not.toHaveBeenCalledWith(
            expect.stringContaining("/get"),
            expect.anything()
        );
    });

    it("clears cached lyrics entries for a track", async () => {
        await clearLyricsCache("track-clear-cache");

        expect(mockPrisma.trackLyrics.deleteMany).toHaveBeenCalledWith({
            where: { trackId: "track-clear-cache" },
        });
    });
});
