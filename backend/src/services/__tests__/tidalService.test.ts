const mockClient = {
    get: jest.fn(),
    post: jest.fn(),
};

const mockAxiosCreate = jest.fn((_config?: unknown) => mockClient);
const mockGetSystemSettings = jest.fn();
const mockEncrypt = jest.fn((value: string) => `enc:${value}`);
const mockDecrypt = jest.fn((value: string) => `dec:${value}`);
const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

const mockPrisma = {
    systemSettings: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
};

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: (config: unknown) => mockAxiosCreate(config),
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: mockGetSystemSettings,
}));

jest.mock("../../utils/db", () => ({
    prisma: mockPrisma,
}));

jest.mock("../../utils/encryption", () => ({
    encrypt: mockEncrypt,
    decrypt: mockDecrypt,
}));

jest.mock("../../utils/logger", () => ({
    logger: mockLogger,
}));

import { tidalService } from "../tidal";

describe("tidalService", () => {
    const baseCreds = {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        userId: "user-1",
        countryCode: "US",
        quality: "LOSSLESS",
        fileTemplate: "{album.artist}/{item.title}",
    };

    beforeEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
        mockEncrypt.mockImplementation((value: string) => `enc:${value}`);
        mockDecrypt.mockImplementation((value: string) => `dec:${value}`);
    });

    describe("isSidecarHealthy", () => {
        it("returns true when sidecar health endpoint reports ok", async () => {
            mockClient.get.mockResolvedValueOnce({ data: { status: "ok" } });

            await expect(tidalService.isSidecarHealthy()).resolves.toBe(true);
            expect(mockClient.get).toHaveBeenCalledWith("/health", { timeout: 5000 });
        });

        it("returns false when sidecar health endpoint is non-ok or throws", async () => {
            mockClient.get.mockResolvedValueOnce({ data: { status: "down" } });
            await expect(tidalService.isSidecarHealthy()).resolves.toBe(false);

            mockClient.get.mockRejectedValueOnce(new Error("connection refused"));
            await expect(tidalService.isSidecarHealthy()).resolves.toBe(false);
        });
    });

    describe("isEnabled and isAvailable", () => {
        it("returns enabled state based on system settings and safely falls back on errors", async () => {
            mockGetSystemSettings.mockResolvedValueOnce({
                tidalEnabled: true,
                tidalAccessToken: "a",
                tidalRefreshToken: "r",
            });
            await expect(tidalService.isEnabled()).resolves.toBe(true);

            mockGetSystemSettings.mockResolvedValueOnce({
                tidalEnabled: true,
                tidalAccessToken: "a",
                tidalRefreshToken: null,
            });
            await expect(tidalService.isEnabled()).resolves.toBe(false);

            mockGetSystemSettings.mockRejectedValueOnce(new Error("db unavailable"));
            await expect(tidalService.isEnabled()).resolves.toBe(false);
        });

        it("returns false from isAvailable when not enabled and does not check sidecar health", async () => {
            mockGetSystemSettings.mockResolvedValueOnce({
                tidalEnabled: false,
                tidalAccessToken: "a",
                tidalRefreshToken: "r",
            });
            const healthSpy = jest
                .spyOn(tidalService, "isSidecarHealthy")
                .mockResolvedValue(true);

            await expect(tidalService.isAvailable()).resolves.toBe(false);
            expect(healthSpy).not.toHaveBeenCalled();
        });

        it("returns sidecar health result from isAvailable when enabled", async () => {
            mockGetSystemSettings.mockResolvedValueOnce({
                tidalEnabled: true,
                tidalAccessToken: "a",
                tidalRefreshToken: "r",
            });
            const healthSpy = jest
                .spyOn(tidalService, "isSidecarHealthy")
                .mockResolvedValue(true);

            await expect(tidalService.isAvailable()).resolves.toBe(true);
            expect(healthSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe("credential and token helpers", () => {
        it("getCredentials falls back to raw stored tokens when decrypt returns empty or throws", async () => {
            mockPrisma.systemSettings.findUnique.mockResolvedValueOnce({
                id: "default",
                tidalAccessToken: "raw-access",
                tidalRefreshToken: "raw-refresh",
                tidalUserId: null,
                tidalCountryCode: null,
                tidalQuality: null,
                tidalFileTemplate: null,
            });
            mockDecrypt
                .mockReturnValueOnce("")
                .mockImplementationOnce(() => {
                    throw new Error("bad decrypt");
                });

            const creds = await (tidalService as any).getCredentials();

            expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledWith({
                where: { id: "default" },
            });
            expect(mockDecrypt).toHaveBeenNthCalledWith(1, "raw-access");
            expect(mockDecrypt).toHaveBeenNthCalledWith(2, "raw-refresh");
            expect(creds).toEqual({
                accessToken: "raw-access",
                refreshToken: "raw-refresh",
                userId: "",
                countryCode: "US",
                quality: "HIGH",
                fileTemplate:
                    "{album.artist}/{album.title}/{item.number:02d}. {item.title}",
            });
        });

        it("saveTokens encrypts both tokens and persists the encrypted payload", async () => {
            await tidalService.saveTokens({
                accessToken: "plain-access",
                refreshToken: "plain-refresh",
                userId: "tidal-user",
                countryCode: "CA",
            });

            expect(mockEncrypt).toHaveBeenNthCalledWith(1, "plain-access");
            expect(mockEncrypt).toHaveBeenNthCalledWith(2, "plain-refresh");
            expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith({
                where: { id: "default" },
                data: {
                    tidalAccessToken: "enc:plain-access",
                    tidalRefreshToken: "enc:plain-refresh",
                    tidalUserId: "tidal-user",
                    tidalCountryCode: "CA",
                },
            });
            expect(mockLogger.debug).toHaveBeenCalledWith("[TIDAL] Tokens saved");
        });

        it("refreshAccessToken calls sidecar and persists refreshed access token", async () => {
            jest.spyOn(tidalService as any, "getCredentials").mockResolvedValue(baseCreds);
            const saveTokensSpy = jest
                .spyOn(tidalService, "saveTokens")
                .mockResolvedValue(undefined);
            mockClient.post.mockResolvedValueOnce({
                data: {
                    access_token: "new-access",
                    user_id: "tidal-22",
                    country_code: "NL",
                },
            });

            await expect(tidalService.refreshAccessToken()).resolves.toBe(true);
            expect(mockClient.post).toHaveBeenCalledWith("/auth/refresh", {
                refresh_token: "refresh-token",
            });
            expect(saveTokensSpy).toHaveBeenCalledWith({
                accessToken: "new-access",
                refreshToken: "refresh-token",
                userId: "tidal-22",
                countryCode: "NL",
            });
        });

        it("refreshAccessToken returns false and logs sidecar error details", async () => {
            jest.spyOn(tidalService as any, "getCredentials").mockResolvedValue(baseCreds);
            mockClient.post.mockRejectedValueOnce({
                response: { data: { error: "invalid_refresh_token" } },
                message: "refresh failed",
            });

            await expect(tidalService.refreshAccessToken()).resolves.toBe(false);
            expect(mockLogger.error).toHaveBeenCalledWith(
                "[TIDAL] Token refresh failed:",
                { error: "invalid_refresh_token" }
            );
        });
    });

    describe("auth flow", () => {
        it("pollDeviceAuth returns token payload on success", async () => {
            const tokenPayload = {
                access_token: "access",
                refresh_token: "refresh",
                token_type: "Bearer",
                expires_in: 3600,
                user_id: "uid",
                country_code: "US",
                username: "listener",
            };
            mockClient.post.mockResolvedValueOnce({ data: tokenPayload });

            await expect(tidalService.pollDeviceAuth("device-code")).resolves.toEqual(
                tokenPayload
            );
            expect(mockClient.post).toHaveBeenCalledWith("/auth/token", {
                device_code: "device-code",
            });
        });

        it("pollDeviceAuth returns null while authorization is pending (HTTP 428)", async () => {
            mockClient.post.mockRejectedValueOnce({ response: { status: 428 } });

            await expect(tidalService.pollDeviceAuth("device-code")).resolves.toBeNull();
        });

        it("verifySession returns valid=true for a valid session", async () => {
            jest.spyOn(tidalService as any, "getCredentials").mockResolvedValue(baseCreds);
            mockClient.post.mockResolvedValueOnce({
                data: { user_id: "tidal-user", country_code: "SE" },
            });

            await expect(tidalService.verifySession()).resolves.toEqual({
                valid: true,
                userId: "tidal-user",
                countryCode: "SE",
            });
            expect(mockClient.post).toHaveBeenCalledWith("/auth/session", {
                access_token: "access-token",
                user_id: "user-1",
                country_code: "US",
            });
        });

        it("verifySession refreshes token and retries once after 401", async () => {
            const getCredentialsSpy = jest
                .spyOn(tidalService as any, "getCredentials")
                .mockResolvedValue(baseCreds);
            const refreshSpy = jest
                .spyOn(tidalService, "refreshAccessToken")
                .mockResolvedValue(true);
            mockClient.post
                .mockRejectedValueOnce({ response: { status: 401 } })
                .mockResolvedValueOnce({
                    data: { user_id: "refreshed-user", country_code: "DK" },
                });

            await expect(tidalService.verifySession()).resolves.toEqual({
                valid: true,
                userId: "refreshed-user",
                countryCode: "DK",
            });
            expect(refreshSpy).toHaveBeenCalledTimes(1);
            expect(getCredentialsSpy).toHaveBeenCalledTimes(2);
            expect(mockClient.post).toHaveBeenCalledTimes(2);
        });
    });

    describe("search", () => {
        it("search succeeds with encoded credential query params", async () => {
            const creds = {
                ...baseCreds,
                accessToken: "access token/+",
                userId: "user/one",
            };
            const searchData = { tracks: [{ id: 1 }], albums: [], artists: [] };
            jest.spyOn(tidalService as any, "getCredentials").mockResolvedValue(creds);
            mockClient.post.mockResolvedValueOnce({ data: searchData });

            await expect(tidalService.search("nujabes")).resolves.toEqual(searchData);
            expect(mockClient.post).toHaveBeenCalledWith(
                `/search?access_token=${encodeURIComponent(
                    creds.accessToken
                )}&user_id=${encodeURIComponent(
                    creds.userId
                )}&country_code=${encodeURIComponent(creds.countryCode)}`,
                { query: "nujabes" }
            );
        });

        it("search refreshes token and retries after 401", async () => {
            jest.spyOn(tidalService as any, "getCredentials").mockResolvedValue(baseCreds);
            const refreshSpy = jest
                .spyOn(tidalService, "refreshAccessToken")
                .mockResolvedValue(true);
            mockClient.post
                .mockRejectedValueOnce({ response: { status: 401 } })
                .mockResolvedValueOnce({
                    data: { tracks: [], albums: [{ id: 7 }], artists: [] },
                });

            await expect(tidalService.search("retry me")).resolves.toEqual({
                tracks: [],
                albums: [{ id: 7 }],
                artists: [],
            });
            expect(refreshSpy).toHaveBeenCalledTimes(1);
            expect(mockClient.post).toHaveBeenCalledTimes(2);
        });

        it("search throws unauthenticated error when credentials are missing", async () => {
            jest.spyOn(tidalService as any, "getCredentials").mockResolvedValue(null);

            await expect(tidalService.search("anything")).rejects.toThrow(
                "TIDAL not authenticated"
            );
            expect(mockClient.post).not.toHaveBeenCalled();
        });
    });

    describe("findAlbum", () => {
        it("prefers exact normalized album+artist match over weaker candidates", async () => {
            jest.spyOn(tidalService, "search").mockResolvedValue({
                tracks: [],
                artists: [],
                albums: [
                    {
                        id: 11,
                        title: "Great Album Deluxe Edition",
                        artist: "Wrong Artist",
                        numberOfTracks: 10,
                        releaseDate: null,
                        type: "ALBUM",
                        quality: "HIGH",
                        cover: null,
                    },
                    {
                        id: 22,
                        title: "Great Album (Deluxe Edition)",
                        artist: "Artist Name",
                        numberOfTracks: 12,
                        releaseDate: null,
                        type: "ALBUM",
                        quality: "LOSSLESS",
                        cover: null,
                    },
                ],
            });

            await expect(
                tidalService.findAlbum("Artist Name", "Great Album - Deluxe Edition")
            ).resolves.toEqual({
                albumId: 22,
                title: "Great Album (Deluxe Edition)",
                artist: "Artist Name",
                numberOfTracks: 12,
            });
        });

        it("returns first album as fallback when there is no normalized title match", async () => {
            jest.spyOn(tidalService, "search").mockResolvedValue({
                tracks: [],
                artists: [],
                albums: [
                    {
                        id: 101,
                        title: "Unexpected Pick",
                        artist: "Artist A",
                        numberOfTracks: 8,
                        releaseDate: null,
                        type: "EP",
                        quality: "HIGH",
                        cover: null,
                    },
                    {
                        id: 202,
                        title: "Another Record",
                        artist: "Artist B",
                        numberOfTracks: 11,
                        releaseDate: null,
                        type: "ALBUM",
                        quality: "HIGH",
                        cover: null,
                    },
                ],
            });

            await expect(
                tidalService.findAlbum("Different Artist", "Nonexistent Title")
            ).resolves.toEqual({
                albumId: 101,
                title: "Unexpected Pick",
                artist: "Artist A",
                numberOfTracks: 8,
            });
        });

        it("returns null and logs when album search throws", async () => {
            jest.spyOn(tidalService, "search").mockRejectedValue(new Error("search down"));

            await expect(tidalService.findAlbum("A", "B")).resolves.toBeNull();
            expect(mockLogger.error).toHaveBeenCalledWith(
                "[TIDAL] Album search failed:",
                "search down"
            );
        });
    });

    describe("downloadTrack", () => {
        it("downloads a track with quality and output template from credentials", async () => {
            jest.spyOn(tidalService as any, "getCredentials").mockResolvedValue(baseCreds);
            const downloadResult = {
                track_id: 9001,
                title: "Track",
                artist: "Artist",
                album: "Album",
                quality: "LOSSLESS",
                file_path: "/music/Artist/Track.flac",
                relative_path: "Artist/Track.flac",
                file_size: 12345,
            };
            mockClient.post.mockResolvedValueOnce({ data: downloadResult });

            await expect(tidalService.downloadTrack(9001)).resolves.toEqual(downloadResult);
            expect(mockClient.post).toHaveBeenCalledWith(
                `/download/track?access_token=${encodeURIComponent(
                    baseCreds.accessToken
                )}&user_id=${encodeURIComponent(
                    baseCreds.userId
                )}&country_code=${encodeURIComponent(baseCreds.countryCode)}`,
                {
                    track_id: 9001,
                    quality: "LOSSLESS",
                    output_template: "{album.artist}/{item.title}",
                }
            );
        });

        it("refreshes token and retries downloadTrack once after 401", async () => {
            jest.spyOn(tidalService as any, "getCredentials").mockResolvedValue(baseCreds);
            const refreshSpy = jest
                .spyOn(tidalService, "refreshAccessToken")
                .mockResolvedValue(true);
            const retriedPayload = {
                track_id: 22,
                title: "Retried Track",
                artist: "Artist",
                album: "Album",
                quality: "HIGH",
                file_path: "/music/file",
                relative_path: "file",
                file_size: 42,
            };
            mockClient.post
                .mockRejectedValueOnce({ response: { status: 401 } })
                .mockResolvedValueOnce({ data: retriedPayload });

            await expect(tidalService.downloadTrack(22)).resolves.toEqual(retriedPayload);
            expect(refreshSpy).toHaveBeenCalledTimes(1);
            expect(mockClient.post).toHaveBeenCalledTimes(2);
        });

        it("throws unauthenticated error when downloadTrack has no credentials", async () => {
            jest.spyOn(tidalService as any, "getCredentials").mockResolvedValue(null);

            await expect(tidalService.downloadTrack(5)).rejects.toThrow(
                "TIDAL not authenticated"
            );
            expect(mockClient.post).not.toHaveBeenCalled();
        });
    });

    describe("downloadAlbum", () => {
        it("downloads an album with quality and output template from credentials", async () => {
            jest.spyOn(tidalService as any, "getCredentials").mockResolvedValue(baseCreds);
            const albumPayload = {
                album_id: 77,
                album_title: "Album",
                artist: "Artist",
                total_tracks: 2,
                downloaded: 2,
                failed: 0,
                tracks: [],
                errors: [],
            };
            mockClient.post.mockResolvedValueOnce({ data: albumPayload });

            await expect(tidalService.downloadAlbum(77)).resolves.toEqual(albumPayload);
            expect(mockClient.post).toHaveBeenCalledWith(
                `/download/album?access_token=${encodeURIComponent(
                    baseCreds.accessToken
                )}&user_id=${encodeURIComponent(
                    baseCreds.userId
                )}&country_code=${encodeURIComponent(baseCreds.countryCode)}`,
                {
                    album_id: 77,
                    quality: "LOSSLESS",
                    output_template: "{album.artist}/{item.title}",
                }
            );
        });

        it("refreshes token and retries downloadAlbum once after 401", async () => {
            jest.spyOn(tidalService as any, "getCredentials").mockResolvedValue(baseCreds);
            const refreshSpy = jest
                .spyOn(tidalService, "refreshAccessToken")
                .mockResolvedValue(true);
            const retriedAlbumPayload = {
                album_id: 88,
                album_title: "Retried Album",
                artist: "Artist",
                total_tracks: 1,
                downloaded: 1,
                failed: 0,
                tracks: [],
                errors: [],
            };
            mockClient.post
                .mockRejectedValueOnce({ response: { status: 401 } })
                .mockResolvedValueOnce({ data: retriedAlbumPayload });

            await expect(tidalService.downloadAlbum(88)).resolves.toEqual(
                retriedAlbumPayload
            );
            expect(refreshSpy).toHaveBeenCalledTimes(1);
            expect(mockClient.post).toHaveBeenCalledTimes(2);
        });

        it("throws unauthenticated error when downloadAlbum has no credentials", async () => {
            jest.spyOn(tidalService as any, "getCredentials").mockResolvedValue(null);

            await expect(tidalService.downloadAlbum(9)).rejects.toThrow(
                "TIDAL not authenticated"
            );
            expect(mockClient.post).not.toHaveBeenCalled();
        });
    });
});
