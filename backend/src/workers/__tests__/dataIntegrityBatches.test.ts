import {
    addDiscoveryAlbumMarkers,
    addDownloadJobMarkers,
    createDiscoveryMarkers,
    findMislocatedAlbums,
    findUnprotectedDiscoverAlbumIds,
} from "../dataIntegrityBatches";

describe("data-integrity batch decisions", () => {
    it("builds normalized bounded discovery markers from selected fields", () => {
        const markers = createDiscoveryMarkers(10);
        addDownloadJobMarkers(markers, [
            {
                metadata: {
                    albumTitle: "  Album One ",
                    artistName: "Artist One",
                    artistMbid: "artist-mbid-1",
                },
            },
        ]);
        addDiscoveryAlbumMarkers(markers, [
            {
                albumTitle: "Album Two",
                artistName: "ARTIST TWO",
                artistMbid: null,
            },
        ]);

        expect(markers.albumTitles).toEqual(
            new Set(["album one", "album two"]),
        );
        expect(markers.artistNames).toEqual(
            new Set(["artist one", "artist two"]),
        );
        expect(markers.artistMbids).toEqual(new Set(["artist-mbid-1"]));
    });

    it("selects only matching albums without protected artist state", () => {
        const markers = createDiscoveryMarkers(10);
        addDiscoveryAlbumMarkers(markers, [
            {
                albumTitle: "Discovery Album",
                artistName: "Discovery Artist",
                artistMbid: "artist-match",
            },
        ]);
        const albums = [
            {
                id: "move",
                rgMbid: "rg-move",
                title: "Discovery Album",
                artistId: "artist-move",
                artist: { name: "Other", mbid: null },
            },
            {
                id: "owned",
                rgMbid: "rg-owned",
                title: "Other",
                artistId: "artist-owned",
                artist: { name: "Discovery Artist", mbid: null },
            },
            {
                id: "liked",
                rgMbid: "rg-liked",
                title: "Other",
                artistId: "artist-liked",
                artist: { name: "Other", mbid: "artist-match" },
            },
        ];

        expect(
            findMislocatedAlbums(
                albums,
                markers,
                new Set(["artist-owned"]),
                new Set(["artist-match"]),
            ).map((album) => album.id),
        ).toEqual(["move"]);
    });

    it("matches active and owned discovery references by exact keys", () => {
        const albums = [
            {
                id: "by-mbid",
                rgMbid: "rg-1",
                title: "One",
                artistId: "artist-1",
                artist: { name: "A", mbid: null },
            },
            {
                id: "by-title",
                rgMbid: "rg-2",
                title: "Two",
                artistId: "artist-2",
                artist: { name: "B", mbid: null },
            },
            {
                id: "orphan",
                rgMbid: "rg-3",
                title: "Three",
                artistId: "artist-3",
                artist: { name: "C", mbid: null },
            },
        ];

        expect(
            findUnprotectedDiscoverAlbumIds(
                albums,
                [
                    {
                        rgMbid: "rg-1",
                        albumTitle: "ignored",
                        artistName: "ignored",
                    },
                    {
                        rgMbid: "different",
                        albumTitle: " TWO ",
                        artistName: " b ",
                    },
                ],
                [{ artistId: "different", rgMbid: "rg-3" }],
            ),
        ).toEqual(["orphan"]);
    });

    it("rejects marker growth beyond the configured bound", () => {
        const markers = createDiscoveryMarkers(2);
        expect(() =>
            addDiscoveryAlbumMarkers(markers, [
                { albumTitle: "one", artistName: "a", artistMbid: null },
                { albumTitle: "two", artistName: "b", artistMbid: null },
            ]),
        ).toThrow("discovery marker bound");
    });
});
