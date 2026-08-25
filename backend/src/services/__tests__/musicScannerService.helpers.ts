const mockReaddir = jest.fn();
const mockStat = jest.fn();
const mockUnlink = jest.fn();
const mockExistsSync = jest.fn();
const mockParseFile = jest.fn();
const queueInstances: Array<{
    add: jest.Mock;
    maxSize: number;
    onIdle: jest.Mock;
    onSizeLessThan: jest.Mock;
    readonly size: number;
}> = [];

const mockPrisma = {
    track: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
    },
    trackEmbedding: {
        deleteMany: jest.fn(),
    },
    transcodedFile: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    album: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
        updateMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
    artist: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
    systemSettings: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
    },
    downloadJob: {
        findMany: jest.fn(),
    },
    discoveryAlbum: {
        findFirst: jest.fn(),
    },
    ownedAlbum: {
        create: jest.fn(),
        findUnique: jest.fn(),
        upsert: jest.fn(),
    },
    libraryHealthRecord: {
        upsert: jest.fn(),
        deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(async () => []),
};

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);

const mockUpdateArtistCountsInBatches = jest.fn();
const mockComputeAudioStreamHash = jest.fn();
const mockResolveAlbumCover = jest.fn();
const mockNormalizeArtistName = jest.fn((name: string) =>
    name.trim().toLowerCase(),
);
const mockAreArtistNamesSimilar = jest.fn(
    (_first: string, _second: string, _threshold: number) => false,
);
const mockCanonicalizeVariousArtists = jest.fn((name: string) => name);
const mockExtractPrimaryArtist = jest.fn((name: string) => name);
const mockParseArtistFromPath = jest.fn((name: string) => name);
const mockExtractCoverArt = jest.fn();
const mockCreateMapping = jest.fn();
const mockRecomputeAlbumLoudness = jest.fn();
const mockBumpSearchCacheVersion = jest.fn();
const mockConfig = {
    music: { transcodeCachePath: "/cache/transcodes" },
    scanFileConcurrency: 2,
    workers: { trackRemovalRetentionDays: 90, providerTrackRetentionDays: 30 },
    features: { federation: false },
};

jest.mock("fs", () => ({
    promises: {
        readdir: mockReaddir,
        stat: mockStat,
        unlink: mockUnlink,
    },
    existsSync: mockExistsSync,
}));

jest.mock(
    "music-metadata",
    () => ({
        parseFile: mockParseFile,
    }),
    { virtual: true },
);

