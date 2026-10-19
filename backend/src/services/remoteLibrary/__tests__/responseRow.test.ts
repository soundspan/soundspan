import { toLibraryRemoteTrack } from "../responseRow";
import type { HydratedRemoteLibraryTrack } from "../types";

const RELEASE_GROUP_MBID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("remote library response adapter", () => {
    it("adapts a linked TIDAL row with release-group identity", () => {
        const row = {
            provider: "tidal",
            providerRowId: "tidal-row",
            title: "Raw title",
            artistId: "artist-1",
            albumId: "album-1",
            albumLocation: "REMOTE",
            albumArtistId: "artist-1",
            albumMatchedRgMbid: RELEASE_GROUP_MBID,
            albumMatchedInLibrary: true,
            likedAt: new Date(),
            mappings: [],
            track: {
                id: "tidal-row",
                tidalId: 42,
                title: "Raw title",
                artist: "Raw artist",
                album: "Raw album",
                duration: 180,
                artistId: "artist-1",
                albumId: "album-1",
                artistEntity: { id: "artist-1", name: "Linked artist" },
                albumEntity: {
                    id: "album-1",
                    title: "Linked album",
                    rgMbid: "remote:synthetic-hash",
                    coverUrl: "cover.jpg",
                    artistId: "artist-1",
                    location: "REMOTE",
                    artist: { id: "artist-1", name: "Linked artist" },
                },
            },
        } as HydratedRemoteLibraryTrack;

        expect(toLibraryRemoteTrack(row)).toEqual(
            expect.objectContaining({
                id: "tidal:42",
                source: "tidal",
                streamSource: "tidal",
                tidalTrackId: 42,
                albumId: "album-1",
                artistId: "artist-1",
                trackNumber: null,
                peer: undefined,
                provider: { tidalTrackId: 42, youtubeVideoId: null },
                album: {
                    id: "album-1",
                    title: "Linked album",
                    rgMbid: "remote:synthetic-hash",
                    matchedRgMbid: RELEASE_GROUP_MBID,
                    matchedInLibrary: true,
                    coverArt: "cover.jpg",
                    coverUrl: "cover.jpg",
                    artistId: "artist-1",
                    artist: { id: "artist-1", name: "Linked artist" },
                },
            }),
        );
    });

    it("adapts an unlinked YouTube Music row with provider strings", () => {
        const row = {
            provider: "youtube",
            providerRowId: "youtube-row",
            title: "Video title",
            artistId: null,
            albumId: null,
            albumLocation: null,
            albumArtistId: null,
            albumMatchedRgMbid: null,
            albumMatchedInLibrary: false,
            likedAt: new Date(),
            mappings: [],
            track: {
                id: "youtube-row",
                videoId: "video-1",
                title: "Video title",
                artist: "Raw artist",
                album: "Raw album",
                duration: 200,
                thumbnailUrl: "thumb.jpg",
                artistId: null,
                albumId: null,
                artistEntity: null,
                albumEntity: null,
            },
        } as HydratedRemoteLibraryTrack;

        expect(toLibraryRemoteTrack(row)).toEqual(
            expect.objectContaining({
                id: "yt:video-1",
                source: "youtube",
                streamSource: "youtube",
                youtubeVideoId: "video-1",
                artistId: null,
                albumId: null,
                artist: { id: null, name: "Raw artist" },
                album: expect.objectContaining({
                    id: null,
                    title: "Raw album",
                    rgMbid: null,
                    matchedRgMbid: null,
                    matchedInLibrary: false,
                    coverArt: "thumb.jpg",
                    artistId: null,
                    artist: { id: null, name: "Raw artist" },
                }),
            }),
        );
    });

    it("uses the linked album artist id when the provider artist id is null", () => {
        const row = {
            provider: "tidal",
            providerRowId: "tidal-row",
            title: "Linked through album",
            artistId: null,
            albumId: "album-1",
            albumLocation: "REMOTE",
            albumArtistId: "album-artist",
            albumMatchedRgMbid: null,
            albumMatchedInLibrary: false,
            likedAt: new Date(),
            mappings: [],
            track: {
                id: "tidal-row",
                tidalId: 42,
                title: "Linked through album",
                artist: "Raw artist",
                album: "Raw album",
                duration: 180,
                artistId: null,
                albumId: "album-1",
                artistEntity: null,
                albumEntity: {
                    id: "album-1",
                    title: "Linked album",
                    rgMbid: "remote:album",
                    matchedRgMbid: null,
                    coverUrl: null,
                    artistId: "album-artist",
                    location: "REMOTE",
                    artist: { id: "album-artist", name: "Album artist" },
                },
            },
        } as HydratedRemoteLibraryTrack;

        expect(toLibraryRemoteTrack(row)).toEqual(
            expect.objectContaining({
                artistId: "album-artist",
                artist: { id: "album-artist", name: "Album artist" },
            }),
        );
    });

    it("prefers the provider artist id over the linked album artist id", () => {
        const row = {
            provider: "tidal",
            providerRowId: "tidal-row",
            title: "Direct artist",
            artistId: "direct-artist",
            albumId: "album-1",
            albumLocation: "REMOTE",
            albumArtistId: "album-artist",
            albumMatchedRgMbid: null,
            albumMatchedInLibrary: false,
            likedAt: new Date(),
            mappings: [],
            track: {
                id: "tidal-row",
                tidalId: 42,
                title: "Direct artist",
                artist: "Direct artist",
                album: "Raw album",
                duration: 180,
                artistId: "direct-artist",
                albumId: "album-1",
                artistEntity: null,
                albumEntity: {
                    id: "album-1",
                    title: "Linked album",
                    rgMbid: "remote:album",
                    matchedRgMbid: null,
                    coverUrl: null,
                    artistId: "album-artist",
                    location: "REMOTE",
                    artist: { id: "album-artist", name: "Album artist" },
                },
            },
        } as HydratedRemoteLibraryTrack;

        expect(toLibraryRemoteTrack(row)).toEqual(
            expect.objectContaining({
                artistId: "direct-artist",
                artist: { id: "direct-artist", name: "Album artist" },
            }),
        );
    });
});
