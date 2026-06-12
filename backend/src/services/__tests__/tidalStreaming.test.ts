const mockClient = {
    get: jest.fn(),
    post: jest.fn(),
};

const mockAxiosCreate = jest.fn(() => mockClient);
const mockAxiosGet = jest.fn();
const mockAxiosPost = jest.fn();

const mockPrisma = {
    systemSettings: {
        findUnique: jest.fn(),
    },
    userSettings: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
};

const mockEncrypt = jest.fn((value: string) => `enc:${value}`);

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

const mockHttpAgent = jest.fn().mockImplementation(() => ({ kind: "http-agent" }));
const mockHttpsAgent = jest.fn().mockImplementation(() => ({ kind: "https-agent" }));

const ORIGINAL_ENV = { ...process.env };

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: mockAxiosCreate,
        get: mockAxiosGet,
        post: mockAxiosPost,
    },
    create: mockAxiosCreate,
    get: mockAxiosGet,
    post: mockAxiosPost,
}));

jest.mock("node:http", () => ({
    __esModule: true,
    default: {
        Agent: mockHttpAgent,
    },
}));

jest.mock("node:https", () => ({
    __esModule: true,
    default: {
        Agent: mockHttpsAgent,
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: mockPrisma,
}));

jest.mock("../../utils/encryption", () => ({
    encrypt: mockEncrypt,
}));

jest.mock("../../utils/logger", () => ({
    logger: mockLogger,
}));

import { tidalStreamingService } from "../tidalStreaming";

type MatchTrackInput = {
    artist: string;
    title: string;
    albumTitle?: string;
    duration?: number;
    isrc?: string;
};

type MatchCandidateInput = {
    title: string;
    artist: string;
    duration?: number;
    isrc?: string;
    album?: { title: string };
};

type RankedCandidate = {
    id: string;
    __score: number;
};

type TidalStreamingPrivate = {
    availabilityCache: { value: boolean; expiresAt: number } | null;
    enabledCache: { value: boolean; expiresAt: number } | null;
    availabilityInFlight: Promise<boolean> | null;
    enabledInFlight: Promise<boolean> | null;
    qualityCache: Map<string, { quality: string; expiresAt: number }>;
    isAvailable(): Promise<boolean>;
    isEnabled(): Promise<boolean>;
    getUserPreferredQuality(userId: string): Promise<string>;
    clearUserQualityCache(userId: string): void;
    textSimilarity(expected: string, candidate: string): number;
    durationSimilarity(expected?: number, candidate?: number): number | null;
    scoreCandidate(track: MatchTrackInput, candidate: MatchCandidateInput): number;
    selectBestCandidate(
        track: Pick<MatchTrackInput, "artist" | "title">,
        candidates: RankedCandidate[]
    ): RankedCandidate | null;
};

const privateService = tidalStreamingService as unknown as TidalStreamingPrivate;

function resetServiceState(service: TidalStreamingPrivate): void {
    service.availabilityCache = null;
    service.enabledCache = null;
    service.availabilityInFlight = null;
    service.enabledInFlight = null;
    service.qualityCache?.clear?.();
}

function loadIsolatedService(envOverrides: Record<string, string | undefined> = {}) {
    const nextEnv: NodeJS.ProcessEnv = {
        ...ORIGINAL_ENV,
        ...envOverrides,
    };

    for (const [key, value] of Object.entries(envOverrides)) {
        if (value === undefined) {
            delete nextEnv[key];
        }
    }

    process.env = nextEnv;

    let isolatedService: TidalStreamingPrivate | undefined;
    jest.isolateModules(() => {
        isolatedService = require("../tidalStreaming")
            .tidalStreamingService as TidalStreamingPrivate;
    });

    process.env = { ...ORIGINAL_ENV };
    return isolatedService as TidalStreamingPrivate;
}

describe("tidal streaming service", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockClient.get.mockReset();
        mockClient.post.mockReset();
        mockPrisma.systemSettings.findUnique.mockReset();
        mockPrisma.userSettings.findUnique.mockReset();
        mockPrisma.userSettings.update.mockReset();
        resetServiceState(privateService);
        process.env = { ...ORIGINAL_ENV };
    });

    afterEach(() => {
        jest.restoreAllMocks();
        process.env = { ...ORIGINAL_ENV };
    });

    afterAll(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    describe("availability and enablement", () => {
        it("creates the client with the configured sidecar URL and mocked agents", () => {
            const isolatedService = loadIsolatedService({
                NODE_ENV: "test",
                TIDAL_SIDECAR_URL: "http://sidecar.test:9000",
            });

            expect(isolatedService).toBeDefined();
            expect(mockHttpAgent).toHaveBeenCalledWith({
                keepAlive: true,
                maxSockets: 64,
                maxFreeSockets: 16,
            });
            expect(mockHttpsAgent).toHaveBeenCalledWith({
                keepAlive: true,
                maxSockets: 64,
                maxFreeSockets: 16,
            });
            expect(mockAxiosCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    baseURL: "http://sidecar.test:9000",
                    timeout: 30000,
                    headers: { "Content-Type": "application/json" },
                })
            );
        });

        it("caches sidecar availability responses", async () => {
            mockClient.get.mockResolvedValueOnce({ data: { status: "ok" } });

            await expect(tidalStreamingService.isAvailable()).resolves.toBe(true);
            await expect(tidalStreamingService.isAvailable()).resolves.toBe(true);

            expect(mockClient.get).toHaveBeenCalledTimes(1);
            expect(mockClient.get).toHaveBeenCalledWith("/health", { timeout: 5000 });
        });

        it("reads system settings for enabled state and falls back safely", async () => {
            mockPrisma.systemSettings.findUnique.mockResolvedValueOnce({
                id: "default",
                tidalEnabled: true,
            });

            await expect(tidalStreamingService.isEnabled()).resolves.toBe(true);
            await expect(tidalStreamingService.isEnabled()).resolves.toBe(true);
            expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledTimes(1);
            expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledWith({
                where: { id: "default" },
                select: { tidalEnabled: true },
            });

            privateService.enabledCache = null;
            mockPrisma.systemSettings.findUnique.mockRejectedValueOnce(
                new Error("db unavailable")
            );

            await expect(tidalStreamingService.isEnabled()).resolves.toBe(false);
        });
    });

    describe("per-user auth", () => {
        it("returns credential status for configured, unconfigured, and failed lookups", async () => {
            mockPrisma.userSettings.findUnique.mockResolvedValueOnce({
                userId: "user-1",
                tidalOAuthJson: "encrypted-oauth",
            });
            await expect(
                tidalStreamingService.getAuthStatus("user-1")
            ).resolves.toEqual({
                authenticated: true,
                credentialsConfigured: true,
            });

            mockPrisma.userSettings.findUnique.mockResolvedValueOnce({
                userId: "user-2",
                tidalOAuthJson: null,
            });
            await expect(
                tidalStreamingService.getAuthStatus("user-2")
            ).resolves.toEqual({
                authenticated: false,
                credentialsConfigured: false,
            });

            mockPrisma.userSettings.findUnique.mockRejectedValueOnce(
                new Error("status read failure")
            );
            await expect(
                tidalStreamingService.getAuthStatus("user-3")
            ).resolves.toEqual({
                authenticated: false,
                credentialsConfigured: false,
            });
        });

        it("restores OAuth without persisting when the sidecar does not refresh", async () => {
            const oauthJson = JSON.stringify({
                access_token: "old-access",
                refresh_token: "old-refresh",
                user_id: "legacy-user",
            });
            mockClient.post.mockResolvedValueOnce({ data: { success: true } });

            await expect(
                tidalStreamingService.restoreOAuth("user/1", oauthJson)
            ).resolves.toBe(true);

            expect(mockClient.post).toHaveBeenCalledWith(
                "/user/auth/restore?user_id=user%2F1",
                {
                    access_token: "old-access",
                    refresh_token: "old-refresh",
                    user_id: "legacy-user",
                    country_code: "US",
                }
            );
            expect(mockPrisma.userSettings.update).not.toHaveBeenCalled();
            expect(mockEncrypt).not.toHaveBeenCalled();
        });

        it("persists refreshed OAuth credentials returned by the sidecar", async () => {
            const oauthJson = JSON.stringify({
                access_token: "old-access",
                refresh_token: "old-refresh",
                user_id: "legacy-user",
                country_code: "US",
            });

            mockClient.post.mockResolvedValueOnce({
                data: {
                    success: true,
                    refreshed: true,
                    access_token: "new-access",
                    user_id: "tidal-999",
                    country_code: "CA",
                },
            });

            await expect(
                tidalStreamingService.restoreOAuth("user-1", oauthJson)
            ).resolves.toBe(true);

            expect(mockEncrypt).toHaveBeenCalledTimes(1);
            const persistedJson = mockEncrypt.mock.calls[0][0];
            expect(JSON.parse(persistedJson)).toEqual(
                expect.objectContaining({
                    access_token: "new-access",
                    refresh_token: "old-refresh",
                    user_id: "tidal-999",
                    tidal_user_id: "tidal-999",
                    country_code: "CA",
                })
            );
            expect(mockPrisma.userSettings.update).toHaveBeenCalledWith({
                where: { userId: "user-1" },
                data: { tidalOAuthJson: `enc:${persistedJson}` },
            });
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining(
                    "[TIDAL-STREAM] Refreshed and persisted new token for user user-1"
                )
            );
        });

        it("returns false and logs when OAuth restoration fails", async () => {
            mockClient.post.mockRejectedValueOnce({
                response: { data: { error: "invalid token" } },
                message: "bad token",
            });

            await expect(
                tidalStreamingService.restoreOAuth(
                    "user-err",
                    JSON.stringify({ access_token: "a", refresh_token: "r" })
                )
            ).resolves.toBe(false);

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining(
                    "[TIDAL-STREAM] Failed to restore OAuth for user user-err:"
                ),
                { error: "invalid token" }
            );
        });

        it("clears sidecar auth and logs warnings on failure", async () => {
            mockClient.post.mockResolvedValueOnce({ data: { success: true } });
            await expect(
                tidalStreamingService.clearAuth("clear-user")
            ).resolves.toBeUndefined();
            expect(mockClient.post).toHaveBeenCalledWith(
                "/user/auth/clear?user_id=clear-user"
            );

            mockClient.post.mockRejectedValueOnce({
                response: { data: "clear failed" },
                message: "clear failed",
            });
            await expect(
                tidalStreamingService.clearAuth("clear-user")
            ).resolves.toBeUndefined();
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining(
                    "[TIDAL-STREAM] Failed to clear auth for user clear-user:"
                ),
                "clear failed"
            );
        });
    });

    describe("sidecar API wrappers", () => {
        it("proxies device auth, search, and stream requests", async () => {
            const authPayload = {
                device_code: "dev-code",
                user_code: "user-code",
                verification_uri: "https://verify",
                verification_uri_complete: "https://verify/full",
                expires_in: 600,
                interval: 5,
            };
            mockClient.post.mockResolvedValueOnce({ data: authPayload });
            await expect(tidalStreamingService.initiateDeviceAuth()).resolves.toEqual(
                authPayload
            );

            const tokenPayload = {
                access_token: "access",
                refresh_token: "refresh",
                user_id: "tidal-user",
                country_code: "US",
                username: "listener",
            };
            mockClient.post.mockResolvedValueOnce({ data: tokenPayload });
            await expect(
                tidalStreamingService.pollDeviceAuth("dev-code")
            ).resolves.toEqual(tokenPayload);

            mockClient.post.mockRejectedValueOnce({ response: { status: 428 } });
            await expect(
                tidalStreamingService.pollDeviceAuth("dev-code")
            ).resolves.toBeNull();

            const searchData = { tracks: [{ id: 1 }] };
            mockClient.post.mockResolvedValueOnce({ data: searchData });
            await expect(
                tidalStreamingService.search("user 1/alpha", "nujabes")
            ).resolves.toEqual(searchData);

            const batchData = {
                results: [{ query: "artist track", results: [{ id: 11 }] }],
            };
            mockClient.post.mockResolvedValueOnce({ data: batchData });
            await expect(
                tidalStreamingService.searchBatch("user 1/alpha", [
                    { query: "artist track", limit: 5 },
                ])
            ).resolves.toEqual(batchData);

            const infoPayload = {
                trackId: 77,
                quality: "LOSSLESS",
                acodec: "flac",
                content_type: "audio/flac",
            };
            mockClient.get.mockResolvedValueOnce({ data: infoPayload });
            await expect(
                tidalStreamingService.getStreamInfo("user-1", 77, "LOSSLESS")
            ).resolves.toEqual(infoPayload);

            mockClient.get.mockResolvedValueOnce({
                data: { stream: true },
                headers: { "content-type": "audio/flac" },
                status: 206,
            });
            await expect(
                tidalStreamingService.getStreamProxy(
                    "user-1",
                    77,
                    "HI_RES_LOSSLESS",
                    "bytes=0-1023"
                )
            ).resolves.toEqual({
                data: { stream: true },
                headers: { "content-type": "audio/flac" },
                status: 206,
            });

            expect(mockClient.post).toHaveBeenNthCalledWith(1, "/auth/device");
            expect(mockClient.post).toHaveBeenNthCalledWith(2, "/auth/token", {
                device_code: "dev-code",
            });
            expect(mockClient.post).toHaveBeenNthCalledWith(3, "/auth/token", {
                device_code: "dev-code",
            });
            expect(mockClient.post).toHaveBeenNthCalledWith(
                4,
                "/user/search?user_id=user%201%2Falpha",
                { query: "nujabes" }
            );
            expect(mockClient.post).toHaveBeenNthCalledWith(
                5,
                "/user/search/batch?user_id=user%201%2Falpha",
                [{ query: "artist track", limit: 5 }]
            );
            expect(mockClient.get).toHaveBeenNthCalledWith(
                1,
                "/user/stream-info/77?user_id=user-1&quality=LOSSLESS"
            );
            expect(mockClient.get).toHaveBeenNthCalledWith(
                2,
                "/user/stream/77?user_id=user-1&quality=HI_RES_LOSSLESS",
                {
                    responseType: "stream",
                    headers: { Range: "bytes=0-1023" },
                    timeout: 300000,
                }
            );
        });

        it("returns track metadata and logs null on track lookup failure", async () => {
            const trackPayload = {
                id: 42,
                title: "Track Title",
                artist: "Track Artist",
                artists: ["Track Artist"],
                duration: 210,
                isrc: "USAAA2300001",
                explicit: false,
                album: {
                    id: 9,
                    title: "Album Title",
                },
            };
            mockClient.get.mockResolvedValueOnce({ data: trackPayload });

            await expect(
                tidalStreamingService.getTrack("user/1", 42)
            ).resolves.toEqual(trackPayload);
            expect(mockClient.get).toHaveBeenCalledWith(
                "/user/track/42?user_id=user%2F1"
            );

            const trackError = {
                response: { data: { error: "not found" } },
                message: "not found",
            };
            mockClient.get.mockRejectedValueOnce(trackError);

            await expect(
                tidalStreamingService.getTrack("user/1", 42)
            ).resolves.toBeNull();
            expect(mockLogger.debug).toHaveBeenCalledWith(
                "[TIDAL-STREAM] getTrack failed for trackId=42:",
                { error: "not found" }
            );
        });
    });

    describe("matching helpers", () => {
        it("normalizes text and computes similarity across sanitized variants", () => {
            expect(privateService.textSimilarity("Don't Stop (feat. Guest)", "dont stop")).toBe(1);
            expect(privateService.textSimilarity("Signal Pt. 2", "signal pt2")).toBeCloseTo(
                0.98,
                5
            );
            expect(privateService.textSimilarity("The Big Song", "Big Song Live")).toBeCloseTo(
                0.45,
                5
            );
        });

        it("calculates duration similarity using normalized seconds", () => {
            expect(privateService.durationSimilarity(180000, 180)).toBe(1);
            expect(privateService.durationSimilarity(210, 216)).toBe(0.75);
            expect(privateService.durationSimilarity(210, 246)).toBe(0);
            expect(privateService.durationSimilarity(undefined, 180)).toBeNull();
        });

        it("scores strong candidates above weak or mismatched candidates", () => {
            const track = {
                artist: "Artist Name",
                title: "Signal Song",
                albumTitle: "Album Cut",
                duration: 210,
                isrc: "US-AAA-23-00001",
            };

            const idealCandidate = {
                title: "Signal Song",
                artist: "Artist Name",
                duration: 210,
                isrc: "USAAA2300001",
                album: { title: "Album Cut" },
            };
            const wrongIsrcCandidate = {
                ...idealCandidate,
                isrc: "GBBBB2399999",
            };
            const karaokeCandidate = {
                title: "Signal Song Karaoke Tribute",
                artist: "Studio Musicians",
                duration: 390,
                isrc: "GBBBB2399999",
                album: { title: "Other Album" },
            };

            const idealScore = privateService.scoreCandidate(track, idealCandidate);
            const wrongIsrcScore = privateService.scoreCandidate(track, wrongIsrcCandidate);
            const karaokeScore = privateService.scoreCandidate(track, karaokeCandidate);

            expect(idealScore).toBeGreaterThan(wrongIsrcScore);
            expect(wrongIsrcScore).toBeGreaterThan(karaokeScore);
            expect(karaokeScore).toBeLessThan(0.54);
        });

        it("applies ISRC bonuses and penalties when other candidate data matches", () => {
            const track = {
                artist: "Artist Name",
                title: "Signal Song",
                albumTitle: "Album Cut",
                duration: 210,
                isrc: "US-AAA-23-00001",
            };

            const matchingIsrcScore = privateService.scoreCandidate(track, {
                title: "Signal Song",
                artist: "Artist Name",
                duration: 210,
                isrc: "USAAA2300001",
                album: { title: "Album Cut" },
            });
            const mismatchedIsrcScore = privateService.scoreCandidate(track, {
                title: "Signal Song",
                artist: "Artist Name",
                duration: 210,
                isrc: "GBBBB2399999",
                album: { title: "Album Cut" },
            });

            expect(matchingIsrcScore - mismatchedIsrcScore).toBeCloseTo(0.55, 5);
        });

        it("selects the best candidate only when thresholds are satisfied", () => {
            const scoreSpy = jest
                .spyOn(privateService, "scoreCandidate")
                .mockImplementation(
                    (_track, candidate) =>
                        (candidate as unknown as RankedCandidate).__score
                );

            expect(
                privateService.selectBestCandidate({ artist: "A", title: "B" }, [
                    { id: "too-low", __score: 0.53 },
                ])
            ).toBeNull();

            expect(
                privateService.selectBestCandidate({ artist: "A", title: "B" }, [
                    { id: "ambiguous-a", __score: 0.61 },
                    { id: "ambiguous-b", __score: 0.56 },
                ])
            ).toBeNull();

            const winner = { id: "winner", __score: 0.72 };
            expect(
                privateService.selectBestCandidate({ artist: "A", title: "B" }, [
                    winner,
                    { id: "runner-up", __score: 0.4 },
                ])
            ).toBe(winner);

            scoreSpy.mockRestore();
        });

        it("finds a single track match using sanitized search text", async () => {
            mockClient.post.mockResolvedValueOnce({
                data: {
                    tracks: [
                        {
                            id: 101,
                            title: "Song Name",
                            artist: "Artist Name",
                            duration: 210,
                            isrc: "USAB12345678",
                            album: { title: "Album Name" },
                        },
                        {
                            id: 102,
                            title: "Song Name (Live)",
                            artist: "Artist Name",
                            duration: 210,
                            album: { title: "Album Name" },
                        },
                    ],
                },
            });

            await expect(
                tidalStreamingService.findMatchForTrack(
                    "user-1",
                    "Artist Name (feat. Guest)",
                    "Song Name - Remaster 2011",
                    "Album Name",
                    210,
                    "USAB12345678"
                )
            ).resolves.toEqual({
                id: 101,
                title: "Song Name",
                artist: "Artist Name",
                duration: 210,
                isrc: "USAB12345678",
            });

            expect(mockClient.post).toHaveBeenCalledWith(
                "/user/search?user_id=user-1",
                { query: "Artist Name Song Name" }
            );
        });

        it("matches album tracks in batch and returns null when a candidate set is weak", async () => {
            mockClient.post.mockResolvedValueOnce({
                data: {
                    results: [
                        {
                            query: "Artist One Anthem",
                            results: [
                                {
                                    id: 401,
                                    title: "Anthem",
                                    artist: "Artist One",
                                    duration: 180,
                                    isrc: "USAA19990001",
                                    album: { title: "Compilation" },
                                },
                            ],
                        },
                        {
                            query: "Artist Two Ballad",
                            results: [
                                {
                                    id: 402,
                                    title: "Ballad Karaoke Tribute",
                                    artist: "Unknown Ensemble",
                                    duration: 500,
                                },
                            ],
                        },
                    ],
                },
            });

            await expect(
                tidalStreamingService.findMatchesForAlbum("user-1", [
                    {
                        artist: "Artist One (feat. Guest)",
                        title: "Anthem - Deluxe Edition",
                        albumTitle: "Compilation",
                        duration: 180,
                        isrc: "USAA19990001",
                    },
                    {
                        artist: "Artist Two",
                        title: "Ballad",
                        duration: 200,
                    },
                ])
            ).resolves.toEqual([
                {
                    id: 401,
                    title: "Anthem",
                    artist: "Artist One",
                    duration: 180,
                    isrc: "USAA19990001",
                },
                null,
            ]);

            expect(mockClient.post).toHaveBeenCalledWith(
                "/user/search/batch?user_id=user-1",
                [
                    { query: "Artist One Anthem", limit: 8 },
                    { query: "Artist Two Ballad", limit: 8 },
                ]
            );
        });
    });

    describe("quality preferences", () => {
        it("caches user quality in non-test environments and clears the cache on demand", async () => {
            const productionService = loadIsolatedService({ NODE_ENV: "production" });

            mockPrisma.userSettings.findUnique.mockResolvedValueOnce({
                tidalStreamingQuality: "LOSSLESS",
            });
            await expect(
                productionService.getUserPreferredQuality("user-1")
            ).resolves.toBe("LOSSLESS");
            await expect(
                productionService.getUserPreferredQuality("user-1")
            ).resolves.toBe("LOSSLESS");

            expect(mockPrisma.userSettings.findUnique).toHaveBeenCalledTimes(1);
            expect(mockPrisma.userSettings.findUnique).toHaveBeenCalledWith({
                where: { userId: "user-1" },
                select: { tidalStreamingQuality: true },
            });

            productionService.clearUserQualityCache("user-1");
            mockPrisma.userSettings.findUnique.mockResolvedValueOnce({
                tidalStreamingQuality: "LOW",
            });

            await expect(
                productionService.getUserPreferredQuality("user-1")
            ).resolves.toBe("LOW");
            expect(mockPrisma.userSettings.findUnique).toHaveBeenCalledTimes(2);
        });

        it("falls back to HIGH when reading the quality preference fails", async () => {
            mockPrisma.userSettings.findUnique.mockRejectedValueOnce(
                new Error("read failed")
            );

            await expect(
                tidalStreamingService.getUserPreferredQuality("user-err")
            ).resolves.toBe("HIGH");
        });
    });

    describe("browse methods", () => {
        it.each([
            {
                methodName: "getHomeShelves",
                args: ["user-1", "HIGH"],
                response: { shelves: [{ title: "Home", contents: [] }] },
                expectedPath: "/user/browse/home?user_id=user-1&quality=HIGH",
                expectedResult: [{ title: "Home", contents: [] }],
            },
            {
                methodName: "getExploreShelves",
                args: ["user-1", "LOSSLESS"],
                response: { shelves: [{ title: "Explore", contents: [] }] },
                expectedPath: "/user/browse/explore?user_id=user-1&quality=LOSSLESS",
                expectedResult: [{ title: "Explore", contents: [] }],
            },
            {
                methodName: "getGenres",
                args: ["user-1", "HIGH"],
                response: {
                    genres: [
                        {
                            name: "Ambient",
                            path: "ambient",
                            hasPlaylists: true,
                            imageUrl: null,
                        },
                    ],
                },
                expectedPath: "/user/browse/genres?user_id=user-1&quality=HIGH",
                expectedResult: [
                    {
                        name: "Ambient",
                        path: "ambient",
                        hasPlaylists: true,
                        imageUrl: null,
                    },
                ],
            },
            {
                methodName: "getMoods",
                args: ["user-1", "HIGH"],
                response: {
                    moods: [
                        {
                            name: "Focus",
                            path: "focus",
                            hasPlaylists: true,
                            imageUrl: null,
                        },
                    ],
                },
                expectedPath: "/user/browse/moods?user_id=user-1&quality=HIGH",
                expectedResult: [
                    {
                        name: "Focus",
                        path: "focus",
                        hasPlaylists: true,
                        imageUrl: null,
                    },
                ],
            },
            {
                methodName: "getMixes",
                args: ["user-1", "HIGH"],
                response: {
                    mixes: [
                        {
                            mixId: "mix-1",
                            title: "Daily Mix",
                            subTitle: "Fresh picks",
                            thumbnailUrl: null,
                        },
                    ],
                },
                expectedPath: "/user/browse/mixes?user_id=user-1&quality=HIGH",
                expectedResult: [
                    {
                        mixId: "mix-1",
                        title: "Daily Mix",
                        subTitle: "Fresh picks",
                        thumbnailUrl: null,
                    },
                ],
            },
            {
                methodName: "getGenrePlaylists",
                args: ["user-1", "moods/chill vibes", "HIGH"],
                response: {
                    playlists: [
                        {
                            playlistId: "playlist-1",
                            title: "Late Night",
                            thumbnailUrl: null,
                            numTracks: 25,
                        },
                    ],
                },
                expectedPath:
                    "/user/browse/genre-playlists?user_id=user-1&quality=HIGH&path=moods%2Fchill+vibes",
                expectedResult: [
                    {
                        playlistId: "playlist-1",
                        title: "Late Night",
                        thumbnailUrl: null,
                        numTracks: 25,
                    },
                ],
            },
        ])(
            "$methodName proxies browse responses from the sidecar",
            async ({ methodName, args, response, expectedPath, expectedResult }) => {
                mockClient.get.mockResolvedValueOnce({ data: response });
                const browseService = tidalStreamingService as unknown as Record<
                    string,
                    (...methodArgs: unknown[]) => Promise<unknown>
                >;

                await expect(
                    browseService[methodName](...args)
                ).resolves.toEqual(expectedResult);

                expect(mockClient.get).toHaveBeenCalledWith(expectedPath, {
                    timeout: 15000,
                });
            }
        );

        it("proxies detailed browse playlist and mix requests", async () => {
            const playlistPayload = {
                id: "playlist/42",
                title: "Browse Playlist",
                trackCount: 2,
                thumbnailUrl: null,
                tracks: [],
            };
            mockClient.get.mockResolvedValueOnce({ data: playlistPayload });

            await expect(
                tidalStreamingService.getBrowsePlaylist(
                    "user-1",
                    "playlist/42",
                    "LOSSLESS",
                    25
                )
            ).resolves.toEqual(playlistPayload);
            expect(mockClient.get).toHaveBeenNthCalledWith(
                1,
                "/user/browse/playlist/playlist%2F42?user_id=user-1&quality=LOSSLESS&limit=25",
                { timeout: 15000 }
            );

            const publicPlaylistPayload = {
                id: "public/1",
                title: "Public Playlist",
                trackCount: 1,
                thumbnailUrl: null,
                tracks: [],
            };
            mockClient.get.mockResolvedValueOnce({ data: publicPlaylistPayload });

            await expect(
                tidalStreamingService.getPublicBrowsePlaylist(
                    "public/1",
                    "HIGH",
                    50
                )
            ).resolves.toEqual(publicPlaylistPayload);
            expect(mockClient.get).toHaveBeenNthCalledWith(
                2,
                "/browse/playlist/public%2F1?quality=HIGH&limit=50",
                { timeout: 15000 }
            );

            const mixPayload = {
                id: "mix/7",
                title: "Mix Detail",
                trackCount: 3,
                thumbnailUrl: null,
                tracks: [],
            };
            mockClient.get.mockResolvedValueOnce({ data: mixPayload });

            await expect(
                tidalStreamingService.getBrowseMix("user-1", "mix/7", "HIGH")
            ).resolves.toEqual(mixPayload);
            expect(mockClient.get).toHaveBeenNthCalledWith(
                3,
                "/user/browse/mix/mix%2F7?user_id=user-1&quality=HIGH",
                { timeout: 15000 }
            );
        });
    });
});