jest.mock("p-queue", () => ({
    __esModule: true,
    default: class MockPQueue {
        add: jest.Mock;
        onIdle: jest.Mock;
        onSizeLessThan: jest.Mock;
        maxSize = 0;
        private readonly concurrency: number;
        private running = 0;
        private pending: Array<() => void> = [];
        private idleWaiters: Array<() => void> = [];
        private sizeWaiters: Array<{ limit: number; resolve: () => void }> = [];

        get size(): number {
            return this.pending.length;
        }

        constructor(options: { concurrency: number }) {
            this.concurrency = options.concurrency;
            this.add = jest.fn(
                (task: () => Promise<unknown>) =>
                    new Promise<unknown>((resolve, reject) => {
                        const start = () => {
                            this.running++;
                            Promise.resolve()
                                .then(task)
                                .then(resolve, reject)
                                .finally(() => {
                                    this.running--;
                                    this.pending.shift()?.();
                                    this.resolveSizeWaiters();
                                    if (
                                        this.running === 0 &&
                                        this.pending.length === 0
                                    ) {
                                        this.idleWaiters
                                            .splice(0)
                                            .forEach((waiter) => waiter());
                                    }
                                });
                        };
                        if (this.running < this.concurrency) start();
                        else {
                            this.pending.push(start);
                            this.maxSize = Math.max(
                                this.maxSize,
                                this.pending.length,
                            );
                        }
                    }),
            );
            this.onSizeLessThan = jest.fn(
                (limit: number) =>
                    new Promise<void>((resolve) => {
                        if (this.pending.length < limit) resolve();
                        else this.sizeWaiters.push({ limit, resolve });
                    }),
            );
            this.onIdle = jest.fn(
                () =>
                    new Promise<void>((resolve) => {
                        if (this.running === 0 && this.pending.length === 0) {
                            resolve();
                        } else {
                            this.idleWaiters.push(resolve);
                        }
                    }),
            );
            queueInstances.push(this);
        }

        private resolveSizeWaiters(): void {
            const ready = this.sizeWaiters.filter(
                ({ limit }) => this.pending.length < limit,
            );
            this.sizeWaiters = this.sizeWaiters.filter(
                ({ limit }) => this.pending.length >= limit,
            );
            ready.forEach(({ resolve }) => resolve());
        }
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: mockLogger,
}));

jest.mock("../../utils/db", () => ({
    prisma: mockPrisma,
}));

jest.mock("../coverArtExtractor", () => ({
    CoverArtExtractor: jest.fn().mockImplementation(() => ({
        coverCachePath: "/tmp/covers",
        extractCoverArt: mockExtractCoverArt,
    })),
}));

jest.mock("../metadata/albumCoverResolver", () => ({
    resolveAlbumCover: mockResolveAlbumCover,
}));

jest.mock("../../utils/artistNormalization", () => ({
    normalizeArtistName: mockNormalizeArtistName,
    areArtistNamesSimilar: mockAreArtistNamesSimilar,
    canonicalizeVariousArtists: mockCanonicalizeVariousArtists,
    extractPrimaryArtist: mockExtractPrimaryArtist,
    parseArtistFromPath: mockParseArtistFromPath,
}));

jest.mock("../artistCountsService", () => ({
    updateArtistCountsInBatches: mockUpdateArtistCountsInBatches,
}));

jest.mock("../audioHash", () => ({
    computeAudioStreamHash: mockComputeAudioStreamHash,
}));

jest.mock("../trackMappingService", () => ({
    trackMappingService: { createMapping: mockCreateMapping },
}));

jest.mock("../albumLoudness", () => ({
    recomputeAlbumLoudness: mockRecomputeAlbumLoudness,
}));

jest.mock("../searchCacheVersion", () => ({
    bumpSearchCacheVersion: mockBumpSearchCacheVersion,
}));

jest.mock("../../config", () => ({
    config: mockConfig,
}));

const { MusicScannerService } =
    require("../musicScanner") as typeof import("../musicScanner");
const { persistScannedTrack } =
    require("../scannedTrackPersistence") as typeof import("../scannedTrackPersistence");
const { isLossyAudioCodec } =
    require("../libraryHealthDashboard/qualityOutliers") as typeof import("../libraryHealthDashboard/qualityOutliers");
const { albumOrphanRetentionGuardWhere, artistOrphanRetentionGuardWhere } =
    require("../providerTrackRetention") as typeof import("../providerTrackRetention");

interface TestIdentityTrack {
    id: string;
    filePath: string;
    origin: "LOCAL" | "FEDERATED";
    fileModified: Date;
    fileSize: number;
    duration: number;
    title: string;
    discNo: number;
    trackNo: number;
    mime: string;
    albumId: string;
    audioHash: string | null;
    audioHashedAt: Date | null;
    recordingMbid: string | null;
    isrc: string | null;
    removedAt: Date | null;
    album: { rgMbid: string | null; location: string; artistId: string };
}

function identityTrack(
    id: string,
    filePath: string,
    overrides: Partial<TestIdentityTrack> = {},
): TestIdentityTrack {
    return {
        id,
        filePath,
        origin: "LOCAL",
        fileModified: new Date("2026-01-01T00:00:00.000Z"),
        fileSize: 1_024,
        duration: 218,
        title: "Test Track",
        discNo: 1,
        trackNo: 3,
        mime: "audio/flac",
        albumId: "album-1",
        audioHash: null,
        audioHashedAt: null,
        recordingMbid: null,
        isrc: null,
        removedAt: null,
        album: {
            rgMbid: "rg-album-1",
            location: "LIBRARY",
            artistId: "artist-1",
        },
        ...overrides,
    };
}

function deferred<T = void>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function waitForCondition(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
        if (condition()) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error("Timed out waiting for controlled async work");
}

function makeDirent(name: string, kind: "file" | "dir" | "symlink") {
    return {
        name,
        isDirectory: () => kind === "dir" || kind === "symlink",
        isFile: () => kind === "file",
        isSymbolicLink: () => kind === "symlink",
    };
}

beforeEach(() => {
    queueInstances.length = 0;
    mockConfig.scanFileConcurrency = 2;
    mockConfig.workers.trackRemovalRetentionDays = 90;
    mockConfig.features.federation = false;

    mockReaddir.mockResolvedValue([]);
    mockExistsSync.mockReturnValue(true);
    mockStat.mockResolvedValue({
        mtime: new Date("2026-02-01T00:00:00.000Z"),
        size: 1024,
    });
    mockParseFile.mockResolvedValue({
        common: {
            title: "Test Track",
            track: { no: 3 },
            disk: { no: 1 },
            albumartist: "Test Artist",
            album: "Test Album",
            year: 2024,
        },
        format: {
            duration: 218.7,
            codec: "audio/flac",
        },
    } as any);

    mockPrisma.track.findMany.mockResolvedValue([]);
    mockPrisma.track.findUnique.mockResolvedValue({ albumId: "album-1" });
    mockPrisma.track.upsert.mockResolvedValue({});
    mockPrisma.track.update.mockResolvedValue({});
    mockPrisma.track.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.track.delete.mockResolvedValue({});
    mockPrisma.track.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.trackEmbedding.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.transcodedFile.findMany.mockResolvedValue([]);
    mockPrisma.transcodedFile.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.$transaction.mockImplementation(
        async (operation: (tx: typeof mockPrisma) => Promise<unknown>) =>
            operation(mockPrisma),
    );
    mockUnlink.mockResolvedValue(undefined);
    mockPrisma.libraryHealthRecord.upsert.mockResolvedValue({});
    mockPrisma.libraryHealthRecord.deleteMany.mockResolvedValue({ count: 0 });

    mockPrisma.systemSettings.findFirst.mockResolvedValue({
        discNoBackfillDone: true,
    });
    mockPrisma.systemSettings.updateMany.mockResolvedValue({ count: 1 });

    mockPrisma.artist.findFirst.mockResolvedValue({
        id: "artist-1",
        name: "Test Artist",
        normalizedName: "test artist",
    });
    mockPrisma.artist.findMany.mockResolvedValue([]);
    mockPrisma.artist.findUnique.mockResolvedValue(null);
    mockPrisma.artist.create.mockResolvedValue({
        id: "artist-1",
        name: "Test Artist",
        normalizedName: "test artist",
    });
    mockPrisma.artist.update.mockResolvedValue({
        id: "artist-1",
        name: "Test Artist",
        normalizedName: "test artist",
    });
    mockPrisma.artist.deleteMany.mockResolvedValue({ count: 0 });

    mockPrisma.album.findFirst.mockResolvedValue({
        id: "album-1",
        title: "Test Album",
        coverUrl: null,
        location: "LIBRARY",
        rgMbid: "rg-album-1",
    });
    mockPrisma.album.findMany.mockResolvedValue([]);
    mockPrisma.album.findUnique.mockResolvedValue(null);
    mockPrisma.album.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.album.create.mockResolvedValue({
        id: "album-1",
        title: "Test Album",
        coverUrl: null,
        location: "LIBRARY",
        rgMbid: "rg-album-1",
    });
    mockPrisma.album.update.mockResolvedValue({});
    mockPrisma.album.deleteMany.mockResolvedValue({ count: 0 });

    mockPrisma.downloadJob.findMany.mockResolvedValue([]);
    mockPrisma.discoveryAlbum.findFirst.mockResolvedValue(null);
    mockPrisma.ownedAlbum.create.mockResolvedValue({});
    mockPrisma.ownedAlbum.upsert.mockResolvedValue({});

    mockUpdateArtistCountsInBatches.mockResolvedValue({
        updated: 0,
        failed: 0,
    });
    mockResolveAlbumCover.mockResolvedValue(null);
    mockComputeAudioStreamHash.mockResolvedValue("sha256:" + "ab".repeat(32));
    mockCreateMapping.mockResolvedValue({ id: "mapping-1" });
    mockBumpSearchCacheVersion.mockResolvedValue(undefined);
});

export {
    mockReaddir,
    mockStat,
    mockUnlink,
    mockExistsSync,
    mockParseFile,
    queueInstances,
    mockPrisma,
    mockLogger,
    mockUpdateArtistCountsInBatches,
    mockComputeAudioStreamHash,
    mockResolveAlbumCover,
    mockNormalizeArtistName,
    mockAreArtistNamesSimilar,
    mockCanonicalizeVariousArtists,
    mockExtractPrimaryArtist,
    mockParseArtistFromPath,
    mockExtractCoverArt,
    mockCreateMapping,
    mockRecomputeAlbumLoudness,
    mockBumpSearchCacheVersion,
    mockConfig,
    MusicScannerService,
    persistScannedTrack,
    isLossyAudioCodec,
    albumOrphanRetentionGuardWhere,
    artistOrphanRetentionGuardWhere,
    identityTrack,
    deferred,
    waitForCondition,
    makeDirent,
};

export type { TestIdentityTrack };
