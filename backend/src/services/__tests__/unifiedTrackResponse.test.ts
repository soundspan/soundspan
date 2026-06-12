import {
    formatUnifiedTrackItem,
    normalizeLocalTrack,
    normalizeTidalTrack,
    normalizeYtMusicTrack,
} from "../unifiedTrackResponse";

describe("unifiedTrackResponse", () => {
    it("normalizes local tracks into canonical unified shape", () => {
        const result = normalizeLocalTrack({
            id: "track-1",
            title: "Local Song",
            duration: 180,
            trackNo: 3,
            filePath: "/music/local-song.flac",
            displayTitle: "Local Song (Deluxe)",
            album: {
                id: "album-1",
                title: "Local Album",
                coverUrl: "native:albums/a1.jpg",
                artist: {
                    id: "artist-1",
                    name: "Local Artist",
                    mbid: "mbid-artist-1",
                },
            },
        });

        expect(result).toEqual({
            id: "track-1",
            title: "Local Song",
            duration: 180,
            trackNo: 3,
            artist: {
                id: "artist-1",
                name: "Local Artist",
            },
            album: {
                id: "album-1",
                title: "Local Album",
                coverArt: "native:albums/a1.jpg",
            },
            source: "local",
            provider: {
                tidalTrackId: null,
                youtubeVideoId: null,
            },
            filePath: "/music/local-song.flac",
            displayTitle: "Local Song (Deluxe)",
        });
    });

    it("normalizes tidal tracks into canonical unified shape", () => {
        const result = normalizeTidalTrack({
            id: "tt-1",
            tidalId: 991,
            title: "Tidal Song",
            artist: "Tidal Artist",
            album: "Tidal Album",
            duration: 245,
        });

        expect(result).toEqual({
            id: "tidal:991",
            title: "Tidal Song",
            duration: 245,
            trackNo: null,
            artist: {
                id: null,
                name: "Tidal Artist",
            },
            album: {
                id: null,
                title: "Tidal Album",
                coverArt: null,
            },
            source: "tidal",
            provider: {
                tidalTrackId: 991,
                youtubeVideoId: null,
            },
        });
    });

    it("normalizes youtube tracks into canonical unified shape", () => {
        const result = normalizeYtMusicTrack({
            id: "yt-1",
            videoId: "yt-video-7",
            title: "YT Song",
            artist: "YT Artist",
            album: "YT Album",
            duration: 199,
            thumbnailUrl: "https://yt/thumb.jpg",
        });

        expect(result).toEqual({
            id: "yt:yt-video-7",
            title: "YT Song",
            duration: 199,
            trackNo: null,
            artist: {
                id: null,
                name: "YT Artist",
            },
            album: {
                id: null,
                title: "YT Album",
                coverArt: "https://yt/thumb.jpg",
            },
            source: "youtube",
            provider: {
                tidalTrackId: null,
                youtubeVideoId: "yt-video-7",
            },
        });
    });

    it("formats local playlist items with compatibility wrapper", () => {
        const result = formatUnifiedTrackItem({
            id: "pli-local-1",
            playlistId: "pl-1",
            trackId: "track-1",
            trackTidalId: null,
            trackYtMusicId: null,
            sort: 1,
            track: {
                id: "track-1",
                title: "Local Song",
                duration: 180,
                album: {
                    title: "Local Album",
                    coverUrl: "native:albums/a1.jpg",
                    artist: {
                        id: "artist-1",
                        name: "Local Artist",
                    },
                },
            },
            trackTidal: null,
            trackYtMusic: null,
        });

        expect(result.provider.source).toBe("local");
        expect(result.playback.isPlayable).toBe(true);
        expect(result.track).toMatchObject({
            id: "track-1",
            source: "local",
            album: {
                title: "Local Album",
                coverArt: "native:albums/a1.jpg",
                artist: {
                    id: "artist-1",
                    name: "Local Artist",
                },
            },
        });
    });

    it("formats remote playlist items with compatibility wrapper and playback status", () => {
        const tidal = formatUnifiedTrackItem({
            id: "pli-tidal-1",
            playlistId: "pl-1",
            trackId: null,
            trackTidalId: "tt-1",
            trackYtMusicId: null,
            sort: 2,
            track: null,
            trackTidal: {
                id: "tt-1",
                tidalId: 991,
                title: "Tidal Song",
                artist: "Tidal Artist",
                album: "Tidal Album",
                duration: 245,
            },
            trackYtMusic: null,
        });
        expect(tidal.provider.source).toBe("tidal");
        expect(tidal.playback.isPlayable).toBe(true);
        expect(tidal.track).toMatchObject({
            id: "tidal:991",
            streamSource: "tidal",
            tidalTrackId: 991,
        });

        const youtubeMissingId = formatUnifiedTrackItem({
            id: "pli-yt-missing",
            playlistId: "pl-1",
            trackId: null,
            trackTidalId: null,
            trackYtMusicId: "yt-1",
            sort: 3,
            track: null,
            trackTidal: null,
            trackYtMusic: {
                id: "yt-1",
                videoId: "   ",
                title: "YT Unknown",
                artist: "Unknown Artist",
                album: "Unknown Album",
                duration: 200,
                thumbnailUrl: null,
            },
        });
        expect(youtubeMissingId.provider.source).toBe("youtube");
        expect(youtubeMissingId.playback.isPlayable).toBe(false);
        expect(youtubeMissingId.playback.reason).toBe("missing_youtube_video_id");
    });
});
