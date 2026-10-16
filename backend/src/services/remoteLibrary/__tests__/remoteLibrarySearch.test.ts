jest.mock("../../../utils/db", () => ({
    prisma: {
        trackTidal: { findMany: jest.fn() },
        trackYtMusic: { findMany: jest.fn() },
    },
}));

jest.mock("../setLoader", () => ({
    loadRemoteLibrarySet: jest.fn(),
}));

import { prisma } from "../../../utils/db";
import { loadRemoteLibrarySet } from "../setLoader";
import {
    rankRemoteLibraryTracks,
    searchRemoteLibraryTracks,
} from "../remoteLibrarySearch";
import type { RemoteLibraryTrack } from "../types";

const mockLoadRemoteLibrarySet = loadRemoteLibrarySet as jest.Mock;
const mockTidalFindMany = prisma.trackTidal.findMany as jest.Mock;
const mockYoutubeFindMany = prisma.trackYtMusic.findMany as jest.Mock;

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
        mockTidalFindMany.mockResolvedValueOnce([
            tidalDisplayRow("tidal-exact", "ALPHA"),
        ]);

        const result = await searchRemoteLibraryTracks("user-1", " alpha ", 1);

        expect(mockLoadRemoteLibrarySet).toHaveBeenCalledWith("user-1", {
            text: "alpha",
        });
        expect(mockTidalFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: { in: ["tidal-exact"] } },
            }),
        );
        expect(mockYoutubeFindMany).not.toHaveBeenCalled();
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
                }),
            }),
        ]);
    });
});
