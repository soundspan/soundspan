const mockClient = {
    get: jest.fn(),
    post: jest.fn(),
};

const mockAxiosCreate = jest.fn(() => mockClient);

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

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: mockAxiosCreate,
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

describe("tidal streaming service", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("availability and auth status", () => {
        it("returns sidecar availability from /health", async () => {
            mockClient.get.mockResolvedValueOnce({ data: { status: "ok" } });

            await expect(tidalStreamingService.isAvailable()).resolves.toBe(true);
            expect(mockClient.get).toHaveBeenCalledWith("/health", { timeout: 5000 });
        });

        it("returns false when /health is non-ok or throws", async () => {
            mockClient.get.mockResolvedValueOnce({ data: { status: "down" } });
            await expect(tidalStreamingService.isAvailable()).resolves.toBe(false);

            mockClient.get.mockRejectedValueOnce(new Error("connection refused"));
            await expect(tidalStreamingService.isAvailable()).resolves.toBe(false);
        });

        it("returns enabled state from system settings with safe fallback", async () => {
            mockPrisma.systemSettings.findUnique.mockResolvedValueOnce({
                id: "default",
                tidalEnabled: true,
            });
            await expect(tidalStreamingService.isEnabled()).resolves.toBe(true);

            mockPrisma.systemSettings.findUnique.mockResolvedValueOnce({
                id: "default",
                tidalEnabled: false,
            });
            await expect(tidalStreamingService.isEnabled()).resolves.toBe(false);

            mockPrisma.systemSettings.findUnique.mockRejectedValueOnce(
                new Error("db unavailable")
            );
            await expect(tidalStreamingService.isEnabled()).resolves.toBe(false);
        });

        it("returns per-user auth status with safe fallback", async () => {
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
    });

    describe("oauth lifecycle", () => {
        it("restores OAuth and returns success without DB writes when token is unchanged", async () => {
            const oauthJson = JSON.stringify({
                access_token: "old-access",
                refresh_token: "old-refresh",
                tidal_user_id: "tidal-1",
                country_code: "US",
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
                    user_id: "tidal-1",
                    country_code: "US",
                }
            );
            expect(mockPrisma.userSettings.update).not.toHaveBeenCalled();
            expect(mockEncrypt).not.toHaveBeenCalled();
        });

        it("persists refreshed OAuth token when sidecar returns a refreshed credential", async () => {
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

        it("returns false and logs when restoreOAuth fails", async () => {
            const oauthJson = JSON.stringify({
                access_token: "a",
                refresh_token: "r",
            });
            const error = {
                response: { data: { error: "invalid token" } },
                message: "bad token",
            };
            mockClient.post.mockRejectedValueOnce(error);

            await expect(
                tidalStreamingService.restoreOAuth("user-err", oauthJson)
            ).resolves.toBe(false);
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining(
                    "[TIDAL-STREAM] Failed to restore OAuth for user user-err:"
                ),
                { error: "invalid token" }
            );
        });

        it("clears sidecar auth and logs warnings on errors", async () => {
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

    describe("device auth and search/stream APIs", () => {
        it("initiates device auth", async () => {
            const payload = {
                device_code: "dev-code",
                user_code: "user-code",
                verification_uri: "https://verify",
                verification_uri_complete: "https://verify/full",
                expires_in: 600,
                interval: 5,
            };
            mockClient.post.mockResolvedValueOnce({ data: payload });

            await expect(tidalStreamingService.initiateDeviceAuth()).resolves.toEqual(
                payload
            );
            expect(mockClient.post).toHaveBeenCalledWith("/auth/device");
        });

        it("polls device auth for success, pending, and terminal error", async () => {
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

            const terminalError = new Error("device auth failed");
            mockClient.post.mockRejectedValueOnce(terminalError);
            await expect(
                tidalStreamingService.pollDeviceAuth("dev-code")
            ).rejects.toBe(terminalError);
        });

        it("searches and batch-searches with encoded user IDs", async () => {
            const searchData = { tracks: [{ id: 1 }] };
            mockClient.post.mockResolvedValueOnce({ data: searchData });
            await expect(
                tidalStreamingService.search("user 1/alpha", "nujabes")
            ).resolves.toEqual(searchData);
            expect(mockClient.post).toHaveBeenCalledWith(
                "/user/search?user_id=user%201%2Falpha",
                { query: "nujabes" }
            );

            const batchQueries = [
                { query: "artist one track one", limit: 5 },
                { query: "artist two track two", filter: "tracks" },
            ];
            const batchData = {
                results: [
                    { query: "artist one track one", results: [{ id: 11 }] },
                    { query: "artist two track two", results: [] },
                ],
            };
            mockClient.post.mockResolvedValueOnce({ data: batchData });

            await expect(
                tidalStreamingService.searchBatch("user 1/alpha", batchQueries)
            ).resolves.toEqual(batchData);
            expect(mockClient.post).toHaveBeenCalledWith(
                "/user/search/batch?user_id=user%201%2Falpha",
                batchQueries
            );
        });

        it("reads stream info and stream proxy payloads", async () => {
            const infoPayload = {
                trackId: 77,
                quality: "LOSSLESS",
                acodec: "flac",
                content_type: "audio/flac",
                bit_depth: 16,
                sample_rate: 44100,
            };
            mockClient.get.mockResolvedValueOnce({ data: infoPayload });

            await expect(
                tidalStreamingService.getStreamInfo("user-1", 77, "LOSSLESS")
            ).resolves.toEqual(infoPayload);
            expect(mockClient.get).toHaveBeenCalledWith(
                "/user/stream-info/77?user_id=user-1&quality=LOSSLESS"
            );

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
            expect(mockClient.get).toHaveBeenCalledWith(
                "/user/stream/77?user_id=user-1&quality=HI_RES_LOSSLESS",
                {
                    responseType: "stream",
                    headers: { Range: "bytes=0-1023" },
                    timeout: 300000,
                }
            );
        });
    });

    describe("matching logic", () => {
        it("finds a strong track match and sanitizes query terms", async () => {
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

        it("rejects low-score and ambiguous match candidates", async () => {
            mockClient.post.mockResolvedValueOnce({
                data: {
                    tracks: [
                        {
                            id: 201,
                            title: "Completely Different Karaoke Tribute",
                            artist: "Unknown Orchestra",
                            duration: 480,
                        },
                    ],
                },
            });
            await expect(
                tidalStreamingService.findMatchForTrack(
                    "user-1",
                    "Artist",
                    "Original Song",
                    "Studio Album",
                    210
                )
            ).resolves.toBeNull();

            mockClient.post.mockResolvedValueOnce({
                data: {
                    tracks: [
                        {
                            id: 301,
                            title: "Signal Part 2",
                            artist: "Artist",
                            duration: 350,
                        },
                        {
                            id: 302,
                            title: "Signal Pt 3",
                            artist: "Artist",
                            duration: 360,
                        },
                    ],
                },
            });
            await expect(
                tidalStreamingService.findMatchForTrack(
                    "user-1",
                    "Artist",
                    "Signal",
                    "Album",
                    200
                )
            ).resolves.toBeNull();
        });

        it("handles invalid expected durations without throwing and still matches strong candidates", async () => {
            mockClient.post.mockResolvedValueOnce({
                data: {
                    tracks: [
                        {
                            id: 350,
                            title: "No Duration Signal",
                            artist: "Duration Artist",
                            duration: 215,
                        },
                    ],
                },
            });

            await expect(
                tidalStreamingService.findMatchForTrack(
                    "user-1",
                    "Duration Artist",
                    "No Duration Signal",
                    undefined,
                    0
                )
            ).resolves.toEqual({
                id: 350,
                title: "No Duration Signal",
                artist: "Duration Artist",
                duration: 215,
                isrc: undefined,
            });
        });

        it("returns null when single-track match search throws", async () => {
            const searchError = new Error("sidecar search failure");
            mockClient.post.mockRejectedValueOnce(searchError);

            await expect(
                tidalStreamingService.findMatchForTrack(
                    "user-1",
                    "Artist",
                    "Track"
                )
            ).resolves.toBeNull();
            expect(mockLogger.debug).toHaveBeenCalledWith(
                '[TIDAL-STREAM] Match failed for "Artist - Track":',
                searchError
            );
        });

        it("matches album tracks with positive, low-score, and ambiguous outcomes", async () => {
            const tracks = [
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
                {
                    artist: "Artist Three",
                    title: "Signal",
                    duration: 200,
                },
            ];

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
                        {
                            query: "Artist Three Signal",
                            results: [
                                {
                                    id: 403,
                                    title: "Signal Part 2",
                                    artist: "Artist Three",
                                    duration: 350,
                                },
                                {
                                    id: 404,
                                    title: "Signal Pt 3",
                                    artist: "Artist Three",
                                    duration: 360,
                                },
                            ],
                        },
                    ],
                },
            });

            await expect(
                tidalStreamingService.findMatchesForAlbum("user-1", tracks)
            ).resolves.toEqual([
                {
                    id: 401,
                    title: "Anthem",
                    artist: "Artist One",
                    duration: 180,
                    isrc: "USAA19990001",
                },
                null,
                null,
            ]);

            expect(mockClient.post).toHaveBeenCalledWith(
                "/user/search/batch?user_id=user-1",
                [
                    { query: "Artist One Anthem", limit: 8 },
                    { query: "Artist Two Ballad", limit: 8 },
                    { query: "Artist Three Signal", limit: 8 },
                ]
            );
        });

        it("returns nulls for every track when album batch search fails", async () => {
            const tracks = [
                { artist: "A", title: "B" },
                { artist: "C", title: "D", duration: 180 },
            ];
            const batchError = new Error("batch down");
            mockClient.post.mockRejectedValueOnce(batchError);

            await expect(
                tidalStreamingService.findMatchesForAlbum("user-1", tracks)
            ).resolves.toEqual([null, null]);
            expect(mockLogger.error).toHaveBeenCalledWith(
                "[TIDAL-STREAM] Batch match failed:",
                batchError
            );
        });
    });
});
