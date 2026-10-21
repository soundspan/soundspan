jest.mock("../../../utils/db", () => ({
    prisma: {
        album: { findMany: jest.fn() },
    },
}));

import { prisma } from "../../../utils/db";
import { searchRemoteLibraryAlbums } from "../remoteAlbumSearch";
import type { RemoteLibrarySet } from "../types";

const mockAlbumFindMany = prisma.album.findMany as jest.Mock;

function remoteLibrary(
    entries: ReadonlyArray<[string, Array<"tidal" | "youtube">]>,
): RemoteLibrarySet {
    return {
        tracks: [],
        byArtistId: new Map(),
        byAlbumId: new Map(entries),
    };
}

function albumRow(id: string, title: string) {
    return {
        id,
        title,
        year: 2026,
        coverUrl: `${id}.jpg`,
        artistId: `artist-${id}`,
        artist: { id: `artist-${id}`, name: `Artist ${id}` },
    };
}

describe("remote album search", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAlbumFindMany.mockResolvedValue([]);
    });

    it.each([
        [remoteLibrary([]), "alpha", 5],
        [remoteLibrary([["album-1", ["tidal"]]]), "   ", 5],
        [remoteLibrary([["album-1", ["tidal"]]]), "alpha", 0],
    ])(
        "returns no rows without eligible candidates or input",
        async (set, query, limit) => {
            await expect(
                searchRemoteLibraryAlbums(set, query, limit),
            ).resolves.toEqual([]);
            expect(mockAlbumFindMany).not.toHaveBeenCalled();
        },
    );

    it("queries only candidate ids with AND-of-OR insensitive terms", async () => {
        const set = remoteLibrary([
            ["album-1", ["tidal"]],
            ["album-2", ["youtube"]],
        ]);

        await searchRemoteLibraryAlbums(set, "  blue   train ", 5);

        expect(mockAlbumFindMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["album-1", "album-2"] },
                location: "REMOTE",
                AND: ["blue", "train"].map((term) => ({
                    OR: [
                        {
                            title: { contains: term, mode: "insensitive" },
                        },
                        {
                            artist: {
                                name: {
                                    contains: term,
                                    mode: "insensitive",
                                },
                            },
                        },
                    ],
                })),
            },
            select: {
                id: true,
                title: true,
                year: true,
                coverUrl: true,
                artistId: true,
                artist: { select: { id: true, name: true } },
            },
            take: 200,
        });
    });

    it("caps search terms at six", async () => {
        const set = remoteLibrary([["album-1", ["tidal"]]]);

        await searchRemoteLibraryAlbums(
            set,
            "one two three four five six seven eight",
            5,
        );

        const terms = mockAlbumFindMany.mock.calls[0][0].where.AND.map(
            (clause: { OR: [{ title: { contains: string } }] }) =>
                clause.OR[0].title.contains,
        );
        expect(terms).toEqual(["one", "two", "three", "four", "five", "six"]);
    });

    it("ranks exact, prefix, and contains matches before collator and id ties", async () => {
        const set = remoteLibrary([
            ["contains", ["tidal"]],
            ["prefix-z", ["youtube"]],
            ["prefix-a", ["tidal"]],
            ["exact-z", ["youtube"]],
            ["exact-a", ["tidal"]],
        ]);
        mockAlbumFindMany.mockResolvedValueOnce([
            albumRow("contains", "The Alpha Record"),
            albumRow("prefix-z", "Álpha Zoo"),
            albumRow("prefix-a", "Alpha Apple"),
            albumRow("exact-z", "ALPHA"),
            albumRow("exact-a", "alpha"),
        ]);

        const result = await searchRemoteLibraryAlbums(set, " Alpha ", 5);

        expect(result.map((album) => album.id)).toEqual([
            "exact-a",
            "exact-z",
            "prefix-a",
            "prefix-z",
            "contains",
        ]);
    });

    it("adds remote response fields and slices to the requested limit", async () => {
        const set = remoteLibrary([
            ["album-2", ["youtube"]],
            ["album-1", ["tidal", "youtube"]],
        ]);
        mockAlbumFindMany.mockResolvedValueOnce([
            albumRow("album-2", "Beta"),
            albumRow("album-1", "Alpha"),
        ]);

        const result = await searchRemoteLibraryAlbums(set, "a", 1);

        expect(result).toEqual([
            {
                id: "album-1",
                title: "Alpha",
                artistId: "artist-album-1",
                year: 2026,
                coverUrl: "album-1.jpg",
                source: "remote",
                remoteSources: ["tidal", "youtube"],
                artist: {
                    id: "artist-album-1",
                    name: "Artist album-1",
                    mbid: "",
                },
            },
        ]);
    });
});
