const mockTidalStream = jest.fn();
const mockTidalPlaylist = jest.fn();
const mockTidalPublicPlaylist = jest.fn();
const mockYoutubeStream = jest.fn();
const mockYoutubePlaylist = jest.fn();
const mockFindTidal = jest.fn();
const mockFindYoutube = jest.fn();

jest.mock("../../tidalStreaming", () => ({
    tidalStreamingService: {
        getStreamProxy: mockTidalStream,
        getBrowsePlaylist: mockTidalPlaylist,
        getPublicBrowsePlaylist: mockTidalPublicPlaylist,
    },
}));
jest.mock("../../youtubeMusic", () => ({
    ytMusicService: {
        getStreamProxy: mockYoutubeStream,
        getBrowsePlaylist: mockYoutubePlaylist,
    },
}));
jest.mock("../../../utils/db", () => ({
    prisma: {
        trackTidal: { findMany: mockFindTidal },
        trackYtMusic: { findMany: mockFindYoutube },
    },
}));

import { remoteProviderAdapters } from "../adapters";

describe("remote provider adapter table", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("routes Tidal operations to Tidal services", async () => {
        const adapter = remoteProviderAdapters.tidal;
        mockTidalStream.mockResolvedValueOnce(null);
        mockTidalPlaylist.mockResolvedValueOnce({ title: "Tidal", tracks: [] });
        mockFindTidal.mockResolvedValueOnce([]);

        await adapter.streamTrack({
            userId: "user-1",
            tidalTrackId: 42,
            quality: "HIGH",
            range: "bytes=0-9",
        });
        await adapter.fetchPlaylist({
            sourceId: "playlist-1",
            userId: "user-1",
            authenticated: true,
            quality: "HIGH",
        });
        await adapter.findTracksByIds(["tidal-row-1"]);

        expect(mockTidalStream).toHaveBeenCalledWith(
            "user-1",
            42,
            "HIGH",
            "bytes=0-9",
        );
        expect(mockTidalPlaylist).toHaveBeenCalledWith(
            "user-1",
            "playlist-1",
            "HIGH",
        );
        expect(mockFindTidal).toHaveBeenCalledWith({
            where: { id: { in: ["tidal-row-1"] } },
        });
    });

    it("routes YouTube operations to YouTube Music services", async () => {
        const adapter = remoteProviderAdapters.youtube;
        mockYoutubeStream.mockResolvedValueOnce(null);
        mockYoutubePlaylist.mockResolvedValueOnce({ title: "YT", tracks: [] });
        mockFindYoutube.mockResolvedValueOnce([]);

        await adapter.streamTrack({
            userId: "oauth-user",
            youtubeVideoId: "video-1",
            quality: "LOW",
        });
        await adapter.fetchPlaylist({
            sourceId: "playlist-2",
            userId: "oauth-user",
            authenticated: true,
            quality: "HIGH",
        });
        await adapter.findTracksByIds(["yt-row-1"]);

        expect(mockYoutubeStream).toHaveBeenCalledWith(
            "oauth-user",
            "video-1",
            "LOW",
            undefined,
        );
        expect(mockYoutubePlaylist).toHaveBeenCalledWith(
            "playlist-2",
            100,
            "oauth-user",
        );
        expect(mockFindYoutube).toHaveBeenCalledWith({
            where: { id: { in: ["yt-row-1"] } },
        });
    });
});
