import path from "path";
import type { SearchResult, SearchTrackResult, TrackMatch } from "../soulseek";

const mockSlskConnect = jest.fn();
const mockGetSystemSettings = jest.fn();
const mockSessionLog = jest.fn();
const mockFsExistsSync = jest.fn();
const mockFsStatSync = jest.fn();
const mockFsUnlinkSync = jest.fn();
const mockMkdir = jest.fn();

jest.mock("slsk-client", () => ({
    __esModule: true,
    default: {
        connect: (...args: unknown[]) => mockSlskConnect(...args),
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: (...args: unknown[]) => mockGetSystemSettings(...args),
}));

jest.mock("../../utils/playlistLogger", () => ({
    sessionLog: (...args: unknown[]) => mockSessionLog(...args),
}));

jest.mock("fs", () => ({
    __esModule: true,
    default: {
        existsSync: (...args: unknown[]) => mockFsExistsSync(...args),
        statSync: (...args: unknown[]) => mockFsStatSync(...args),
        unlinkSync: (...args: unknown[]) => mockFsUnlinkSync(...args),
    },
    existsSync: (...args: unknown[]) => mockFsExistsSync(...args),
    statSync: (...args: unknown[]) => mockFsStatSync(...args),
    unlinkSync: (...args: unknown[]) => mockFsUnlinkSync(...args),
}));

jest.mock("fs/promises", () => ({
    mkdir: (...args: unknown[]) => mockMkdir(...args),
}));

jest.mock("p-queue", () => ({
    __esModule: true,
    default: class MockPQueue {
        add<T>(task: () => Promise<T>): Promise<T> {
            return task();
        }
    },
}));

const setIntervalSpy = jest
    .spyOn(global, "setInterval")
    .mockImplementation((() => 0 as unknown as NodeJS.Timeout) as any);

const { soulseekService } = require("../soulseek") as typeof import("../soulseek");

const ONE_MB = 1024 * 1024;

function makeSearchResult(
    overrides: Partial<SearchResult> = {}
): SearchResult {
    return {
        user: "user-1",
        file: "/music/Artist - Track.mp3",
        size: 6 * ONE_MB,
        slots: true,
        bitrate: 320,
        speed: 600_000,
        ...overrides,
    };
}

function makeTrackMatch(overrides: Partial<TrackMatch> = {}): TrackMatch {
    return {
        username: "user-1",
        filename: "Track.mp3",
        fullPath: "/remote/Track.mp3",
        size: 6 * ONE_MB,
        bitRate: 320,
        quality: "MP3 320",
        score: 100,
        ...overrides,
    };
}

function resetServiceState(): void {
    const service = soulseekService as any;
    service.client = null;
    service.connecting = false;
    service.connectPromise = null;
    service.lastConnectAttempt = 0;
    service.lastFailedAttempt = 0;
    service.failedUsers = new Map<
        string,
        { failures: number; lastFailure: Date }
    >();
    service.activeDownloads = 0;
    service.maxConcurrentDownloads = 0;
    service.connectedAt = null;
    service.lastSuccessfulSearch = null;
    service.consecutiveEmptySearches = 0;
    service.totalSearches = 0;
    service.totalSuccessfulSearches = 0;
}

let allowSlskConnectCalls = false;

describe("soulseek service", () => {
    afterAll(() => {
        setIntervalSpy.mockRestore();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
        allowSlskConnectCalls = false;
        resetServiceState();
        mockGetSystemSettings.mockResolvedValue({
            soulseekUsername: "test-user",
            soulseekPassword: "test-pass",
        });
        mockMkdir.mockResolvedValue(undefined);
        mockFsExistsSync.mockReturnValue(true);
        mockFsStatSync.mockReturnValue({ size: 2048 });
        mockFsUnlinkSync.mockImplementation(() => undefined);
    });

    afterEach(() => {
        if (!allowSlskConnectCalls) {
            expect(mockSlskConnect).not.toHaveBeenCalled();
        }
        allowSlskConnectCalls = false;
    });

    it("returns availability based on configured credentials", async () => {
        await expect(soulseekService.isAvailable()).resolves.toBe(true);

        mockGetSystemSettings.mockResolvedValueOnce({
            soulseekUsername: "test-user",
            soulseekPassword: "",
        });
        await expect(soulseekService.isAvailable()).resolves.toBe(false);

        mockGetSystemSettings.mockRejectedValueOnce(new Error("db error"));
        await expect(soulseekService.isAvailable()).resolves.toBe(false);
    });

    it("reports status with connection and username", async () => {
        const service = soulseekService as any;
        service.client = { search: jest.fn(), download: jest.fn() };
        mockGetSystemSettings.mockResolvedValue({
            soulseekUsername: "alice",
            soulseekPassword: "secret",
        });

        await expect(soulseekService.getStatus()).resolves.toEqual({
            connected: true,
            username: "alice",
        });
    });

    describe("connect and ensureConnected", () => {
        it("connect throws validation error when soulseek credentials are missing", async () => {
            const service = soulseekService as any;
            allowSlskConnectCalls = true;
            mockGetSystemSettings.mockResolvedValueOnce({
                soulseekUsername: "",
                soulseekPassword: "",
            });

            await expect(soulseekService.connect()).rejects.toThrow(
                "Soulseek credentials not configured"
            );
            expect(service.client).toBeNull();
        });

        it("connect initializes client state on successful login", async () => {
            allowSlskConnectCalls = true;
            const service = soulseekService as any;
            const clientOnSpy = jest.fn();
            const connectClient = { on: clientOnSpy };

            mockSlskConnect.mockImplementation(
                (
                    _options: unknown,
                    cb: (err: Error | null, client: unknown) => void
                ) => cb(null, connectClient as unknown as never)
            );

            await expect(soulseekService.connect()).resolves.toBeUndefined();
            expect(service.client).toBe(connectClient);
            expect(service.connectedAt).toBeInstanceOf(Date);
            expect(service.consecutiveEmptySearches).toBe(0);
            expect(clientOnSpy).toHaveBeenCalledWith(
                "error",
                expect.any(Function)
            );
        });

        it("connect forwards slsk client errors", async () => {
            allowSlskConnectCalls = true;
            const service = soulseekService as any;

            mockSlskConnect.mockImplementation(
                (
                    _options: unknown,
                    cb: (err: Error | null, client: unknown) => void
                ) => cb(new Error("connection refused"), null as unknown as never)
            );

            await expect(soulseekService.connect()).rejects.toThrow(
                "connection refused"
            );
            expect(service.client).toBeNull();
        });

        it("ensureConnected returns without reconnecting when already connected", async () => {
            const service = soulseekService as any;
            const connectSpy = jest
                .spyOn(service, "connect")
                .mockResolvedValue(undefined);
            service.client = { search: jest.fn(), download: jest.fn() };

            await expect(service.ensureConnected()).resolves.toBeUndefined();
            expect(connectSpy).not.toHaveBeenCalled();
        });

        it("ensureConnected refreshes a forced reconnect when requested", async () => {
            const service = soulseekService as any;
            const connectSpy = jest
                .spyOn(service, "connect")
                .mockResolvedValue(undefined);
            service.client = { search: jest.fn(), download: jest.fn() };

            await expect(service.ensureConnected(true)).resolves.toBeUndefined();
            expect(connectSpy).toHaveBeenCalledTimes(1);
        });

        it("ensureConnected enforces cooldown after recent connection attempts", async () => {
            const service = soulseekService as any;

            service.lastConnectAttempt = Date.now();
            await expect(service.ensureConnected()).rejects.toThrow(
                "Connection cooldown - please wait before retrying"
            );

            service.lastConnectAttempt = 0;
            service.lastFailedAttempt = Date.now();
            await expect(service.ensureConnected()).rejects.toThrow(
                "Connection recently failed - please wait before retrying"
            );
        });

        it("returns the in-flight connection promise when a connection is already starting", async () => {
            const service = soulseekService as any;
            const connectSpy = jest
                .spyOn(service, "connect")
                .mockResolvedValue(undefined);
            const connectPromise = Promise.resolve();

            service.connecting = true;
            service.connectPromise = connectPromise;
            service.client = null;

            await expect(service.ensureConnected()).resolves.toBeUndefined();

            expect(connectSpy).not.toHaveBeenCalled();
        });

        it("force disconnect resets connection state and logs uptime", () => {
            const service = soulseekService as any;
            service.client = { search: jest.fn(), download: jest.fn() };
            service.connectedAt = new Date(Date.now() - 1_250);

            (soulseekService as any).forceDisconnect();

            expect(service.client).toBeNull();
            expect(service.lastConnectAttempt).toBe(0);
            expect(mockSessionLog).toHaveBeenCalledWith(
                "SOULSEEK",
                expect.stringContaining("Force disconnecting"),
                "WARN"
            );
        });
    });

    it("registers a periodic failed-user cleanup interval and runs cleanup callback", () => {
        let cleanupCallback: (() => void) | undefined;
        const setIntervalSpy = jest
            .spyOn(global, "setInterval")
            .mockImplementation((callback: any, _intervalMs?: number) => {
                if (typeof callback === "function") {
                    cleanupCallback = callback as () => void;
                }
                return 0 as unknown as NodeJS.Timeout;
            }) as any;

        jest.resetModules();

        const {
            soulseekService: reloadedSoulseekService,
        } = require("../soulseek") as typeof import("../soulseek");
        const service = reloadedSoulseekService as any;

        expect(setIntervalSpy).toHaveBeenCalledWith(
            expect.any(Function),
            5 * 60 * 1000
        );

        service.failedUsers.set("stale-user", {
            failures: 1,
            lastFailure: new Date(Date.now() - 600_000),
        });
        service.failedUsers.set("active-user", {
            failures: 1,
            lastFailure: new Date(),
        });

        expect(cleanupCallback).toBeDefined();
        cleanupCallback?.();

        expect(service.failedUsers.has("stale-user")).toBe(false);
        expect(service.failedUsers.has("active-user")).toBe(true);
        expect(mockSessionLog).toHaveBeenCalledWith(
            "SOULSEEK",
            "Cleaned up 1 expired user failure records"
        );

        setIntervalSpy.mockRestore();
    });

    it("disconnect clears client and logs state", () => {
        const service = soulseekService as any;
        service.client = { search: jest.fn(), download: jest.fn() };

        soulseekService.disconnect();

        expect(service.client).toBeNull();
        expect(mockSessionLog).toHaveBeenCalledWith("SOULSEEK", "Disconnected");
    });

    it("normalizes track titles and keeps original when normalization removes too much", () => {
        const normalized = (soulseekService as any).normalizeTrackTitle(
            "Santa Claus Is Comin' to Town (Live at C.W. Post College, NY - Dec 1975)"
        );
        expect(normalized).toBe("Santa Claus Is Comin' to Town");

        const bracketNormalized = (soulseekService as any).normalizeTrackTitle(
            "Song / Name [Radio Edit]"
        );
        expect(bracketNormalized).toBe("Song Name");

        const fallback = (soulseekService as any).normalizeTrackTitle("(Live)");
        expect(fallback).toBe("(Live)");
    });

    it.each([
        ["User not exist", "user_offline", true],
        ["Download timed out", "timeout", true],
        ["Connection refused by peer", "connection", true],
        ["No such file", "file_not_found", true],
        ["Unexpected failure", "unknown", false],
    ])(
        "categorizes '%s' errors",
        (message, expectedType, expectedSkipUser) => {
            const categorized = (soulseekService as any).categorizeError(
                new Error(message)
            );
            expect(categorized).toEqual({
                type: expectedType,
                skipUser: expectedSkipUser,
            });
        }
    );

    it("ranks results, filters blocked users, and removes low-score entries", () => {
        const service = soulseekService as any;
        service.failedUsers.set("blocked-user", {
            failures: 3,
            lastFailure: new Date(),
        });

        const ranked = service.rankAllResults(
            [
                makeSearchResult({
                    user: "blocked-user",
                    file: "/music/The Artist - Great Song.flac",
                    size: 20 * ONE_MB,
                    speed: 2_000_000,
                }),
                makeSearchResult({
                    user: "fast-user",
                    file: "/music/The Artist - Great Song.flac",
                    size: 20 * ONE_MB,
                    speed: 2_000_000,
                }),
                makeSearchResult({
                    user: "slow-user",
                    file: "/music/The Artist - Great Song.mp3",
                    bitrate: 320,
                    size: 6 * ONE_MB,
                    speed: 600_000,
                }),
                makeSearchResult({
                    user: "noise-user",
                    file: "/music/random.mp3",
                    bitrate: 128,
                    size: ONE_MB,
                    slots: false,
                    speed: 10_000,
                }),
            ],
            "The Artist",
            "01 - Great Song"
        ) as TrackMatch[];

        expect(ranked).toHaveLength(2);
        expect(ranked.map((match) => match.username)).toEqual([
            "fast-user",
            "slow-user",
        ]);
        expect(ranked.every((match) => match.score >= 20)).toBe(true);
    });

    it.each([
        ["track.flac", 0, "FLAC"],
        ["track.wav", 0, "WAV"],
        ["track.mp3", 320, "MP3 320"],
        ["track.mp3", 256, "MP3 256"],
        ["track.mp3", 192, "MP3 192"],
        ["track.mp3", 128, "MP3"],
        ["track.m4a", 0, "AAC"],
        ["track.aac", 0, "AAC"],
        ["track.ogg", 0, "OGG"],
        ["track.opus", 0, "OPUS"],
        ["track.FLAC", 0, "FLAC"],
        ["track.bin", 0, "Unknown"],
    ])(
        "returns quality %s for bitrate %s",
        (filename, bitrate, expectedQuality) => {
            expect(
                (soulseekService as any).getQualityFromFilename(
                    filename,
                    bitrate || undefined
                )
            ).toBe(expectedQuality);
        }
    );

    it("searchTrack returns ranked matches on successful callback results", async () => {
        const search = jest.fn(
            (
                _opts: { req: string; timeout: number },
                cb: (err: Error | null, results: SearchResult[]) => void
            ) => {
                cb(null, [
                    makeSearchResult({
                        user: "best-user",
                        file: "/music/The Artist - The Song.flac",
                        size: 20 * ONE_MB,
                        speed: 2_000_000,
                    }),
                    makeSearchResult({
                        user: "good-user",
                        file: "/music/The Artist - The Song.mp3",
                        size: 6 * ONE_MB,
                        speed: 600_000,
                        bitrate: 320,
                    }),
                    makeSearchResult({
                        user: "text-user",
                        file: "/music/not-a-track.txt",
                    }),
                ]);
            }
        );

        jest.spyOn(soulseekService as any, "ensureConnected").mockResolvedValue(
            undefined
        );
        (soulseekService as any).client = { search, download: jest.fn() };

        const result = await soulseekService.searchTrack("The Artist", "The Song");

        expect(search).toHaveBeenCalledWith(
            { req: "The Artist The Song", timeout: 45000 },
            expect.any(Function)
        );
        expect(result.found).toBe(true);
        expect(result.bestMatch?.username).toBe("best-user");
        expect(result.allMatches.map((match) => match.username)).toEqual([
            "best-user",
            "good-user",
        ]);
    });

    it("searchTrack returns no match on empty callback results", async () => {
        const search = jest.fn(
            (
                _opts: { req: string; timeout: number },
                cb: (err: Error | null, results: SearchResult[]) => void
            ) => {
                cb(null, []);
            }
        );

        jest.spyOn(soulseekService as any, "ensureConnected").mockResolvedValue(
            undefined
        );
        (soulseekService as any).client = { search, download: jest.fn() };

        await expect(
            soulseekService.searchTrack("Artist", "Missing Song")
        ).resolves.toEqual({
            found: false,
            bestMatch: null,
            allMatches: [],
        });
    });

    it("searchTrack returns no match on callback error", async () => {
        const search = jest.fn(
            (
                _opts: { req: string; timeout: number },
                cb: (err: Error | null, results: SearchResult[]) => void
            ) => {
                cb(new Error("Timed out"), []);
            }
        );

        jest.spyOn(soulseekService as any, "ensureConnected").mockResolvedValue(
            undefined
        );
        (soulseekService as any).client = { search, download: jest.fn() };

        await expect(soulseekService.searchTrack("Artist", "Any Song")).resolves.toEqual(
            {
                found: false,
                bestMatch: null,
                allMatches: [],
            }
        );
    });

    it("searchTrack handles synchronous search API failures", async () => {
        const service = soulseekService as any;
        jest.spyOn(service, "ensureConnected").mockResolvedValueOnce(
            undefined
        );
        service.client = {
            search: jest.fn(() => {
                throw new Error("Search API sync failure");
            }),
            download: jest.fn(),
        };

        await expect(soulseekService.searchTrack("Artist", "Any Song")).resolves.toEqual(
            {
                found: false,
                bestMatch: null,
                allMatches: [],
            }
        );
    });

    it("searchTrack ignores non-audio results", async () => {
        const search = jest.fn(
            (
                _opts: { req: string; timeout: number },
                cb: (err: Error | null, results: SearchResult[]) => void
            ) => {
                cb(null, [
                    makeSearchResult({
                        user: "bad-user",
                        file: "/music/not-a-track.txt",
                        size: ONE_MB,
                        slots: true,
                        bitrate: 320,
                        speed: 100_000,
                    }),
                ]);
            }
        );

        jest.spyOn(soulseekService as any, "ensureConnected").mockResolvedValue(
            undefined
        );
        (soulseekService as any).client = { search, download: jest.fn() };

        await expect(soulseekService.searchTrack("Artist", "Song")).resolves.toEqual(
            {
                found: false,
                bestMatch: null,
                allMatches: [],
            }
        );
    });

    it("searchTrack drops low-scoring ranked matches", async () => {
        const search = jest.fn(
            (
                _opts: { req: string; timeout: number },
                cb: (err: Error | null, results: SearchResult[]) => void
            ) => {
                cb(null, [
                    makeSearchResult({
                        user: "low-score",
                        file: "/music/random-song.mp3",
                        bitrate: 128,
                        slots: false,
                        speed: 0,
                        size: 100,
                    }),
                ]);
            }
        );

        jest.spyOn(soulseekService as any, "ensureConnected").mockResolvedValue(
            undefined
        );
        (soulseekService as any).client = { search, download: jest.fn() };

        await expect(soulseekService.searchTrack("Completely", "Different")).resolves.toEqual(
            {
                found: false,
                bestMatch: null,
                allMatches: [],
            }
        );
    });

    it("searchTrack treats null results as no matches", async () => {
        jest
            .spyOn(soulseekService as any, "ensureConnected")
            .mockResolvedValue(undefined);
        (soulseekService as any).client = {
            search: jest.fn(
                (
                _opts: { req: string; timeout: number },
                cb: (err: Error | null, results: SearchResult[]) => void
            ) => {
                    cb(null, (null as unknown) as SearchResult[]);
            }
        ),
            download: jest.fn(),
        };

        await expect(soulseekService.searchTrack("Artist", "Song")).resolves.toEqual({
            found: false,
            bestMatch: null,
            allMatches: [],
        });
    });

    it("searchTrack retries when empty results exceed the consecutive-empty threshold", async () => {
        const service = soulseekService as any;
        const search = jest
            .fn()
            .mockImplementationOnce(
                (
                    _opts: { req: string; timeout: number },
                    cb: (err: Error | null, results: SearchResult[]) => void
                ) => cb(null, [])
            )
            .mockImplementationOnce(
                (
                    _opts: { req: string; timeout: number },
                    cb: (err: Error | null, results: SearchResult[]) => void
                ) => {
                    cb(null, [
                        makeSearchResult({
                            user: "retry-user",
                            file: "/music/The Artist - The Song.mp3",
                            size: 6 * ONE_MB,
                            bitrate: 320,
                            speed: 600_000,
                            slots: true,
                        }),
                    ]);
                }
            );

        jest.spyOn(service, "ensureConnected").mockImplementation(async () => {
            if (!service.client) {
                service.client = { search, download: jest.fn() };
            }
        });
        service.client = { search, download: jest.fn() };
        service.consecutiveEmptySearches = 2;

        const result = await soulseekService.searchTrack("The Artist", "The Song");

        expect(search).toHaveBeenCalledTimes(2);
        expect(result.found).toBe(true);
        expect(result.bestMatch?.username).toBe("retry-user");
    });

    it("searchTrack retries after repeated search errors", async () => {
        const service = soulseekService as any;
        const search = jest
            .fn()
            .mockImplementationOnce(
                (
                    _opts: { req: string; timeout: number },
                    cb: (err: Error | null, results: SearchResult[]) => void
                ) => cb(new Error("Timed out"), [])
            )
            .mockImplementationOnce(
                (
                    _opts: { req: string; timeout: number },
                    cb: (err: Error | null, results: SearchResult[]) => void
                ) =>
                    cb(null, [
                        makeSearchResult({
                            user: "retry-user",
                            file: "/music/The Artist - The Song.mp3",
                            size: 6 * ONE_MB,
                            bitrate: 320,
                            speed: 600_000,
                            slots: true,
                        }),
                    ])
            );

        jest.spyOn(service, "ensureConnected").mockImplementation(async () => {
            if (!service.client) {
                service.client = { search, download: jest.fn() };
            }
        });
        service.client = { search, download: jest.fn() };
        service.consecutiveEmptySearches = 2;

        const result = await soulseekService.searchTrack(
            "The Artist",
            "The Song"
        );

        expect(search).toHaveBeenCalledTimes(2);
        expect(result.found).toBe(true);
        expect(result.bestMatch?.username).toBe("retry-user");
    });

    it("downloadBestMatch retries next candidates until one succeeds", async () => {
        const first = makeTrackMatch({
            username: "first-user",
            filename: "Bad?.mp3",
            fullPath: "/remote/Bad?.mp3",
        });
        const second = makeTrackMatch({
            username: "second-user",
            filename: "Good*.flac",
            fullPath: "/remote/Good*.flac",
            quality: "FLAC",
        });

        const downloadTrackSpy = jest
            .spyOn(soulseekService, "downloadTrack")
            .mockResolvedValueOnce({ success: false, error: "timeout" })
            .mockResolvedValueOnce({ success: true });

        const result = await soulseekService.downloadBestMatch(
            "Artist/One",
            "Track",
            "Album:One",
            [first, second],
            "/library"
        );

        expect(downloadTrackSpy).toHaveBeenCalledTimes(2);
        expect(downloadTrackSpy).toHaveBeenNthCalledWith(
            1,
            first,
            path.join("/library", "Singles", "Artist_One", "Album_One", "Bad_.mp3")
        );
        expect(downloadTrackSpy).toHaveBeenNthCalledWith(
            2,
            second,
            path.join(
                "/library",
                "Singles",
                "Artist_One",
                "Album_One",
                "Good_.flac"
            )
        );
        expect(result).toEqual({
            success: true,
            filePath: path.join(
                "/library",
                "Singles",
                "Artist_One",
                "Album_One",
                "Good_.flac"
            ),
        });
    });

    it("downloadBestMatch fails fast when no matches are provided", async () => {
        await expect(
            soulseekService.downloadBestMatch(
                "Artist",
                "Track",
                "Album",
                [],
                "/library"
            )
        ).resolves.toEqual({
            success: false,
            error: "No matches provided",
        });
    });

    it("searchAndDownloadBatch retries per-track and returns mixed outcomes", async () => {
        const first = makeTrackMatch({
            username: "first-user",
            filename: "Retry?.flac",
            fullPath: "/remote/Retry?.flac",
            quality: "FLAC",
        });
        const second = makeTrackMatch({
            username: "second-user",
            filename: "Recovered*.flac",
            fullPath: "/remote/Recovered*.flac",
            quality: "FLAC",
        });

        const searchTrackSpy = jest
            .spyOn(soulseekService, "searchTrack")
            .mockImplementation(
                async (
                    artistName: string,
                    trackTitle: string
                ): Promise<SearchTrackResult> => {
                    if (artistName === "Artist/One" && trackTitle === "Retry Track") {
                        return {
                            found: true,
                            bestMatch: first,
                            allMatches: [first, second],
                        };
                    }
                    return {
                        found: false,
                        bestMatch: null,
                        allMatches: [],
                    };
                }
            );

        const downloadTrackSpy = jest
            .spyOn(soulseekService, "downloadTrack")
            .mockResolvedValueOnce({ success: false, error: "timeout" })
            .mockResolvedValueOnce({ success: true });

        const result = await soulseekService.searchAndDownloadBatch(
            [
                { artist: "Artist/One", title: "Retry Track", album: "Album:One" },
                { artist: "Artist Two", title: "Missing Track", album: "Album Two" },
            ],
            "/music",
            1
        );

        expect(searchTrackSpy).toHaveBeenCalledTimes(2);
        expect(downloadTrackSpy).toHaveBeenCalledTimes(2);
        expect(downloadTrackSpy.mock.calls[0][2]).toBe(0);
        expect(downloadTrackSpy.mock.calls[1][2]).toBe(1);
        expect(result).toEqual({
            successful: 1,
            failed: 1,
            files: [
                path.join(
                    "/music",
                    "Singles",
                    "Artist_One",
                    "Album_One",
                    "Recovered_.flac"
                ),
            ],
            errors: ["Artist Two - Missing Track: No match found on Soulseek"],
        });
    });

    it("searchAndDownloadBatch aggregates all attempts for a track before reporting failure", async () => {
        const primary = makeTrackMatch({
            username: "batch-primary",
            filename: "batch-primary.flac",
            fullPath: "/remote/batch-primary.flac",
            quality: "FLAC",
        });
        const fallback = makeTrackMatch({
            username: "batch-fallback",
            filename: "batch-fallback.flac",
            fullPath: "/remote/batch-fallback.flac",
            quality: "FLAC",
        });

        jest.spyOn(soulseekService, "searchTrack").mockResolvedValue({
            found: true,
            bestMatch: primary,
            allMatches: [primary, fallback],
        });

        jest
            .spyOn(soulseekService, "downloadTrack")
            .mockResolvedValueOnce({ success: false, error: "timeout" })
            .mockResolvedValueOnce({ success: false, error: "user offline" });

        const result = await soulseekService.searchAndDownloadBatch(
            [{ artist: "Artist", title: "Track", album: "Album" }],
            "/music",
            1
        );

        expect(result).toEqual({
            successful: 0,
            failed: 1,
            files: [],
            errors: [
                "Artist - Track: batch-primary: timeout; batch-fallback: user offline",
            ],
        });
    });

    it("searchAndDownloadBatch counts no-match failures and download failures together", async () => {
        const match = makeTrackMatch({
            username: "batch-user",
            filename: "ok.flac",
            fullPath: "/remote/ok.flac",
            quality: "FLAC",
        });

        jest
            .spyOn(soulseekService, "searchTrack")
            .mockResolvedValueOnce({
                found: false,
                bestMatch: null,
                allMatches: [],
            })
            .mockResolvedValueOnce({
                found: true,
                bestMatch: match,
                allMatches: [match],
            });

        jest
            .spyOn(soulseekService, "downloadTrack")
            .mockResolvedValue({ success: false, error: "timeout" });

        const result = await soulseekService.searchAndDownloadBatch(
            [
                { artist: "Ghost Artist", title: "Missing", album: "Ghost Album" },
                { artist: "Fallback Artist", title: "Slow Song", album: "Fallback Album" },
            ],
            "/music",
            1
        );

        expect(result).toEqual({
            successful: 0,
            failed: 2,
            files: [],
            errors: [
                "Ghost Artist - Missing: No match found on Soulseek",
                "Fallback Artist - Slow Song: batch-user: timeout",
            ],
        });
    });

    it("searchAndDownload returns no match when search returns nothing", async () => {
        jest
            .spyOn(soulseekService, "searchTrack")
            .mockResolvedValueOnce({
                found: false,
                bestMatch: null,
                allMatches: [],
            });

        await expect(
            soulseekService.searchAndDownload(
                "Artist",
                "Track",
                "Album",
                "/music"
            )
        ).resolves.toEqual({
            success: false,
            error: "No suitable match found",
        });
    });

    it("searchAndDownload aggregates all failed attempt errors", async () => {
        const primary = makeTrackMatch({
            username: "primary-user",
            filename: "primary.flac",
            fullPath: "/remote/primary.flac",
        });
        const fallback = makeTrackMatch({
            username: "fallback-user",
            filename: "fallback.flac",
            fullPath: "/remote/fallback.flac",
        });

        jest.spyOn(soulseekService, "searchTrack").mockResolvedValue({
            found: true,
            bestMatch: primary,
            allMatches: [primary, fallback],
        });
        const downloadTrackSpy = jest
            .spyOn(soulseekService, "downloadTrack")
            .mockResolvedValueOnce({ success: false, error: "timeout" })
            .mockResolvedValueOnce({ success: false, error: "user offline" });

        const result = await soulseekService.searchAndDownload(
            "Edge Artist",
            "Edge Song",
            "Edge Album",
            "/music"
        );

        expect(downloadTrackSpy).toHaveBeenCalledTimes(2);
        expect(result).toEqual({
            success: false,
            error: "All 2 attempts failed: primary-user: timeout; fallback-user: user offline",
        });
    });

    it("searchAndDownload retries secondary matches and succeeds on later attempt", async () => {
        const first = makeTrackMatch({
            username: "first-user",
            filename: "Retry?.flac",
            fullPath: "/remote/Retry?.flac",
            quality: "FLAC",
        });
        const second = makeTrackMatch({
            username: "second-user",
            filename: "Recovered*.flac",
            fullPath: "/remote/Recovered*.flac",
            quality: "FLAC",
        });

        jest.spyOn(soulseekService, "searchTrack").mockResolvedValue({
            found: true,
            bestMatch: first,
            allMatches: [first, second],
        });
        const downloadTrackSpy = jest
            .spyOn(soulseekService, "downloadTrack")
            .mockResolvedValueOnce({ success: false, error: "timeout" })
            .mockResolvedValueOnce({ success: true });

        const result = await soulseekService.searchAndDownload(
            "Artist/One",
            "Song",
            "Album:One",
            "/music"
        );

        expect(downloadTrackSpy).toHaveBeenCalledTimes(2);
        expect(result).toEqual({
            success: true,
            filePath: path.join(
                "/music",
                "Singles",
                "Artist_One",
                "Album_One",
                "Recovered_.flac"
            ),
        });
    });

    describe("downloadTrack", () => {
        it("returns connection error when ensureConnected rejects", async () => {
            jest.spyOn(soulseekService as any, "ensureConnected").mockRejectedValueOnce(
                new Error("Connection cooldown")
            );

            const result = await soulseekService.downloadTrack(
                makeTrackMatch(),
                "/music/out.flac"
            );

            expect(result).toEqual({
                success: false,
                error: "Connection cooldown",
            });
        });

        it("returns not connected when client is still null after ensureConnected", async () => {
            jest.spyOn(soulseekService as any, "ensureConnected").mockResolvedValueOnce(
                undefined
            );
            (soulseekService as any).client = null;

            const result = await soulseekService.downloadTrack(
                makeTrackMatch(),
                "/music/out.flac"
            );

            expect(result).toEqual({ success: false, error: "Not connected" });
        });

        it("returns directory creation error when mkdir fails", async () => {
            jest.spyOn(soulseekService as any, "ensureConnected").mockResolvedValueOnce(
                undefined
            );
            (soulseekService as any).client = {
                search: jest.fn(),
                download: jest.fn(),
            };
            mockMkdir.mockRejectedValueOnce(new Error("EACCES"));

            const result = await soulseekService.downloadTrack(
                makeTrackMatch(),
                "/music/folder/out.flac"
            );

            expect(result).toEqual({
                success: false,
                error: "Cannot create destination directory: EACCES",
            });
        });

        it("times out download attempts and records cleanup for partial files", async () => {
            jest.useFakeTimers();
            jest.spyOn(soulseekService as any, "ensureConnected").mockResolvedValueOnce(
                undefined
            );
            (soulseekService as any).client = {
                search: jest.fn(),
                download: jest.fn(),
            };
            mockFsExistsSync.mockReturnValue(true);

            const promise = soulseekService.downloadTrack(
                makeTrackMatch({ username: "timeout-user" }),
                "/music/timeout.flac"
            );

            await jest.advanceTimersByTimeAsync(60000);
            const result = await promise;

            expect(result).toEqual({ success: false, error: "Download timed out" });
            expect(mockFsUnlinkSync).toHaveBeenCalledWith("/music/timeout.flac");
            expect((soulseekService as any).failedUsers.get("timeout-user")).toEqual(
                expect.objectContaining({ failures: 1 })
            );
            jest.useRealTimers();
        });

        it("returns callback error and increments failure counter for user problems", async () => {
            jest.spyOn(soulseekService as any, "ensureConnected").mockResolvedValueOnce(
                undefined
            );
            (soulseekService as any).client = {
                search: jest.fn(),
                download: jest.fn(
                    (
                        _opts: unknown,
                        cb: (err: Error | null, data?: { buffer: Buffer }) => void
                    ) => cb(new Error("user offline"))
                ),
            };

            const result = await soulseekService.downloadTrack(
                makeTrackMatch({ username: "offline-user" }),
                "/music/offline.flac"
            );

            expect(result).toEqual({ success: false, error: "user offline" });
            expect((soulseekService as any).failedUsers.get("offline-user")).toEqual(
                expect.objectContaining({ failures: 1 })
            );
        });

        it("returns synchronous download errors when the client throws", async () => {
            jest.spyOn(soulseekService as any, "ensureConnected").mockResolvedValueOnce(
                undefined
            );
            (soulseekService as any).client = {
                search: jest.fn(),
                download: jest.fn(() => {
                    throw new Error("sync download failure");
                }),
            };

            const result = await soulseekService.downloadTrack(
                makeTrackMatch(),
                "/music/sync.flac"
            );

            expect(result).toEqual({
                success: false,
                error: "Synchronous error: sync download failure",
            });
        });

        it("returns error when downloaded file is not written to disk", async () => {
            jest.spyOn(soulseekService as any, "ensureConnected").mockResolvedValueOnce(
                undefined
            );
            mockFsExistsSync.mockReturnValue(false);
            (soulseekService as any).client = {
                search: jest.fn(),
                download: jest.fn(
                    (
                        _opts: unknown,
                        cb: (
                            err: Error | null,
                            data?: { buffer: Buffer }
                        ) => void
                    ) => cb(null, { buffer: Buffer.from("ok") })
                ),
            };

            const result = await soulseekService.downloadTrack(
                makeTrackMatch(),
                "/music/missing.flac"
            );

            expect(result).toEqual({ success: false, error: "File not written" });
        });

        it("returns success when callback completes and file exists", async () => {
            jest.spyOn(soulseekService as any, "ensureConnected").mockResolvedValueOnce(
                undefined
            );
            (soulseekService as any).client = {
                search: jest.fn(),
                download: jest.fn(
                    (
                        _opts: unknown,
                        cb: (err: Error | null, data?: { buffer: Buffer }) => void
                    ) => cb(null, { buffer: Buffer.from("ok") })
                ),
            };
            mockFsExistsSync.mockReturnValue(true);
            mockFsStatSync.mockReturnValue({ size: 4096 });

            const result = await soulseekService.downloadTrack(
                makeTrackMatch(),
                "/music/success.flac"
            );

            expect(result).toEqual({ success: true });
        });
    });

    it("blocks users after repeated failures and cleans up stale entries", () => {
        const service = soulseekService as any;
        service.failedUsers.set("stale", {
            failures: 3,
            lastFailure: new Date(Date.now() - 600_000),
        });
        service.failedUsers.set("blocked", {
            failures: 1,
            lastFailure: new Date(),
        });
        service.failedUsers.set("active", {
            failures: 1,
            lastFailure: new Date(),
        });

        service.recordUserFailure("blocked");
        service.recordUserFailure("blocked");
        service.recordUserFailure("blocked");
        expect(service.failedUsers.get("blocked")?.failures).toBe(4);
        expect(service.isUserBlocked("blocked")).toBe(true);
        service.cleanupFailedUsers();
        expect(service.failedUsers.has("stale")).toBe(false);
        expect(service.failedUsers.has("active")).toBe(true);
        expect(service.failedUsers.has("blocked")).toBe(true);
        expect(service.isUserBlocked("active")).toBe(false);
    });

    it("removes stale block entries during isUserBlocked checks", () => {
        const service = soulseekService as any;
        service.failedUsers.set("expired", {
            failures: 5,
            lastFailure: new Date(Date.now() - 400_000),
        });

        expect(service.isUserBlocked("expired")).toBe(false);
        expect(service.failedUsers.has("expired")).toBe(false);
    });
});
