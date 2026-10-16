import { formatRemoteAwareArtist } from "../browsePresentation";

const artist = {
    id: "artist-1",
    mbid: "mbid-1",
    name: "Artist",
    heroUrl: null,
    userHeroUrl: null,
    libraryAlbumCount: 2,
    discoveryAlbumCount: 1,
    totalTrackCount: 5,
    remoteTrackCount: 0,
    peerId: null,
    federationPeer: null,
};
const stats = {
    trackCount: 3,
    albumCount: 2,
    albumIds: new Set(["album-1", "album-2"]),
    providers: ["tidal", "youtube"] as const,
};

describe("remote-aware artist presentation", () => {
    it("adds remote counts for all-origin rows", () => {
        expect(
            formatRemoteAwareArtist(artist, "cover.jpg", {
                countsReady: true,
                filter: "owned",
                origin: "all",
                remoteStats: stats,
            }),
        ).toEqual(
            expect.objectContaining({
                albumCount: 4,
                trackCount: 8,
                remoteSources: ["tidal", "youtube"],
            }),
        );
    });

    it("uses only remote counts and source for remote-only rows", () => {
        expect(
            formatRemoteAwareArtist(
                {
                    ...artist,
                    libraryAlbumCount: 0,
                    discoveryAlbumCount: 0,
                    totalTrackCount: 0,
                },
                null,
                {
                    countsReady: false,
                    filter: "all",
                    origin: "remote",
                    remoteStats: stats,
                },
            ),
        ).toEqual(
            expect.objectContaining({
                albumCount: 2,
                trackCount: 3,
                source: "remote",
            }),
        );
    });

    it("never overrides a federated source", () => {
        const formatted = formatRemoteAwareArtist(
            {
                ...artist,
                libraryAlbumCount: 0,
                totalTrackCount: 0,
                peerId: "peer-1",
                federationPeer: {
                    id: "peer-1",
                    name: "Peer",
                    outboundStatus: "ACTIVE",
                },
            },
            null,
            {
                countsReady: true,
                filter: "owned",
                origin: "all",
                remoteStats: stats,
            },
        );

        expect(formatted).toEqual(
            expect.objectContaining({ source: "federated" }),
        );
    });
});
