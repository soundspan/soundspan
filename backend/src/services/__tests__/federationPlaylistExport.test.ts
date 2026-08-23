const playlistFindMany = jest.fn();
const playlistFindFirst = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        playlist: {
            findMany: playlistFindMany,
            findFirst: playlistFindFirst,
        },
    },
}));

import {
    getFederationPlaylistDetail,
    getFederationPlaylistPage,
} from "../federationPlaylistExport";

describe("federation playlist export", () => {
    beforeEach(() => jest.clearAllMocks());

    it("filters list reads to public playlists", async () => {
        playlistFindMany.mockResolvedValueOnce([
            {
                id: "playlist-1",
                name: "Shared mix",
                updatedAt: new Date("2026-08-22T12:00:00.000Z"),
                user: { displayName: "Alice" },
                _count: { items: 3 },
            },
        ]);

        await expect(
            getFederationPlaylistPage({ offset: 0, limit: 25 }),
        ).resolves.toEqual({
            playlists: [
                {
                    remoteId: "playlist-1",
                    name: "Shared mix",
                    trackCount: 3,
                    updatedAt: "2026-08-22T12:00:00.000Z",
                    owner: { displayName: "Alice" },
                },
            ],
            nextOffset: null,
        });
        expect(playlistFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    isPublic: true,
                },
                take: 26,
            }),
        );
    });

    it("never exports private playlists in detail reads", async () => {
        playlistFindFirst.mockResolvedValueOnce(null);

        await expect(
            getFederationPlaylistDetail("playlist-private"),
        ).resolves.toBeNull();
        expect(playlistFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    id: "playlist-private",
                    isPublic: true,
                },
            }),
        );
    });

    it("re-checks publication when detail is requested", async () => {
        playlistFindFirst.mockResolvedValueOnce(null);

        await expect(
            getFederationPlaylistDetail("playlist-listed-earlier"),
        ).resolves.toBeNull();
    });

    it("caps exported detail tracks at 1000 and excludes user identifiers", async () => {
        playlistFindFirst.mockResolvedValueOnce({
            id: "playlist-1",
            name: "Shared mix",
            updatedAt: new Date("2026-08-22T12:00:00.000Z"),
            user: { displayName: null },
            items: [
                {
                    track: {
                        id: "track-1",
                        title: "Song",
                        duration: 180,
                        album: {
                            title: "Album",
                            artist: { name: "Artist" },
                        },
                    },
                },
            ],
        });

        const result = await getFederationPlaylistDetail("playlist-1");

        expect(playlistFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                select: expect.objectContaining({
                    items: expect.objectContaining({
                        take: 1000,
                        where: expect.objectContaining({
                            track: expect.objectContaining({
                                origin: "LOCAL",
                                peerId: null,
                                removedAt: null,
                            }),
                        }),
                    }),
                }),
            }),
        );
        expect(result).toEqual({
            playlist: {
                remoteId: "playlist-1",
                name: "Shared mix",
                owner: { displayName: "Soundspan user" },
                updatedAt: "2026-08-22T12:00:00.000Z",
                tracks: [
                    {
                        remoteTrackId: "track-1",
                        title: "Song",
                        artist: "Artist",
                        album: "Album",
                        duration: 180,
                    },
                ],
            },
        });
        expect(JSON.stringify(result)).not.toMatch(/userId|username|email/);
    });
});
