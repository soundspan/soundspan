jest.mock("../../../utils/db", () => ({
    prisma: {
        $queryRaw: jest.fn(),
        track: { count: jest.fn(), findMany: jest.fn() },
        trackTidal: { findMany: jest.fn() },
        trackYtMusic: { findMany: jest.fn() },
    },
}));

import { prisma } from "../../../utils/db";
import { loadLibrarySongsPage } from "../librarySongsPage";
import { deriveRemoteLibraryLookups } from "../derivations";
import * as responseRow from "../responseRow";
import type { RemoteLibraryTrack } from "../types";

const mockQueryRaw = prisma.$queryRaw as jest.Mock;
const mockTrackCount = prisma.track.count as jest.Mock;
const mockTrackFindMany = prisma.track.findMany as jest.Mock;
const mockTidalFindMany = prisma.trackTidal.findMany as jest.Mock;
const mockYoutubeFindMany = prisma.trackYtMusic.findMany as jest.Mock;

type YoutubeRemoteRow = Extract<RemoteLibraryTrack, { provider: "youtube" }>;

function youtubeRow(): YoutubeRemoteRow {
    return {
        provider: "youtube",
        providerRowId: "youtube-row",
        title: "Alpha",
        artistId: null,
        albumId: null,
        albumLocation: null,
        albumArtistId: null,
        albumMatchedRgMbid: null,
        albumMatchedInLibrary: false,
        likedAt: new Date(),
        mappings: [],
    };
}

function youtubeDisplayRow(id = "youtube-row", videoId = "video-1") {
    return {
        id,
        videoId,
        title: id === "youtube-row" ? "Alpha" : "Beta",
        artist: "Remote Artist",
        album: "Remote Album",
        duration: 180,
        thumbnailUrl: null,
        artistId: null,
        albumId: null,
        artistEntity: null,
        albumEntity: null,
    };
}

describe("Library Songs merged page", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockTrackCount.mockResolvedValue(1);
        mockTrackFindMany.mockResolvedValue([
            {
                id: "local-1",
                title: "Zulu",
                origin: "LOCAL",
                federationPeer: null,
                album: {
                    id: "album-1",
                    title: "Album",
                    coverUrl: "cover.jpg",
                    artist: { id: "artist-1", name: "Artist" },
                },
            },
        ]);
        mockTidalFindMany.mockResolvedValue([]);
        mockYoutubeFindMany.mockResolvedValue([youtubeDisplayRow()]);
    });

    it("hydrates all kinds and preserves the SQL id-page order", async () => {
        const tracks = [youtubeRow()];
        const remoteLibrary = {
            tracks,
            ...deriveRemoteLibraryLookups(tracks),
        };
        mockQueryRaw.mockResolvedValue([
            { kind: "youtube", id: "youtube-row", title: "Alpha" },
            { kind: "local", id: "local-1", title: "Zulu" },
        ]);

        const page = await loadLibrarySongsPage({
            origin: "all",
            remoteLibrary,
            sortBy: "name",
            limit: 10,
            offset: 0,
        });

        expect(page.tracks.map((track) => track.id)).toEqual([
            "yt:video-1",
            "local-1",
        ]);
        expect(page.tracks[0]).toEqual(
            expect.objectContaining({
                album: expect.objectContaining({ matchedInLibrary: false }),
            }),
        );
        expect(page.total).toBe(2);
    });

    it("does not count or hydrate local tracks for remote-only pages", async () => {
        const tracks = [youtubeRow()];
        const remoteLibrary = {
            tracks,
            ...deriveRemoteLibraryLookups(tracks),
        };
        mockQueryRaw.mockResolvedValue([
            { kind: "youtube", id: "youtube-row", title: "Alpha" },
        ]);

        const page = await loadLibrarySongsPage({
            origin: "remote",
            remoteLibrary,
            sortBy: "name-desc",
            limit: 10,
            offset: 0,
        });

        expect(page.tracks.map((track) => track.id)).toEqual(["yt:video-1"]);
        expect(page.total).toBe(1);
        expect(mockTrackCount).not.toHaveBeenCalled();
        expect(mockTrackFindMany).not.toHaveBeenCalled();
    });

    it("adapts only remote rows selected by the id page", async () => {
        const first = youtubeRow();
        const second = {
            ...youtubeRow(),
            providerRowId: "youtube-row-2",
            title: "Beta",
        };
        const tracks = [first, second];
        const remoteLibrary = {
            tracks,
            ...deriveRemoteLibraryLookups(tracks),
        };
        mockQueryRaw.mockResolvedValue([
            { kind: "youtube", id: "youtube-row-2", title: "Beta" },
        ]);
        mockYoutubeFindMany.mockResolvedValueOnce([
            youtubeDisplayRow("youtube-row-2", "video-2"),
        ]);
        const adapter = jest.spyOn(responseRow, "toLibraryRemoteTrack");

        const page = await loadLibrarySongsPage({
            origin: "remote",
            remoteLibrary,
            sortBy: "name",
            limit: 1,
            offset: 0,
        });

        expect(page.tracks.map((track) => track.id)).toEqual(["yt:video-2"]);
        expect(adapter).toHaveBeenCalledTimes(1);
        expect(adapter).toHaveBeenCalledWith({
            ...second,
            track: youtubeDisplayRow("youtube-row-2", "video-2"),
        });
        expect(mockYoutubeFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: { in: ["youtube-row-2"] } },
            }),
        );
        adapter.mockRestore();
    });
});
