export function setupSpotifyImportMocks() {
    const spotifyService = {
        getPlaylist: jest.fn(async () => null),
    };
    const musicBrainzService = {
        clearStaleRecordingCaches: jest.fn(async () => undefined),
        searchArtist: jest.fn(async () => []),
        getReleaseGroups: jest.fn(async () => []),
        searchRecording: jest.fn(async () => null),
    };
    const scanQueue = {
        add: jest.fn(async () => ({ id: "scan-1" })),
    };
    const notificationService = {
        create: jest.fn(async () => undefined),
        notifyImportComplete: jest.fn(async () => undefined),
    };
    const redisRecoveryClient = {
        get: jest.fn(async () => null),
        setEx: jest.fn(async () => "OK"),
        connect: jest.fn(async () => undefined),
    };
    const redisClient = {
        get: jest.fn(async () => null),
        setEx: jest.fn(async () => "OK"),
        duplicate: jest.fn(() => redisRecoveryClient),
    };

    const prisma = {
        $connect: jest.fn(async () => undefined),
        spotifyImportJob: {
            findMany: jest.fn(async () => []),
            findUnique: jest.fn(async () => null),
            upsert: jest.fn(async () => undefined),
        },
        playlistPendingTrack: {
            count: jest.fn(async () => 0),
            findMany: jest.fn(async () => []),
            createMany: jest.fn(async () => ({ count: 0 })),
            deleteMany: jest.fn(async () => ({ count: 0 })),
        },
        playlistItem: {
            findMany: jest.fn(async () => []),
            create: jest.fn(async () => undefined),
            aggregate: jest.fn(async () => ({ _max: { sort: null } })),
        },
        track: {
            findFirst: jest.fn(async () => null),
            findMany: jest.fn(async () => []),
            findUnique: jest.fn(async () => null),
        },
        album: {
            findMany: jest.fn(async () => []),
        },
        artist: {
            findFirst: jest.fn(async () => null),
        },
        downloadJob: {
            findMany: jest.fn(async () => []),
            updateMany: jest.fn(async () => ({ count: 0 })),
        },
        playlist: {
            create: jest.fn(async () => ({ id: "playlist-new" })),
            findUnique: jest.fn(async () => ({
                id: "playlist-1",
                name: "Playlist One",
                userId: "u1",
            })),
        },
    };

    jest.doMock("../../utils/db", () => ({ prisma }));
    jest.doMock("../../utils/redis", () => ({
        redisClient,
    }));
    jest.doMock("../../utils/logger", () => ({
        logger: {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        },
    }));
    jest.doMock("../spotify", () => ({
        spotifyService,
    }));
    jest.doMock("../musicbrainz", () => ({ musicBrainzService }));
    const deezerService = {
        getTrackPreview: jest.fn(async () => null),
    };
    jest.doMock("../deezer", () => ({ deezerService }));
    jest.doMock("../../utils/playlistLogger", () => ({
        createPlaylistLogger: jest.fn(() => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            log: jest.fn(),
            logJobStart: jest.fn(),
            logJobFailed: jest.fn(),
            logAlbumDownloadStart: jest.fn(),
            logAlbumFailed: jest.fn(),
            logDownloadProgress: jest.fn(),
            logPlaylistCreationStart: jest.fn(),
            logTrackMatchingStart: jest.fn(),
            logTrackMatch: jest.fn(),
            logPlaylistCreated: jest.fn(),
            logJobComplete: jest.fn(),
        })),
        logPlaylistEvent: jest.fn(),
    }));
    jest.doMock("../notificationService", () => ({
        notificationService,
    }));
    jest.doMock("../../utils/systemSettings", () => ({
        getSystemSettings: jest.fn(async () => ({})),
    }));
    jest.doMock("p-queue", () => {
        return jest.fn().mockImplementation(() => ({
            add: jest.fn(async (fn: () => Promise<unknown>) => fn()),
            onIdle: jest.fn(async () => undefined),
        }));
    });
    const acquisitionService = {
        acquireAlbum: jest.fn(async () => ({
            success: true,
            source: "soulseek",
        })),
        acquireTracks: jest.fn(async () => []),
    };
    jest.doMock("../acquisitionService", () => ({
        acquisitionService,
    }));
    jest.doMock("../../workers/queues", () => ({ scanQueue }));
    jest.doMock("../../utils/artistNormalization", () => ({
        extractPrimaryArtist: jest.fn((name: string) => name),
    }));
    jest.doMock("../../utils/stringNormalization", () => ({
        normalizeFullwidth: jest.fn((value: string) => value),
        normalizeQuotes: jest.fn((value: string) => value),
    }));
    jest.doMock("@prisma/client", () => ({
        Prisma: {
            PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
                code = "P1001";
            },
            PrismaClientRustPanicError: class PrismaClientRustPanicError extends Error {},
            PrismaClientUnknownRequestError: class PrismaClientUnknownRequestError extends Error {},
        },
    }));

    return {
        prisma,
        redisClient,
        redisRecoveryClient,
        spotifyService,
        musicBrainzService,
        scanQueue,
        notificationService,
        deezerService,
        acquisitionService,
    };
}

export function makeSpotifyTrack(
    overrides: Partial<Record<string, unknown>> = {},
) {
    return {
        spotifyId: "sp-track-1",
        title: "Song A",
        artist: "Artist A",
        artistId: "artist-a",
        album: "Album A",
        albumId: "album-a",
        isrc: null,
        durationMs: 180000,
        trackNumber: 1,
        previewUrl: null,
        coverUrl: null,
        ...overrides,
    };
}
