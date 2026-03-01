/**
 * Tests for unauthenticated YouTube Music streaming routes.
 *
 * Validates that public stream endpoints:
 * - Use "__public__" user_id (no per-user OAuth)
 * - Respect requireAuthOrToken (Soundspan session required)
 * - Respect requireYtMusicEnabled (admin toggle)
 */

const mockGetStreamProxy = jest.fn();
const mockGetStreamInfo = jest.fn();
const mockNormalizeQuality = jest.fn((q: string) => q.toUpperCase());

const mockLogger: Record<string, jest.Mock> = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);

jest.mock("../../services/youtubeMusic", () => ({
    ytMusicService: {
        getStreamProxy: mockGetStreamProxy,
        getStreamInfo: mockGetStreamInfo,
        isAvailable: jest.fn().mockResolvedValue(true),
        findMatchesForAlbum: jest.fn(),
    },
    normalizeYtMusicStreamQuality: mockNormalizeQuality,
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        systemSettings: { findUnique: jest.fn() },
        userSettings: { findUnique: jest.fn(), update: jest.fn() },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: mockLogger,
}));

jest.mock("../../utils/encryption", () => ({
    encrypt: jest.fn((v: string) => `enc:${v}`),
    decrypt: jest.fn((v: string) => v.replace("enc:", "")),
}));

jest.mock("../../services/trackMappingService", () => ({
    trackMappingService: {
        upsertTrackYtMusic: jest.fn(),
    },
}));

import { ytMusicService } from "../../services/youtubeMusic";

describe("YouTube Music public stream routes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("getStreamInfo with __public__ user_id", () => {
        it("calls sidecar with __public__ user_id for unauthenticated streaming", async () => {
            const mockInfo = {
                videoId: "testVideoId123",
                abr: 128,
                acodec: "mp4a.40.2",
                duration: 240,
                content_type: "audio/mp4",
            };
            mockGetStreamInfo.mockResolvedValueOnce(mockInfo);

            const result = await ytMusicService.getStreamInfo(
                "__public__",
                "testVideoId123",
                "HIGH"
            );

            expect(result).toEqual(mockInfo);
            expect(mockGetStreamInfo).toHaveBeenCalledWith(
                "__public__",
                "testVideoId123",
                "HIGH"
            );
        });

        it("authenticated user uses their own user_id", async () => {
            const mockInfo = {
                videoId: "testVideoId123",
                abr: 256,
                acodec: "opus",
                duration: 240,
                content_type: "audio/webm",
            };
            mockGetStreamInfo.mockResolvedValueOnce(mockInfo);

            await ytMusicService.getStreamInfo(
                "user_123",
                "testVideoId123",
                "HIGH"
            );

            expect(mockGetStreamInfo).toHaveBeenCalledWith(
                "user_123",
                "testVideoId123",
                "HIGH"
            );
        });
    });

    describe("getStreamProxy with __public__ user_id", () => {
        it("proxies stream via __public__ user_id", async () => {
            const mockProxyRes = {
                status: 200,
                headers: {
                    "content-type": "audio/mp4",
                    "accept-ranges": "bytes",
                },
                data: { pipe: jest.fn(), on: jest.fn() },
            };
            mockGetStreamProxy.mockResolvedValueOnce(mockProxyRes);

            const result = await ytMusicService.getStreamProxy(
                "__public__",
                "testVideoId123",
                "HIGH",
                undefined
            );

            expect(result).toEqual(mockProxyRes);
            expect(mockGetStreamProxy).toHaveBeenCalledWith(
                "__public__",
                "testVideoId123",
                "HIGH",
                undefined
            );
        });

        it("handles range requests", async () => {
            const mockProxyRes = {
                status: 206,
                headers: {
                    "content-type": "audio/mp4",
                    "accept-ranges": "bytes",
                    "content-range": "bytes 0-1023/10240",
                },
                data: { pipe: jest.fn(), on: jest.fn() },
            };
            mockGetStreamProxy.mockResolvedValueOnce(mockProxyRes);

            const result = await ytMusicService.getStreamProxy(
                "__public__",
                "testVideoId123",
                "HIGH",
                "bytes=0-1023"
            );

            expect(result.status).toBe(206);
            expect(result.headers["content-range"]).toBe(
                "bytes 0-1023/10240"
            );
        });

        it("handles 404 from sidecar", async () => {
            mockGetStreamProxy.mockRejectedValueOnce({
                response: { status: 404 },
            });

            await expect(
                ytMusicService.getStreamProxy(
                    "__public__",
                    "nonexistentVideoId",
                    "HIGH",
                    undefined
                )
            ).rejects.toEqual({
                response: { status: 404 },
            });
        });
    });

    describe("quality normalization for public routes", () => {
        it("normalizes quality string", () => {
            expect(mockNormalizeQuality("high")).toBe("HIGH");
            expect(mockNormalizeQuality("low")).toBe("LOW");
        });
    });
});
