jest.mock("../../../utils/db", () => ({
    prisma: {
        trackTidal: { findMany: jest.fn() },
        trackYtMusic: { findMany: jest.fn() },
    },
}));

jest.mock("../setLoader", () => ({
    loadRemoteLibrarySet: jest.fn(),
}));

jest.mock("../remoteAlbumSearch", () => ({
    searchRemoteLibraryAlbums: jest.fn(),
}));

import { prisma } from "../../../utils/db";
import { loadRemoteLibrarySet } from "../setLoader";
import {
    rankRemoteLibraryTracks,
    searchRemoteLibrary,
    searchRemoteLibraryTracks,
} from "../remoteLibrarySearch";
import { searchRemoteLibraryAlbums } from "../remoteAlbumSearch";
import type { RemoteLibrarySet, RemoteLibraryTrack } from "../types";

const mockLoadRemoteLibrarySet = loadRemoteLibrarySet as jest.Mock;
const mockTidalFindMany = prisma.trackTidal.findMany as jest.Mock;
const mockYoutubeFindMany = prisma.trackYtMusic.findMany as jest.Mock;
const mockSearchRemoteLibraryAlbums = searchRemoteLibraryAlbums as jest.Mock;

function remoteRow(
    provider: "tidal" | "youtube",
    providerRowId: string,
    title: string,
): RemoteLibraryTrack {
    return {
        provider,
        providerRowId,
        title,
        artistId: null,
        albumId: null,
        albumLocation: null,
        albumArtistId: null,
        albumMatchedRgMbid: null,
        albumMatchedInLibrary: false,
        likedAt: new Date(0),
        mappings: [],
    } as RemoteLibraryTrack;
}

function tidalDisplayRow(id: string, title: string) {
    return {
        id,
        tidalId: 42,
        title,
        artist: "Remote Artist",
        album: "Remote Album",
        duration: 180,
        artistId: null,
        albumId: null,
        artistEntity: null,
        albumEntity: null,
    };
}

describe("remote library search ranking", () => {
    it("orders exact titles before prefixes and remaining matches", () => {
        const rows = [
            remoteRow("tidal", "rest", "The Alpha Song"),
            remoteRow("tidal", "prefix", "Alphabet"),
            remoteRow("youtube", "exact", "ALPHA"),
        ];

        expect(
            rankRemoteLibraryTracks(rows, " Alpha ").map(
                (row) => row.providerRowId,
            ),
        ).toEqual(["exact", "prefix", "rest"]);
        expect(rows.map((row) => row.providerRowId)).toEqual([
            "rest",
            "prefix",
            "exact",
        ]);
    });

    it("uses the English base collator for title ordering", () => {
        const rows = [
            remoteRow("tidal", "zulu", "Zulu"),
            remoteRow("tidal", "alpha", "alpha"),
        ];

        expect(
            rankRemoteLibraryTracks(rows, "missing").map(
                (row) => row.providerRowId,
            ),
        ).toEqual(["alpha", "zulu"]);
    });

    it("breaks collator ties by provider and then provider row id", () => {
        const rows = [
            remoteRow("youtube", "youtube-1", "Éclair"),
            remoteRow("tidal", "tidal-2", "eclair"),
            remoteRow("tidal", "tidal-1", "ECLAIR"),
        ];

        expect(
            rankRemoteLibraryTracks(rows, "missing").map(
                (row) => row.providerRowId,
            ),
        ).toEqual(["tidal-1", "tidal-2", "youtube-1"]);
    });
});

