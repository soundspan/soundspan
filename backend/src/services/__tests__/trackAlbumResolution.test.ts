const mockSearchAlbum = jest.fn();
const mockSearchRecording = jest.fn();
const mockGetTrackInfo = jest.fn();
const mockGetTrackAlbum = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSetEx = jest.fn();

jest.mock("../musicbrainz", () => ({
    musicBrainzService: {
        searchAlbum: mockSearchAlbum,
        searchRecording: mockSearchRecording,
    },
}));

jest.mock("../lastfm", () => ({
    lastFmService: { getTrackInfo: mockGetTrackInfo },
}));

jest.mock("../deezer", () => ({
    deezerService: { getTrackAlbum: mockGetTrackAlbum },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: mockRedisGet,
        setEx: mockRedisSetEx,
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        child: jest.fn().mockReturnValue({
            debug: jest.fn(),
            warn: jest.fn(),
        }),
    },
}));

import { resolveAlbumForExternalTrack } from "../trackAlbumResolution";

const input = {
    trackTitle: "Paranoid Android",
    artistName: "Radiohead",
};

describe("resolveAlbumForExternalTrack", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue(undefined);
        mockSearchAlbum.mockResolvedValue(null);
        mockSearchRecording.mockResolvedValue(null);
        mockGetTrackInfo.mockResolvedValue(null);
        mockGetTrackAlbum.mockResolvedValue(null);
    });

    it("resolves a supplied non-generic album title first", async () => {
        mockSearchAlbum.mockResolvedValue({
            id: "rg-ok-computer",
            title: "OK Computer",
        });

        await expect(
            resolveAlbumForExternalTrack({
                ...input,
                albumTitle: "OK Computer",
            }),
        ).resolves.toEqual({
            status: "resolved",
            resolution: {
                albumTitle: "OK Computer",
                rgMbid: "rg-ok-computer",
                artistName: "Radiohead",
                source: "musicbrainz-album",
            },
        });
        expect(mockSearchAlbum).toHaveBeenCalledWith(
            "OK Computer",
            "Radiohead",
        );
        expect(mockSearchRecording).not.toHaveBeenCalled();
    });

    it("skips generic album titles and resolves through recording search", async () => {
        mockSearchRecording.mockResolvedValue({
            albumName: "OK Computer",
            albumMbid: "rg-ok-computer",
            artistMbid: "artist-mbid",
            trackMbid: "track-mbid",
        });

        await expect(
            resolveAlbumForExternalTrack({
                ...input,
                albumTitle: "Unknown Album",
            }),
        ).resolves.toEqual({
            status: "resolved",
            resolution: {
                albumTitle: "OK Computer",
                rgMbid: "rg-ok-computer",
                artistName: "Radiohead",
                source: "musicbrainz-recording",
            },
        });
        expect(mockSearchAlbum).not.toHaveBeenCalled();
    });

    it("falls through a failed supplied-title lookup to recording search", async () => {
        mockSearchRecording.mockResolvedValue({
            albumName: "OK Computer",
            albumMbid: "rg-ok-computer",
            artistMbid: "artist-mbid",
            trackMbid: "track-mbid",
        });

        const result = await resolveAlbumForExternalTrack({
            ...input,
            albumTitle: "Garbage Tag",
        });

        expect(result).toEqual(
            expect.objectContaining({
                status: "resolved",
                resolution: expect.objectContaining({
                    source: "musicbrainz-recording",
                }),
            }),
        );
        expect(mockSearchAlbum).toHaveBeenNthCalledWith(
            1,
            "Garbage Tag",
            "Radiohead",
        );
    });

    it("uses Last.fm album metadata and verifies it with MusicBrainz", async () => {
        mockGetTrackInfo.mockResolvedValue({
            album: { title: "OK Computer", mbid: "release-mbid" },
        });
        mockSearchAlbum.mockResolvedValue({
            id: "rg-ok-computer",
            title: "OK Computer",
        });

        await expect(resolveAlbumForExternalTrack(input)).resolves.toEqual({
            status: "resolved",
            resolution: {
                albumTitle: "OK Computer",
                rgMbid: "rg-ok-computer",
                artistName: "Radiohead",
                source: "lastfm",
            },
        });
        expect(mockGetTrackInfo).toHaveBeenCalledWith(
            "Radiohead",
            "Paranoid Android",
        );
        expect(mockSearchAlbum).toHaveBeenCalledWith(
            "OK Computer",
            "Radiohead",
        );
    });

    it("uses Deezer as the final title source", async () => {
        mockGetTrackAlbum.mockResolvedValue({
            albumName: "OK Computer",
            albumId: "deezer-album",
        });
        mockSearchAlbum.mockResolvedValue({
            id: "rg-ok-computer",
            title: "OK Computer",
        });

        await expect(resolveAlbumForExternalTrack(input)).resolves.toEqual({
            status: "resolved",
            resolution: {
                albumTitle: "OK Computer",
                rgMbid: "rg-ok-computer",
                artistName: "Radiohead",
                source: "deezer",
            },
        });
        expect(mockGetTrackAlbum).toHaveBeenCalledWith(
            "Radiohead",
            "Paranoid Android",
        );
    });

    it("returns a positive cache hit without calling providers", async () => {
        const cached = {
            status: "hit",
            value: {
                albumTitle: "OK Computer",
                rgMbid: "rg-ok-computer",
                artistName: "Radiohead",
                source: "musicbrainz-recording",
            },
        };
        mockRedisGet.mockResolvedValue(JSON.stringify(cached));

        await expect(resolveAlbumForExternalTrack(input)).resolves.toEqual({
            status: "resolved",
            resolution: cached.value,
        });
        expect(mockSearchRecording).not.toHaveBeenCalled();
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("returns a negative cache hit without calling providers", async () => {
        mockRedisGet.mockResolvedValue(JSON.stringify({ status: "miss" }));

        await expect(resolveAlbumForExternalTrack(input)).resolves.toEqual({
            status: "miss",
        });
        expect(mockSearchRecording).not.toHaveBeenCalled();
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("normalizes artist, track, and album values in the cache identity", async () => {
        await resolveAlbumForExternalTrack({
            artistName: "  RADIOHEAD ",
            trackTitle: "Paranoid   Android",
            albumTitle: " OK COMPUTER ",
        });
        const firstKey = mockRedisGet.mock.calls[0][0];

        jest.clearAllMocks();
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue(undefined);
        mockSearchAlbum.mockResolvedValue(null);
        mockSearchRecording.mockResolvedValue(null);
        mockGetTrackInfo.mockResolvedValue(null);
        mockGetTrackAlbum.mockResolvedValue(null);
        await resolveAlbumForExternalTrack({
            artistName: "radiohead",
            trackTitle: "paranoid android",
            albumTitle: "ok computer",
        });

        expect(mockRedisGet.mock.calls[0][0]).toBe(firstKey);
    });

    it("caches successful results for seven days and genuine misses for one hour", async () => {
        mockSearchRecording.mockResolvedValueOnce({
            albumName: "OK Computer",
            albumMbid: "rg-ok-computer",
            artistMbid: "artist-mbid",
            trackMbid: "track-mbid",
        });

        await resolveAlbumForExternalTrack(input);
        expect(mockRedisSetEx).toHaveBeenLastCalledWith(
            expect.stringMatching(/^track-album-resolution:/),
            7 * 24 * 60 * 60,
            expect.stringContaining('"status":"hit"'),
        );

        jest.clearAllMocks();
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue(undefined);
        mockSearchRecording.mockResolvedValue(null);
        mockGetTrackInfo.mockResolvedValue(null);
        mockGetTrackAlbum.mockResolvedValue(null);
        await resolveAlbumForExternalTrack(input);
        expect(mockRedisSetEx).toHaveBeenLastCalledWith(
            expect.stringMatching(/^track-album-resolution:/),
            60 * 60,
            JSON.stringify({ status: "miss" }),
        );
    });

    it("does not negative-cache an attempt when a provider rung throws", async () => {
        mockSearchRecording.mockRejectedValueOnce(
            new Error("MusicBrainz unavailable"),
        );

        await expect(resolveAlbumForExternalTrack(input)).resolves.toEqual({
            status: "miss",
        });

        expect(mockGetTrackInfo).toHaveBeenCalled();
        expect(mockGetTrackAlbum).toHaveBeenCalled();
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("stops the ladder when the overall budget expires", async () => {
        jest.useFakeTimers();
        mockSearchRecording.mockReturnValue(new Promise(() => undefined));

        try {
            const pending = resolveAlbumForExternalTrack(input);
            await jest.advanceTimersByTimeAsync(10_000);
            await expect(pending).resolves.toEqual({ status: "timeout" });
            expect(mockGetTrackInfo).not.toHaveBeenCalled();
            expect(mockGetTrackAlbum).not.toHaveBeenCalled();
            expect(mockRedisSetEx).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });
});
