const mockPrisma = {
    trackTidal: { findMany: jest.fn() },
    trackYtMusic: { findMany: jest.fn() },
};

jest.mock("../../../utils/db", () => ({ prisma: mockPrisma }));

import { hydrateRemoteLibraryTracks } from "../remoteDisplayHydration";
import { toLibraryRemoteTrack } from "../responseRow";
import type { RemoteLibraryTrack } from "../types";

const RELEASE_GROUP_MBID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("remote display hydration", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPrisma.trackYtMusic.findMany.mockResolvedValue([]);
    });

    it("carries a linked album match through hydration and serialization", async () => {
        const row = {
            provider: "tidal",
            providerRowId: "tidal-row",
            title: "Track",
            artistId: "artist-1",
            albumId: "album-1",
            albumLocation: "REMOTE",
            albumArtistId: "artist-1",
            albumMatchedRgMbid: RELEASE_GROUP_MBID,
            albumMatchedInLibrary: true,
            likedAt: new Date(0),
            mappings: [],
        } as RemoteLibraryTrack;
        mockPrisma.trackTidal.findMany.mockResolvedValueOnce([
            {
                id: "tidal-row",
                tidalId: 42,
                title: "Track",
                artist: "Artist",
                album: "Album",
                duration: 180,
                artistId: "artist-1",
                albumId: "album-1",
                artistEntity: { id: "artist-1", name: "Artist" },
                albumEntity: {
                    id: "album-1",
                    title: "Album",
                    rgMbid: "remote:album",
                    coverUrl: null,
                    artistId: "artist-1",
                    location: "REMOTE",
                    artist: { id: "artist-1", name: "Artist" },
                },
            },
        ]);

        const [hydrated] = await hydrateRemoteLibraryTracks([row]);
        if (!hydrated) throw new Error("Expected one hydrated TIDAL row");

        expect(toLibraryRemoteTrack(hydrated)).toEqual(
            expect.objectContaining({
                album: expect.objectContaining({
                    matchedRgMbid: RELEASE_GROUP_MBID,
                    matchedInLibrary: true,
                }),
            }),
        );
        expect(
            mockPrisma.trackTidal.findMany.mock.calls[0][0].select.albumEntity
                .select,
        ).not.toHaveProperty("matchedRgMbid");
    });
});
