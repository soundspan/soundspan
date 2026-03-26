import { logger } from "../../utils/logger";
import type {
    RemoteTrackLookup,
    RemoteTrackMetadataInput,
} from "../remoteTrackMetadataResolver";
import {
    hasPlaceholderRemoteTrackMetadata,
    resolveRemoteTrackMetadataForRequest,
} from "../remoteTrackMetadataResolver";

jest.mock("../../utils/logger", () => ({
    logger: (() => {
        const child = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };

        return {
            child: jest.fn(() => child),
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            __childLogger: child,
        };
    })(),
}));

const mockedLogger = logger as unknown as {
    child: jest.Mock;
    debug: jest.Mock;
    info: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
    __childLogger: {
        debug: jest.Mock;
        info: jest.Mock;
        warn: jest.Mock;
        error: jest.Mock;
    };
};

const mockTidalGetTrack = jest.fn();
jest.mock("../tidalStreaming", () => ({
    tidalStreamingService: { getTrack: mockTidalGetTrack },
}));

const mockYtGetSong = jest.fn();
jest.mock("../youtubeMusic", () => ({
    ytMusicService: { getSong: mockYtGetSong },
}));

describe("remoteTrackMetadataResolver", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockTidalGetTrack.mockReset();
        mockYtGetSong.mockReset();
    });

    describe("hasPlaceholderRemoteTrackMetadata", () => {
        it("returns true for missing/non-string metadata fields", () => {
            const metadata = {
                title: "Real Title",
                artist: "Real Artist",
                album: 123,
            } as unknown as RemoteTrackMetadataInput;

            expect(hasPlaceholderRemoteTrackMetadata(metadata)).toBe(true);
        });

        it("returns true for title placeholders", () => {
            expect(
                hasPlaceholderRemoteTrackMetadata({
                    title: "  Unknown Track  ",
                    artist: "Artist",
                    album: "Album",
                })
            ).toBe(true);
            expect(
                hasPlaceholderRemoteTrackMetadata({
                    title: "",
                    artist: "Artist",
                    album: "Album",
                })
            ).toBe(true);
        });

        it("returns true for artist placeholders", () => {
            expect(
                hasPlaceholderRemoteTrackMetadata({
                    title: "Title",
                    artist: " unknown artist ",
                    album: "Album",
                })
            ).toBe(true);
            expect(
                hasPlaceholderRemoteTrackMetadata({
                    title: "Title",
                    artist: "Unknown",
                    album: "Album",
                })
            ).toBe(true);
        });

        it("returns true for album placeholders", () => {
            expect(
                hasPlaceholderRemoteTrackMetadata({
                    title: "Title",
                    artist: "Artist",
                    album: "  single  ",
                })
            ).toBe(true);
            expect(
                hasPlaceholderRemoteTrackMetadata({
                    title: "Title",
                    artist: "Artist",
                    album: "Unknown Album",
                })
            ).toBe(true);
        });

        it("returns false for fully-real metadata", () => {
            expect(
                hasPlaceholderRemoteTrackMetadata({
                    title: "Track Name",
                    artist: "Artist Name",
                    album: "Album Name",
                })
            ).toBe(false);
        });
    });

    describe("resolveRemoteTrackMetadataForRequest", () => {
        it("returns normalized request metadata when not placeholder", async () => {
            const lookup: RemoteTrackLookup = {
                provider: "tidal",
                userId: "user-1",
                tidalId: 1,
                metadata: {
                    title: "  Title  ",
                    artist: "  Artist  ",
                    album: "  Album  ",
                    duration: 215.8,
                    thumbnailUrl: "  https://img.local/thumb.jpg  ",
                    isrc: "  US-S1Z-99-00001  ",
                    quality: "  LOSSLESS  ",
                    explicit: false,
                },
            };

            const resolved = await resolveRemoteTrackMetadataForRequest(lookup);

            expect(resolved).toEqual({
                title: "Title",
                artist: "Artist",
                album: "Album",
                duration: 215,
                thumbnailUrl: "https://img.local/thumb.jpg",
                isrc: "US-S1Z-99-00001",
                quality: "LOSSLESS",
                explicit: false,
            });
            expect(mockTidalGetTrack).not.toHaveBeenCalled();
        });

        it("normalizes placeholders to defaults and ignores invalid optional fields", async () => {
            const metadata = {
                title: "   ",
                artist: "",
                album: "unknown",
                duration: Number.NaN,
                thumbnailUrl: "   ",
                isrc: 777,
                quality: null,
                explicit: "yes",
            } as unknown as RemoteTrackMetadataInput;

            const lookup: RemoteTrackLookup = {
                provider: "tidal",
                userId: "user-1",
                metadata,
            };

            const resolved = await resolveRemoteTrackMetadataForRequest(lookup);

            expect(resolved).toEqual({
                title: "Unknown",
                artist: "Unknown",
                album: "unknown",
                duration: 180,
                thumbnailUrl: undefined,
                isrc: undefined,
                quality: undefined,
                explicit: undefined,
            });
        });

        it("returns normalized metadata for placeholder tidal request with invalid tidalId", async () => {
            const lookup: RemoteTrackLookup = {
                provider: "tidal",
                userId: "user-1",
                tidalId: 0,
                metadata: {
                    title: "Unknown",
                    artist: "Unknown Artist",
                    album: "Unknown Album",
                    duration: Infinity,
                },
            };

            const resolved = await resolveRemoteTrackMetadataForRequest(lookup);

            expect(resolved).toEqual({
                title: "Unknown",
                artist: "Unknown Artist",
                album: "Unknown Album",
                duration: 180,
                thumbnailUrl: undefined,
                isrc: undefined,
                quality: undefined,
                explicit: undefined,
            });
            expect(mockTidalGetTrack).not.toHaveBeenCalled();
        });

        it("returns normalized metadata when tidal detail is null", async () => {
            mockTidalGetTrack.mockResolvedValueOnce(null);

            const lookup: RemoteTrackLookup = {
                provider: "tidal",
                userId: "user-2",
                tidalId: 888.7,
                metadata: {
                    title: "Unknown",
                    artist: "Unknown",
                    album: "Single",
                    duration: 0,
                },
            };

            const resolved = await resolveRemoteTrackMetadataForRequest(lookup);

            expect(mockTidalGetTrack).toHaveBeenCalledWith("user-2", 888);
            expect(resolved).toEqual({
                title: "Unknown",
                artist: "Unknown",
                album: "Single",
                duration: 180,
                thumbnailUrl: undefined,
                isrc: undefined,
                quality: undefined,
                explicit: undefined,
            });
        });

        it("updates only non-placeholder fields from tidal detail", async () => {
            mockTidalGetTrack.mockResolvedValueOnce({
                title: "Unknown Track",
                artist: "  Resolved Artist  ",
                album: { title: "Unknown Album" },
                duration: -12,
                isrc: "   ",
                explicit: "no",
            });

            const lookup: RemoteTrackLookup = {
                provider: "tidal",
                userId: "user-3",
                tidalId: 44,
                metadata: {
                    title: "Unknown",
                    artist: "Unknown",
                    album: "Unknown",
                    duration: 222,
                    explicit: true,
                },
            };

            const resolved = await resolveRemoteTrackMetadataForRequest(lookup);

            expect(resolved).toEqual({
                title: "Unknown",
                artist: "  Resolved Artist  ",
                album: "Unknown",
                duration: 222,
                thumbnailUrl: undefined,
                isrc: undefined,
                quality: undefined,
                explicit: true,
            });
        });

        it("overwrites metadata from valid tidal detail fields", async () => {
            mockTidalGetTrack.mockResolvedValueOnce({
                title: "Resolved Title",
                artist: "Resolved Artist",
                album: { title: "Resolved Album" },
                duration: 301.99,
                isrc: "  QZ5AB1234567  ",
                explicit: false,
            });

            const lookup: RemoteTrackLookup = {
                provider: "tidal",
                userId: "user-4",
                tidalId: 777,
                metadata: {
                    title: "Unknown",
                    artist: "Unknown",
                    album: "Unknown",
                    duration: -3,
                },
            };

            const resolved = await resolveRemoteTrackMetadataForRequest(lookup);

            expect(resolved).toEqual({
                title: "Resolved Title",
                artist: "Resolved Artist",
                album: "Resolved Album",
                duration: 301,
                thumbnailUrl: undefined,
                isrc: "QZ5AB1234567",
                quality: undefined,
                explicit: false,
            });
        });

        it("returns resolved metadata and logs warning when tidal provider throws", async () => {
            const providerError = new Error("tidal unavailable");
            mockTidalGetTrack.mockRejectedValueOnce(providerError);

            const lookup: RemoteTrackLookup = {
                provider: "tidal",
                userId: "user-5",
                tidalId: 111,
                metadata: {
                    title: "Unknown",
                    artist: "Unknown",
                    album: "Unknown",
                    duration: 0,
                },
            };

            const resolved = await resolveRemoteTrackMetadataForRequest(lookup);

            expect(resolved).toEqual({
                title: "Unknown",
                artist: "Unknown",
                album: "Unknown",
                duration: 180,
                thumbnailUrl: undefined,
                isrc: undefined,
                quality: undefined,
                explicit: undefined,
            });
            expect(mockedLogger.__childLogger.warn).toHaveBeenCalledWith(
                "Failed to resolve inline metadata for tidal track",
                providerError
            );
        });

        it("returns normalized metadata for youtube request missing videoId", async () => {
            const lookup: RemoteTrackLookup = {
                provider: "youtube",
                userId: "user-6",
                videoId: "   ",
                metadata: {
                    title: "Unknown",
                    artist: "Unknown Artist",
                    album: "Unknown Album",
                },
            };

            const resolved = await resolveRemoteTrackMetadataForRequest(lookup);

            expect(resolved).toEqual({
                title: "Unknown",
                artist: "Unknown Artist",
                album: "Unknown Album",
                duration: 180,
                thumbnailUrl: undefined,
                isrc: undefined,
                quality: undefined,
                explicit: undefined,
            });
            expect(mockYtGetSong).not.toHaveBeenCalled();
        });

        it("returns normalized metadata when both youtube lookups return null", async () => {
            mockYtGetSong.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

            const lookup: RemoteTrackLookup = {
                provider: "youtube",
                userId: "user-7",
                videoId: "abc123",
                metadata: {
                    title: "Unknown",
                    artist: "Unknown",
                    album: "Unknown",
                    duration: 0,
                },
            };

            const resolved = await resolveRemoteTrackMetadataForRequest(lookup);

            expect(mockYtGetSong).toHaveBeenNthCalledWith(1, "user-7", "abc123");
            expect(mockYtGetSong).toHaveBeenNthCalledWith(2, "__public__", "abc123");
            expect(resolved).toEqual({
                title: "Unknown",
                artist: "Unknown",
                album: "Unknown",
                duration: 180,
                thumbnailUrl: undefined,
                isrc: undefined,
                quality: undefined,
                explicit: undefined,
            });
        });

        it("falls back to __public__ when primary youtube lookup throws", async () => {
            const lookupError = new Error("auth token expired");
            mockYtGetSong
                .mockRejectedValueOnce(lookupError)
                .mockResolvedValueOnce({
                    title: "Real YT Title",
                    artist: "Real YT Artist",
                    album: "Real YT Album",
                    duration: 190.6,
                    thumbnails: [
                        1,
                        null,
                        { foo: "bar" },
                        { url: "   " },
                        { url: "https://img.local/small.jpg" },
                        { url: " https://img.local/large.jpg " },
                    ],
                });

            const resolved = await resolveRemoteTrackMetadataForRequest({
                provider: "youtube",
                userId: "user-8",
                videoId: "video-8",
                metadata: {
                    title: "Unknown",
                    artist: "Unknown",
                    album: "Unknown",
                },
            });

            expect(mockedLogger.__childLogger.debug).toHaveBeenCalledWith(
                "Falling back to __public__ YT metadata lookup for videoId=video-8",
                lookupError
            );
            expect(mockYtGetSong).toHaveBeenNthCalledWith(1, "user-8", "video-8");
            expect(mockYtGetSong).toHaveBeenNthCalledWith(2, "__public__", "video-8");
            expect(resolved).toEqual({
                title: "Real YT Title",
                artist: "Real YT Artist",
                album: "Real YT Album",
                duration: 190,
                thumbnailUrl: "https://img.local/large.jpg",
                isrc: undefined,
                quality: undefined,
                explicit: undefined,
            });
        });

        it("keeps existing thumbnail and ignores placeholder youtube fields", async () => {
            mockYtGetSong.mockResolvedValueOnce({
                title: "unknown track",
                artist: " unknown ",
                album: "single",
                duration: 0,
                thumbnails: [],
            });

            const resolved = await resolveRemoteTrackMetadataForRequest({
                provider: "youtube",
                userId: "user-9",
                videoId: "video-9",
                metadata: {
                    title: "Unknown",
                    artist: "Unknown",
                    album: "Unknown",
                    thumbnailUrl: "https://existing.local/thumb.jpg",
                    duration: 210,
                    explicit: true,
                },
            });

            expect(resolved).toEqual({
                title: "Unknown",
                artist: "Unknown",
                album: "Unknown",
                duration: 210,
                thumbnailUrl: "https://existing.local/thumb.jpg",
                isrc: undefined,
                quality: undefined,
                explicit: true,
            });
        });

        it("returns resolved metadata and logs warning when youtube fallback throws", async () => {
            const fallbackError = new Error("public lookup failed");
            mockYtGetSong
                .mockResolvedValueOnce(null)
                .mockRejectedValueOnce(fallbackError);

            const resolved = await resolveRemoteTrackMetadataForRequest({
                provider: "youtube",
                userId: "user-10",
                videoId: "video-10",
                metadata: {
                    title: "Unknown",
                    artist: "Unknown",
                    album: "Unknown",
                },
            });

            expect(mockedLogger.__childLogger.warn).toHaveBeenCalledWith(
                "Failed to resolve inline metadata for youtube track",
                fallbackError
            );
            expect(resolved).toEqual({
                title: "Unknown",
                artist: "Unknown",
                album: "Unknown",
                duration: 180,
                thumbnailUrl: undefined,
                isrc: undefined,
                quality: undefined,
                explicit: undefined,
            });
        });
    });

    describe("logger child fallback initialization", () => {
        it("uses base logger when child is not a function", async () => {
            jest.resetModules();

            const fallbackWarn = jest.fn();
            const fallbackDebug = jest.fn();

            jest.doMock("../../utils/logger", () => ({
                logger: {
                    child: "not-a-function",
                    debug: fallbackDebug,
                    info: jest.fn(),
                    warn: fallbackWarn,
                    error: jest.fn(),
                },
            }));
            jest.doMock("../tidalStreaming", () => ({
                tidalStreamingService: { getTrack: jest.fn() },
            }));
            jest.doMock("../youtubeMusic", () => ({
                ytMusicService: {
                    getSong: jest
                        .fn()
                        .mockResolvedValueOnce(null)
                        .mockRejectedValueOnce(new Error("explode")),
                },
            }));

            const isolatedModule = await import("../remoteTrackMetadataResolver");

            const resolved =
                await isolatedModule.resolveRemoteTrackMetadataForRequest({
                    provider: "youtube",
                    userId: "user-no-child",
                    videoId: "video-no-child",
                    metadata: {
                        title: "Unknown",
                        artist: "Unknown",
                        album: "Unknown",
                    },
                });

            expect(resolved).toEqual({
                title: "Unknown",
                artist: "Unknown",
                album: "Unknown",
                duration: 180,
                thumbnailUrl: undefined,
                isrc: undefined,
                quality: undefined,
                explicit: undefined,
            });
            expect(fallbackWarn).toHaveBeenCalledWith(
                "Failed to resolve inline metadata for youtube track",
                expect.any(Error)
            );
            expect(fallbackDebug).not.toHaveBeenCalled();
        });
    });
});