describe("remote library search", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockLoadRemoteLibrarySet.mockResolvedValue({
            tracks: [],
            byArtistId: new Map(),
            byAlbumId: new Map(),
        });
        mockTidalFindMany.mockResolvedValue([]);
        mockYoutubeFindMany.mockResolvedValue([]);
        mockSearchRemoteLibraryAlbums.mockResolvedValue([]);
    });

    it.each([
        [undefined, "alpha", 5],
        ["user-1", "   ", 5],
        ["user-1", "alpha", 0],
    ])(
        "returns no rows without eligible input",
        async (userId, query, limit) => {
            await expect(
                searchRemoteLibraryTracks(userId, query, limit),
            ).resolves.toEqual([]);

            expect(mockLoadRemoteLibrarySet).not.toHaveBeenCalled();
            expect(mockTidalFindMany).not.toHaveBeenCalled();
            expect(mockYoutubeFindMany).not.toHaveBeenCalled();
        },
    );

    it("hydrates only ranked rows within the limit and adapts the response", async () => {
        const rest = remoteRow("youtube", "youtube-rest", "The Alpha Song");
        const exact = remoteRow("tidal", "tidal-exact", "ALPHA");
        mockLoadRemoteLibrarySet.mockResolvedValueOnce({
            tracks: [rest, exact],
            byArtistId: new Map(),
            byAlbumId: new Map(),
        });
        mockTidalFindMany
            .mockResolvedValueOnce([{ id: "tidal-exact" }])
            .mockResolvedValueOnce([tidalDisplayRow("tidal-exact", "ALPHA")]);
        mockYoutubeFindMany.mockResolvedValueOnce([{ id: "youtube-rest" }]);

        const result = await searchRemoteLibraryTracks("user-1", " alpha ", 1);

        expect(mockLoadRemoteLibrarySet).toHaveBeenCalledWith("user-1", {
            reportCap: false,
        });
        expect(mockTidalFindMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                where: expect.objectContaining({
                    id: { in: ["tidal-exact"] },
                }),
                select: { id: true },
            }),
        );
        expect(mockTidalFindMany).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                where: { id: { in: ["tidal-exact"] } },
            }),
        );
        expect(mockYoutubeFindMany).toHaveBeenCalledTimes(1);
        expect(result).toEqual([
            expect.objectContaining({
                id: "tidal:42",
                title: "ALPHA",
                source: "tidal",
                streamSource: "tidal",
                tidalTrackId: 42,
                album: expect.objectContaining({
                    title: "Remote Album",
                    rgMbid: null,
                    matchedRgMbid: null,
                    matchedInLibrary: false,
                }),
            }),
        ]);
    });

    it("loads one remote set for track and album groups", async () => {
        const exact = remoteRow("tidal", "tidal-exact", "ALPHA");
        const set: RemoteLibrarySet = {
            tracks: [exact],
            byArtistId: new Map(),
            byAlbumId: new Map([["album-1", ["tidal"]]]),
        };
        const remoteAlbums = [{ id: "album-1", source: "remote" }];
        mockLoadRemoteLibrarySet.mockResolvedValueOnce(set);
        mockTidalFindMany
            .mockResolvedValueOnce([{ id: "tidal-exact" }])
            .mockResolvedValueOnce([tidalDisplayRow("tidal-exact", "ALPHA")]);
        mockSearchRemoteLibraryAlbums.mockResolvedValueOnce(remoteAlbums);

        const result = await searchRemoteLibrary("user-1", " alpha ", {
            tracks: 5,
            albums: 6,
        });

        expect(mockLoadRemoteLibrarySet).toHaveBeenCalledTimes(1);
        expect(mockLoadRemoteLibrarySet).toHaveBeenCalledWith("user-1", {
            reportCap: false,
        });
        expect(mockSearchRemoteLibraryAlbums).toHaveBeenCalledWith(
            set,
            "alpha",
            6,
        );
        expect(result.tracks).toEqual([
            expect.objectContaining({ id: "tidal:42", title: "ALPHA" }),
        ]);
        expect(result.albums).toEqual(remoteAlbums);
    });

    it.each([
        [{ tracks: 0, albums: 5 }, false, true],
        [{ tracks: 5, albums: 0 }, true, false],
        [{ tracks: 0, albums: 0 }, false, false],
    ])(
        "skips zero-limit paths for limits %o",
        async (limits, expectsTracks, expectsAlbums) => {
            const set: RemoteLibrarySet = {
                tracks: [remoteRow("tidal", "tidal-1", "Alpha")],
                byArtistId: new Map(),
                byAlbumId: new Map([["album-1", ["tidal"]]]),
            };
            if (limits.tracks >= 1 || limits.albums >= 1) {
                mockLoadRemoteLibrarySet.mockResolvedValueOnce(set);
            }

            const result = await searchRemoteLibrary("user-1", "alpha", limits);

            expect(mockTidalFindMany.mock.calls.length > 0).toBe(expectsTracks);
            expect(mockSearchRemoteLibraryAlbums.mock.calls.length > 0).toBe(
                expectsAlbums,
            );
            expect(result).toEqual({ tracks: [], albums: [] });
            expect(mockLoadRemoteLibrarySet).toHaveBeenCalledTimes(
                limits.tracks < 1 && limits.albums < 1 ? 0 : 1,
            );
        },
    );

    it("requires every term to match provider or linked display fields", async () => {
        const tidal = remoteRow("tidal", "tidal-1", "Provider title");
        const youtube = remoteRow("youtube", "youtube-1", "Video title");
        mockLoadRemoteLibrarySet.mockResolvedValueOnce({
            tracks: [tidal, youtube],
            byArtistId: new Map(),
            byAlbumId: new Map(),
        });

        await searchRemoteLibraryTracks("user-1", "  blue   train ", 5);

        const expectedTerms = ["blue", "train"].map((term) => ({
            OR: [
                { title: { contains: term, mode: "insensitive" } },
                { artist: { contains: term, mode: "insensitive" } },
                { album: { contains: term, mode: "insensitive" } },
                {
                    artistEntity: {
                        is: {
                            name: { contains: term, mode: "insensitive" },
                        },
                    },
                },
                {
                    albumEntity: {
                        is: {
                            title: { contains: term, mode: "insensitive" },
                        },
                    },
                },
                {
                    albumEntity: {
                        is: {
                            artist: {
                                is: {
                                    name: {
                                        contains: term,
                                        mode: "insensitive",
                                    },
                                },
                            },
                        },
                    },
                },
            ],
        }));
        expect(mockTidalFindMany).toHaveBeenCalledWith({
            where: { id: { in: ["tidal-1"] }, AND: expectedTerms },
            select: { id: true },
        });
        expect(mockYoutubeFindMany).toHaveBeenCalledWith({
            where: { id: { in: ["youtube-1"] }, AND: expectedTerms },
            select: { id: true },
        });
    });

    it("ranks an exact-title match after every provider match is loaded", async () => {
        const partialMatches = Array.from({ length: 20 }, (_, index) =>
            remoteRow("tidal", `tidal-partial-${index}`, `Love Song ${index}`),
        );
        const exactMatch = remoteRow("tidal", "tidal-exact", "Love");
        mockLoadRemoteLibrarySet.mockResolvedValueOnce({
            tracks: [...partialMatches, exactMatch],
            byArtistId: new Map(),
            byAlbumId: new Map(),
        });
        const databaseOrder = [...partialMatches, exactMatch].map((row) => ({
            id: row.providerRowId,
        }));
        mockTidalFindMany
            .mockImplementationOnce((args) =>
                Promise.resolve(
                    databaseOrder.slice(0, args.take ?? databaseOrder.length),
                ),
            )
            .mockResolvedValueOnce([tidalDisplayRow("tidal-exact", "Love")]);

        const result = await searchRemoteLibraryTracks("user-1", "love", 5);

        expect(result[0]).toEqual(
            expect.objectContaining({
                id: "tidal:42",
                title: "Love",
            }),
        );
    });

    it("caps provider text matching at six terms", async () => {
        mockLoadRemoteLibrarySet.mockResolvedValueOnce({
            tracks: [remoteRow("tidal", "tidal-1", "Match")],
            byArtistId: new Map(),
            byAlbumId: new Map(),
        });

        await searchRemoteLibraryTracks(
            "user-1",
            "one two three four five six seven eight",
            5,
        );

        const terms = mockTidalFindMany.mock.calls[0][0].where.AND.map(
            (clause: { OR: [{ title: { contains: string } }] }) =>
                clause.OR[0].title.contains,
        );
        expect(terms).toEqual(["one", "two", "three", "four", "five", "six"]);
    });

    it("never searches or returns a collapsed non-preferred duplicate", async () => {
        const preferredTidal = remoteRow(
            "tidal",
            "tidal-preferred",
            "Different metadata",
        );
        mockLoadRemoteLibrarySet.mockResolvedValueOnce({
            tracks: [preferredTidal],
            byArtistId: new Map(),
            byAlbumId: new Map(),
        });
        mockTidalFindMany.mockResolvedValueOnce([]);

        await expect(
            searchRemoteLibraryTracks("user-1", "youtube-only-match", 5),
        ).resolves.toEqual([]);

        expect(mockTidalFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: { in: ["tidal-preferred"] },
                }),
            }),
        );
        expect(mockYoutubeFindMany).not.toHaveBeenCalled();
    });
});
