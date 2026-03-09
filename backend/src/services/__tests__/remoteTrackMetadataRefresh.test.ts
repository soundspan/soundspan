const mockPrisma = {
    trackTidal: {
        findMany: jest.fn(),
        update: jest.fn(),
    },
    trackYtMusic: {
        findMany: jest.fn(),
        update: jest.fn(),
    },
    userSettings: {
        findMany: jest.fn(),
    },
};

const mockLogger: Record<string, jest.Mock> = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);

jest.mock("../../utils/db", () => ({ prisma: mockPrisma }));
jest.mock("../../utils/logger", () => ({ logger: mockLogger }));

const mockTidalGetTrack = jest.fn();
jest.mock("../tidalStreaming", () => ({
    tidalStreamingService: { getTrack: mockTidalGetTrack },
}));

const mockYtGetSong = jest.fn();
jest.mock("../youtubeMusic", () => ({
    ytMusicService: { getSong: mockYtGetSong },
}));

import { remoteTrackMetadataRefreshService } from "../remoteTrackMetadataRefresh";

describe("RemoteTrackMetadataRefreshService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockTidalGetTrack.mockReset();
        mockYtGetSong.mockReset();
        mockPrisma.trackTidal.findMany.mockReset().mockResolvedValue([]);
        mockPrisma.trackTidal.update.mockReset();
        mockPrisma.trackYtMusic.findMany.mockReset().mockResolvedValue([]);
        mockPrisma.trackYtMusic.update.mockReset();
        mockPrisma.userSettings.findMany.mockReset().mockResolvedValue([]);
    });

    describe("refreshUnknownMetadata", () => {
        it("returns zero counts when no unknown rows exist", async () => {
            const result = await remoteTrackMetadataRefreshService.refreshUnknownMetadata();
            expect(result).toEqual({ updated: 0, failed: 0 });
        });

        it("refreshes TrackTidal rows with Unknown metadata", async () => {
            mockPrisma.trackTidal.findMany.mockResolvedValueOnce([
                { id: "tt-1", tidalId: 12345, likedBy: [] },
            ]);
            mockPrisma.userSettings.findMany.mockResolvedValueOnce([
                { userId: "user-1", tidalOAuthJson: "{}" },
            ]);
            mockTidalGetTrack.mockResolvedValueOnce({
                id: 12345,
                title: "Real Title",
                artist: "Real Artist",
                duration: 240,
                album: { title: "Real Album" },
            });

            const result = await remoteTrackMetadataRefreshService.refreshUnknownMetadata();

            expect(result.updated).toBe(1);
            expect(mockPrisma.trackTidal.update).toHaveBeenCalledWith({
                where: { id: "tt-1" },
                data: expect.objectContaining({
                    title: "Real Title",
                    artist: "Real Artist",
                    album: "Real Album",
                    duration: 240,
                }),
            });
        });

        it("falls back to a later Tidal-authenticated user when the first user returns no metadata", async () => {
            mockPrisma.trackTidal.findMany.mockResolvedValueOnce([
                {
                    id: "tt-fallback",
                    tidalId: 69778330,
                    likedBy: [{ userId: "user-2" }],
                },
            ]);
            mockPrisma.userSettings.findMany.mockResolvedValueOnce([
                { userId: "user-1", tidalOAuthJson: "{}" },
                { userId: "user-2", tidalOAuthJson: "{}" },
            ]);
            mockTidalGetTrack
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({
                    id: 69778330,
                    title: "Blinded By The Light",
                    artist: "Manfred Mann's Earth Band",
                    duration: 428,
                    album: { title: "The Roaring Silence" },
                });

            const result = await remoteTrackMetadataRefreshService.refreshUnknownMetadata();

            expect(result).toEqual({ updated: 1, failed: 0 });
            expect(mockTidalGetTrack).toHaveBeenNthCalledWith(
                1,
                "user-2",
                69778330
            );
            expect(mockPrisma.trackTidal.update).toHaveBeenCalledWith({
                where: { id: "tt-fallback" },
                data: expect.objectContaining({
                    title: "Blinded By The Light",
                    artist: "Manfred Mann's Earth Band",
                    album: "The Roaring Silence",
                    duration: 428,
                }),
            });
        });

        it("refreshes TrackYtMusic rows with Unknown metadata", async () => {
            mockPrisma.trackYtMusic.findMany.mockResolvedValueOnce([
                { id: "yt-1", videoId: "abc123" },
            ]);
            mockYtGetSong.mockResolvedValueOnce({
                videoId: "abc123",
                title: "Real YT Title",
                artist: "Real YT Artist",
                album: "Real YT Album",
                duration: 180,
                thumbnails: [{ url: "https://example.com/thumb.jpg" }],
            });

            const result = await remoteTrackMetadataRefreshService.refreshUnknownMetadata();

            expect(result.updated).toBe(1);
            expect(mockPrisma.trackYtMusic.update).toHaveBeenCalledWith({
                where: { id: "yt-1" },
                data: expect.objectContaining({
                    title: "Real YT Title",
                    artist: "Real YT Artist",
                    album: "Real YT Album",
                    duration: 180,
                }),
            });
        });

        it("queries album placeholders for both providers", async () => {
            await remoteTrackMetadataRefreshService.refreshUnknownMetadata();

            expect(mockPrisma.trackTidal.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        OR: expect.arrayContaining([
                            { album: { in: expect.arrayContaining(["Unknown Album", "single"]) } },
                        ]),
                    }),
                })
            );
            expect(mockPrisma.trackYtMusic.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        OR: expect.arrayContaining([
                            { album: { in: expect.arrayContaining(["Unknown Album", "single"]) } },
                        ]),
                    }),
                })
            );
        });

        it("skips tidal refresh when no authenticated user found and counts as failed", async () => {
            mockPrisma.trackTidal.findMany.mockResolvedValueOnce([
                { id: "tt-1", tidalId: 12345, likedBy: [] },
            ]);
            mockPrisma.userSettings.findMany.mockResolvedValueOnce([]);

            const result = await remoteTrackMetadataRefreshService.refreshUnknownMetadata();

            expect(result.updated).toBe(0);
            expect(result.failed).toBe(1);
            expect(mockTidalGetTrack).not.toHaveBeenCalled();
        });

        it("only writes real fields from partial API response", async () => {
            mockPrisma.trackTidal.findMany.mockResolvedValueOnce([
                { id: "tt-partial", tidalId: 99999, likedBy: [] },
            ]);
            mockPrisma.userSettings.findMany.mockResolvedValueOnce([
                { userId: "user-1", tidalOAuthJson: "{}" },
            ]);
            mockTidalGetTrack.mockResolvedValueOnce({
                id: 99999,
                title: "Real Title",
                artist: "Real Artist",
                duration: 240,
                album: { title: "Unknown" },
            });

            const result = await remoteTrackMetadataRefreshService.refreshUnknownMetadata();

            expect(result.updated).toBe(1);
            const updateCall = mockPrisma.trackTidal.update.mock.calls[0][0];
            expect(updateCall.data.title).toBe("Real Title");
            expect(updateCall.data.artist).toBe("Real Artist");
            expect(updateCall.data.duration).toBe(240);
            expect(updateCall.data.album).toBeUndefined();
        });

        it("refreshes YT metadata via __public__ when no auth user is present", async () => {
            mockPrisma.trackYtMusic.findMany.mockResolvedValueOnce([
                { id: "yt-1", videoId: "v1" },
            ]);
            mockYtGetSong.mockResolvedValueOnce({
                videoId: "v1",
                title: "Public Title",
                artist: "Public Artist",
                album: "Public Album",
                duration: 211,
            });

            const result = await remoteTrackMetadataRefreshService.refreshUnknownMetadata();

            expect(mockYtGetSong).toHaveBeenCalledWith("__public__", "v1");
            expect(result).toEqual({ updated: 1, failed: 0 });
        });

        it("counts failures when every Tidal credential returns null", async () => {
            mockPrisma.trackTidal.findMany.mockResolvedValueOnce([
                { id: "tt-1", tidalId: 12345, likedBy: [] },
            ]);
            mockPrisma.userSettings.findMany.mockResolvedValueOnce([
                { userId: "user-1", tidalOAuthJson: "{}" },
            ]);
            mockTidalGetTrack.mockResolvedValueOnce(null);

            const result = await remoteTrackMetadataRefreshService.refreshUnknownMetadata();

            expect(result.updated).toBe(0);
            expect(result.failed).toBe(1);
            expect(mockPrisma.trackTidal.update).not.toHaveBeenCalled();
        });

        it("counts tidal API errors as failures", async () => {
            mockPrisma.trackTidal.findMany.mockResolvedValueOnce([
                { id: "tt-err", tidalId: 11111, likedBy: [] },
            ]);
            mockPrisma.userSettings.findMany.mockResolvedValueOnce([
                { userId: "user-1", tidalOAuthJson: "{}" },
            ]);
            mockTidalGetTrack.mockRejectedValueOnce(new Error("API timeout"));

            const result = await remoteTrackMetadataRefreshService.refreshUnknownMetadata();

            expect(result.failed).toBe(1);
            expect(result.updated).toBe(0);
        });

        it("counts yt music API errors as failures", async () => {
            mockPrisma.trackYtMusic.findMany.mockResolvedValueOnce([
                { id: "yt-err", videoId: "err-vid" },
            ]);
            mockYtGetSong.mockRejectedValueOnce(new Error("Network error"));

            const result = await remoteTrackMetadataRefreshService.refreshUnknownMetadata();

            expect(result.failed).toBe(1);
            expect(result.updated).toBe(0);
        });

        it("counts yt music rows with only placeholder response as failures", async () => {
            mockPrisma.trackYtMusic.findMany.mockResolvedValueOnce([
                { id: "yt-unknown", videoId: "unk-vid" },
            ]);
            mockYtGetSong.mockResolvedValueOnce({
                videoId: "unk-vid",
                title: "Unknown",
                artist: "",
                thumbnails: [],
            });

            const result = await remoteTrackMetadataRefreshService.refreshUnknownMetadata();

            expect(result.failed).toBe(1);
            expect(result.updated).toBe(0);
            expect(mockPrisma.trackYtMusic.update).not.toHaveBeenCalled();
        });
    });
});
