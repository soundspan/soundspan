import { deriveRemoteLibraryLookups } from "../derivations";
import type { RemoteLibraryTrack } from "../types";

function row(
    provider: "tidal" | "youtube",
    id: string,
    artistId: string | null,
    albumId: string | null,
    albumLocation: "LIBRARY" | "REMOTE" = "REMOTE",
    albumArtistId = artistId ?? "album-artist",
): RemoteLibraryTrack {
    return {
        provider,
        providerRowId: id,
        title: id,
        artistId,
        albumId,
        albumLocation: albumId ? albumLocation : null,
        albumArtistId: albumId ? albumArtistId : null,
        likedAt: new Date("2026-01-01T00:00:00.000Z"),
        mappings: [],
    } as RemoteLibraryTrack;
}

describe("remote library derivations", () => {
    it("counts tracks, distinct albums, and sorted provider sets", () => {
        const lookups = deriveRemoteLibraryLookups([
            row("youtube", "y1", "artist-1", "album-1"),
            row("tidal", "t1", "artist-1", "album-1"),
            row("tidal", "t2", "artist-1", "album-2"),
            row("youtube", "y2", null, null),
        ]);

        expect(lookups.byArtistId.get("artist-1")).toEqual({
            trackCount: 3,
            albumCount: 2,
            albumIds: new Set(["album-1", "album-2"]),
            providers: ["tidal", "youtube"],
        });
        expect(lookups.byAlbumId.get("album-1")).toEqual(["tidal", "youtube"]);
    });

    it("counts a linked LIBRARY row as a track but not as a remote album", () => {
        const lookups = deriveRemoteLibraryLookups([
            row("tidal", "t1", "artist-1", "library-album", "LIBRARY"),
        ]);

        expect(lookups.byArtistId.get("artist-1")).toEqual({
            trackCount: 1,
            albumCount: 0,
            albumIds: new Set(),
            providers: ["tidal"],
        });
        expect(lookups.byAlbumId.has("library-album")).toBe(false);
    });

    it("uses the linked album artist when the provider artist id is null", () => {
        const lookups = deriveRemoteLibraryLookups([
            row("youtube", "y1", null, "remote-album"),
        ]);

        expect(lookups.byArtistId.get("album-artist")).toEqual({
            trackCount: 1,
            albumCount: 1,
            albumIds: new Set(["remote-album"]),
            providers: ["youtube"],
        });
    });

    it("counts tracks for the provider artist and albums for the album owner", () => {
        const lookups = deriveRemoteLibraryLookups([
            row(
                "tidal",
                "t1",
                "track-artist",
                "remote-album",
                "REMOTE",
                "album-artist",
            ),
        ]);

        expect(lookups.byArtistId.get("track-artist")).toEqual({
            trackCount: 1,
            albumCount: 0,
            albumIds: new Set(),
            providers: ["tidal"],
        });
        expect(lookups.byArtistId.get("album-artist")).toEqual({
            trackCount: 0,
            albumCount: 1,
            albumIds: new Set(["remote-album"]),
            providers: ["tidal"],
        });
    });
});
