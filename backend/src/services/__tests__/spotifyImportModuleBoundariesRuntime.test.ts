const spotifyTrack = {
    spotifyId: "spotify-track-1",
    title: "Track One",
    artist: "Artist One",
    artistId: "spotify-artist-1",
    album: "Album One",
    albumId: "spotify-album-1",
    isrc: null,
    durationMs: 180_000,
    trackNumber: 1,
    previewUrl: null,
    coverUrl: null,
};

const localTrack = {
    id: "track-1",
    title: "Track One",
    albumId: "album-1",
    album: {
        title: "Album One",
        artist: { name: "Artist One" },
    },
};

const prisma = {
    $connect: jest.fn(async () => undefined),
    album: { findMany: jest.fn(async () => []) },
    artist: { findFirst: jest.fn(async () => null) },
    downloadJob: {
        findMany: jest.fn(async () => []),
        updateMany: jest.fn(async () => ({ count: 0 })),
    },
    playlist: {
        create: jest.fn(async () => ({ id: "playlist-1" })),
        findUnique: jest.fn(async () => null),
    },
    playlistItem: {
        aggregate: jest.fn(async () => ({ _max: { sort: null } })),
        create: jest.fn(async () => undefined),
        findMany: jest.fn(async () => []),
    },
    playlistPendingTrack: {
        count: jest.fn(async () => 0),
        createMany: jest.fn(async () => ({ count: 0 })),
        deleteMany: jest.fn(async () => ({ count: 0 })),
        findMany: jest.fn(async () => []),
    },
    spotifyImportJob: {
        findMany: jest.fn(async () => []),
        findUnique: jest.fn(async () => null),
        upsert: jest.fn(async () => undefined),
    },
    track: {
        findFirst: jest.fn(async () => localTrack),
        findMany: jest.fn(async () => []),
        findUnique: jest.fn(async () => null),
    },
};

const redisClient = {
    duplicate: jest.fn(),
    get: jest.fn(async () => null as string | null),
    setEx: jest.fn(async () => "OK"),
};
redisClient.duplicate.mockReturnValue({
    ...redisClient,
    connect: jest.fn(async () => undefined),
});

const musicBrainzService = {
    clearStaleRecordingCaches: jest.fn(async () => undefined),
    getReleaseGroups: jest.fn(async () => []),
    searchArtist: jest.fn(async () => []),
    searchRecording: jest.fn(async () => null),
};

jest.mock("../../utils/db", () => ({ prisma }));
jest.mock("../../utils/redis", () => ({ redisClient }));
jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
    },
}));
jest.mock("../spotify", () => ({
    spotifyService: {
        getPlaylist: jest.fn(async () => ({
            id: "spotify-playlist-1",
            name: "Playlist One",
            description: null,
            owner: "Owner One",
            imageUrl: null,
            trackCount: 1,
            tracks: [spotifyTrack],
        })),
    },
}));
jest.mock("../musicbrainz", () => ({ musicBrainzService }));
jest.mock("../deezer", () => ({
    deezerService: { getTrackPreview: jest.fn(async () => null) },
}));
jest.mock("../../utils/playlistLogger", () => ({
    createPlaylistLogger: jest.fn(() => ({
        debug: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        log: jest.fn(),
        logAlbumDownloadStart: jest.fn(),
        logAlbumFailed: jest.fn(),
        logDownloadProgress: jest.fn(),
        logJobComplete: jest.fn(),
        logJobFailed: jest.fn(),
        logJobStart: jest.fn(),
        logPlaylistCreated: jest.fn(),
        logPlaylistCreationStart: jest.fn(),
        logTrackMatch: jest.fn(),
        logTrackMatchingStart: jest.fn(),
        warn: jest.fn(),
    })),
}));
jest.mock("../notificationService", () => ({
    notificationService: {
        create: jest.fn(async () => undefined),
        notifyImportComplete: jest.fn(async () => undefined),
    },
}));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(async () => ({})),
}));
jest.mock("p-queue", () =>
    jest.fn().mockImplementation(() => ({
        add: jest.fn(async (run: () => Promise<unknown>) => run()),
    })),
);
jest.mock("../acquisitionService", () => ({
    acquisitionService: {
        acquireAlbum: jest.fn(),
        acquireTracks: jest.fn(),
    },
}));
jest.mock("@prisma/client", () => ({
    Prisma: {
        PrismaClientKnownRequestError: class extends Error {},
        PrismaClientRustPanicError: class extends Error {},
        PrismaClientUnknownRequestError: class extends Error {},
    },
}));

import { spotifyImportService as compatibilityService } from "../spotifyImport";
import { spotifyImportService as directoryService } from "../spotifyImport/index";

describe("spotify import module boundaries", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.playlist.create.mockResolvedValue({ id: "playlist-1" });
        prisma.playlistPendingTrack.findMany.mockResolvedValue([]);
        prisma.spotifyImportJob.findMany.mockResolvedValue([]);
        prisma.track.findFirst.mockResolvedValue(localTrack);
        redisClient.get.mockResolvedValue(null);
    });

    it("shares one façade instance and generates a matched preview", async () => {
        expect(compatibilityService).toBe(directoryService);

        const preview = await compatibilityService.generatePreview(
            "https://open.spotify.com/playlist/spotify-playlist-1",
        );

        expect(preview.summary).toEqual({
            total: 1,
            inLibrary: 1,
            downloadable: 0,
            notFound: 0,
        });
        expect(preview.matchedTracks[0].localTrack?.id).toBe("track-1");
    });

    it("loads durable jobs through the façade", async () => {
        await expect(
            compatibilityService.getUserJobs("user-1"),
        ).resolves.toEqual([]);

        expect(prisma.spotifyImportJob.findMany).toHaveBeenCalledWith({
            where: { userId: "user-1" },
            orderBy: { createdAt: "desc" },
        });
    });

    it("builds a playlist after a scan through the façade", async () => {
        redisClient.get.mockResolvedValueOnce(
            JSON.stringify({
                id: "import-1",
                userId: "user-1",
                spotifyPlaylistId: "spotify-playlist-1",
                playlistName: "Playlist One",
                status: "scanning",
                progress: 75,
                albumsTotal: 0,
                albumsCompleted: 0,
                tracksMatched: 0,
                tracksTotal: 0,
                tracksDownloadable: 0,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                pendingTracks: [],
            }),
        );

        await compatibilityService.buildPlaylistAfterScan("import-1");

        expect(prisma.playlist.create).toHaveBeenCalledWith({
            data: {
                userId: "user-1",
                name: "Playlist One",
                isPublic: false,
                spotifyPlaylistId: "spotify-playlist-1",
                items: undefined,
            },
        });
    });

    it("reconciles an empty pending-track set through the façade", async () => {
        await expect(
            compatibilityService.reconcilePendingTracks(),
        ).resolves.toEqual({ playlistsUpdated: 0, tracksAdded: 0 });
    });
});
