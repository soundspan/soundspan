const mockReaddir = jest.fn();
const mockStat = jest.fn();
const mockUnlink = jest.fn();
const mockExistsSync = jest.fn();
const mockParseFile = jest.fn();
const queueInstances: Array<{ add: jest.Mock; onIdle: jest.Mock }> = [];

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
        upsert: jest.fn(),
    },
    libraryHealthRecord: {
        upsert: jest.fn(),
        deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
};

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);

const mockBackfillAllArtistCounts = jest.fn();
const mockComputeAudioStreamHash = jest.fn();
const mockGetAlbumCover = jest.fn();
const mockNormalizeArtistName = jest.fn((name: string) =>
    name.trim().toLowerCase(),
);
const mockAreArtistNamesSimilar = jest.fn(() => false);
const mockCanonicalizeVariousArtists = jest.fn((name: string) => name);
const mockExtractPrimaryArtist = jest.fn((name: string) => name);
const mockParseArtistFromPath = jest.fn((name: string) => name);
const mockExtractCoverArt = jest.fn();
const mockCreateMapping = jest.fn();
const mockRecomputeAlbumLoudness = jest.fn();
const mockConfig = {
    music: { transcodeCachePath: "/cache/transcodes" },
    workers: { trackRemovalRetentionDays: 90 },
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

        constructor() {
            this.add = jest.fn(async (task: () => Promise<unknown>) => task());
            this.onIdle = jest.fn(async () => undefined);
            queueInstances.push(this);
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

jest.mock("../deezer", () => ({
    deezerService: {
        getAlbumCover: mockGetAlbumCover,
    },
}));

jest.mock("../../utils/artistNormalization", () => ({
    normalizeArtistName: mockNormalizeArtistName,
    areArtistNamesSimilar: mockAreArtistNamesSimilar,
    canonicalizeVariousArtists: mockCanonicalizeVariousArtists,
    extractPrimaryArtist: mockExtractPrimaryArtist,
    parseArtistFromPath: mockParseArtistFromPath,
}));

jest.mock("../artistCountsService", () => ({
    backfillAllArtistCounts: mockBackfillAllArtistCounts,
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

jest.mock("../../config", () => ({
    config: mockConfig,
}));

const { MusicScannerService } =
    require("../musicScanner") as typeof import("../musicScanner");

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
    album: { rgMbid: string | null; location: string };
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
        album: { rgMbid: "rg-album-1", location: "LIBRARY" },
        ...overrides,
    };
}

describe("MusicScannerService.scanLibrary", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        queueInstances.length = 0;
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
        mockPrisma.libraryHealthRecord.deleteMany.mockResolvedValue({
            count: 0,
        });

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

        mockBackfillAllArtistCounts.mockResolvedValue(undefined);
        mockGetAlbumCover.mockResolvedValue(null);
        mockComputeAudioStreamHash.mockResolvedValue(
            "sha256:" + "ab".repeat(32),
        );
        mockCreateMapping.mockResolvedValue({ id: "mapping-1" });
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it("hides a federated duplicate when a matching local rip arrives", async () => {
        const scanner = new MusicScannerService();
        mockConfig.features.federation = true;
        const audioHash = "sha256:" + "ad".repeat(32);
        const local = identityTrack("local-new", "Artist/Track.flac", {
            audioHash,
        });
        const federated = {
            ...identityTrack("federated-1", "unused", { audioHash }),
            filePath: null,
            origin: "FEDERATED",
        };
        jest.spyOn(
            scanner as unknown as {
                findAudioFiles(path: string): Promise<string[]>;
            },
            "findAudioFiles",
        ).mockResolvedValue(["/music/Artist/Track.flac"]);
        mockPrisma.track.findMany.mockImplementation(async (args) => {
            if (
                args.where?.filePath?.in &&
                args.where?.origin === "LOCAL" &&
                args.where?.removedAt === null
            ) {
                return [local];
            }
            if (args.where?.filePath?.in) return [];
            if (args.where?.origin === "FEDERATED") return [federated];
            return [];
        });
        mockPrisma.track.upsert.mockResolvedValue(local);
        mockPrisma.track.updateMany.mockResolvedValueOnce({ count: 1 });
        mockComputeAudioStreamHash.mockResolvedValue(audioHash);

        await scanner.scanLibrary("/music");

        expect(mockPrisma.track.updateMany).toHaveBeenCalledWith({
            where: { id: "federated-1", dedupPinned: false },
            data: { dedupOfTrackId: "local-new" },
        });
        expect(mockCreateMapping).toHaveBeenCalledWith({
            trackId: "local-new",
            confidence: 1,
            source: "federation",
        });
    });

    it("does not rewrite a pinned federated duplicate during reconciliation", async () => {
        const scanner = new MusicScannerService();
        mockConfig.features.federation = true;
        const audioHash = "sha256:" + "ad".repeat(32);
        const local = identityTrack("local-new", "Artist/Track.flac", {
            audioHash,
        });
        const pinned = {
            ...identityTrack("federated-pinned", "unused", { audioHash }),
            filePath: null,
            origin: "FEDERATED",
            dedupPinned: true,
        };
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue([
            "/music/Artist/Track.flac",
        ]);
        jest.spyOn(scanner as any, "processAudioFile").mockResolvedValue(
            undefined,
        );
        mockPrisma.track.findMany.mockImplementation(async (args) => {
            if (
                args.where?.filePath?.in &&
                args.where?.origin === "LOCAL" &&
                args.where?.removedAt === null
            ) {
                return [local];
            }
            if (args.where?.filePath?.in) return [];
            if (args.where?.origin === "FEDERATED") return [pinned];
            return [];
        });
        mockPrisma.track.updateMany.mockResolvedValueOnce({ count: 0 });

        await scanner.scanLibrary("/music");

        expect(mockPrisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ dedupPinned: false }),
            }),
        );
        expect(mockPrisma.track.updateMany).toHaveBeenCalledWith({
            where: { id: "federated-pinned", dedupPinned: false },
            data: { dedupOfTrackId: "local-new" },
        });
        expect(mockCreateMapping).not.toHaveBeenCalled();
    });

    it("does not query federated candidates when federation is disabled", async () => {
        const scanner = new MusicScannerService();
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue([
            "/music/Artist/Track.flac",
        ]);
        jest.spyOn(scanner as any, "processAudioFile").mockResolvedValue(
            undefined,
        );

        await scanner.scanLibrary("/music");

        const federatedQueries = mockPrisma.track.findMany.mock.calls.filter(
            ([args]) => args.where?.origin === "FEDERATED",
        );
        expect(federatedQueries).toHaveLength(0);
    });

    it("reconciles successful new paths after counters are rebound to zero", async () => {
        const scanner = new MusicScannerService();
        mockConfig.features.federation = true;
        const local = identityTrack("local-rebound", "Artist/Track.flac");
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue([
            "/music/Artist/Track.flac",
        ]);
        jest.spyOn(scanner as any, "processAudioFile").mockResolvedValue(
            undefined,
        );
        jest.spyOn(scanner as any, "reviveRemovedTracks").mockResolvedValue(1);
        mockPrisma.track.findMany.mockImplementation(async (args) => {
            if (
                args.where?.origin === "LOCAL" &&
                args.where?.removedAt === null &&
                args.where?.filePath?.in
            ) {
                return [local];
            }
            return [];
        });

        const result = await scanner.scanLibrary("/music");

        expect(result.tracksAdded).toBe(0);
        expect(mockPrisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ origin: "FEDERATED" }),
            }),
        );
    });

    it("chunks newly added paths for federation reconciliation", async () => {
        const scanner = new MusicScannerService();
        mockConfig.features.federation = true;
        const audioFiles = Array.from(
            { length: 10_001 },
            (_, index) => `/music/Artist/Track-${index}.flac`,
        );
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue(
            audioFiles,
        );
        jest.spyOn(scanner as any, "processAudioFile").mockResolvedValue(
            undefined,
        );
        jest.spyOn(scanner as any, "reviveRemovedTracks").mockResolvedValue(0);

        await scanner.scanLibrary("/music");

        const reconciliationQueries =
            mockPrisma.track.findMany.mock.calls.filter(
                ([args]) =>
                    args.where?.origin === "LOCAL" &&
                    args.where?.removedAt === null &&
                    args.where?.filePath?.in,
            );
        expect(reconciliationQueries).toHaveLength(2);
        expect(reconciliationQueries[0][0].where.filePath.in).toHaveLength(
            10_000,
        );
        expect(reconciliationQueries[1][0].where.filePath.in).toHaveLength(1);
    });

    it("constrains positional federation candidates to the release group", async () => {
        const scanner = new MusicScannerService();
        mockConfig.features.federation = true;
        const local = identityTrack("local-new", "Artist/Track.flac");
        const otherAlbum = {
            ...identityTrack("federated-other", "unused", {
                album: { rgMbid: "rg-other", location: "FEDERATED" },
            }),
            filePath: null,
            origin: "FEDERATED",
        };
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue([
            "/music/Artist/Track.flac",
        ]);
        jest.spyOn(scanner as any, "processAudioFile").mockResolvedValue(
            undefined,
        );
        jest.spyOn(scanner as any, "reviveRemovedTracks").mockResolvedValue(0);
        mockPrisma.track.findMany.mockImplementation(async (args) => {
            if (
                args.where?.origin === "LOCAL" &&
                args.where?.removedAt === null &&
                args.where?.filePath?.in
            ) {
                return [local];
            }
            if (args.where?.origin === "FEDERATED") return [otherAlbum];
            return [];
        });

        await scanner.scanLibrary("/music");

        const positionalQuery = mockPrisma.track.findMany.mock.calls.find(
            ([args]) =>
                args.where?.origin === "FEDERATED" &&
                args.where?.discNo === 1 &&
                args.where?.trackNo === 3,
        );
        expect(positionalQuery?.[0].where.album).toEqual(
            expect.objectContaining({
                location: "FEDERATED",
                OR: expect.arrayContaining([{ rgMbid: "rg-album-1" }]),
            }),
        );
        expect(mockPrisma.track.update).not.toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: "federated-other" } }),
        );
    });

    it("does not position-dedup a DISCOVER download against a peer track", async () => {
        const scanner = new MusicScannerService();
        mockConfig.features.federation = true;
        const local = identityTrack("discover-new", "Discover/Track.flac", {
            album: { rgMbid: "rg-album-1", location: "DISCOVER" },
        });
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue([
            "/music/Discover/Track.flac",
        ]);
        jest.spyOn(scanner as any, "processAudioFile").mockResolvedValue(
            undefined,
        );
        jest.spyOn(scanner as any, "reviveRemovedTracks").mockResolvedValue(0);
        mockPrisma.track.findMany.mockImplementation(async (args) => {
            if (
                args.where?.origin === "LOCAL" &&
                args.where?.removedAt === null &&
                args.where?.filePath?.in
            ) {
                return [local];
            }
            if (args.where?.origin === "FEDERATED") {
                return [
                    {
                        ...local,
                        id: "federated-1",
                        filePath: null,
                        origin: "FEDERATED",
                        album: {
                            rgMbid: "rg-album-1",
                            location: "FEDERATED",
                        },
                    },
                ];
            }
            return [];
        });

        await scanner.scanLibrary("/music");

        expect(
            mockPrisma.track.findMany.mock.calls.some(
                ([args]) => args.where?.origin === "FEDERATED",
            ),
        ).toBe(false);
        expect(mockPrisma.track.update).not.toHaveBeenCalled();
    });

    it("chunks active-scan path lookups beyond the bind-parameter batch size", async () => {
        const scanner = new MusicScannerService();
        const audioFiles = Array.from(
            { length: 10_001 },
            (_, index) => `/music/Artist/Track-${index}.flac`,
        );
        const activeTracks = audioFiles.map((audioFile, index) =>
            identityTrack(`track-${index}`, audioFile.slice("/music/".length), {
                fileModified: new Date("2026-03-01T00:00:00.000Z"),
            }),
        );
        jest.spyOn(
            scanner as unknown as {
                findAudioFiles(path: string): Promise<string[]>;
            },
            "findAudioFiles",
        ).mockResolvedValue(audioFiles);
        mockPrisma.track.findMany.mockImplementation(async (args) => {
            if (args.where?.removedAt === null) return activeTracks;
            if (args.where?.filePath?.in) return [];
            throw new Error("scan track lookup was not chunked");
        });

        await expect(scanner.scanLibrary("/music")).resolves.toEqual(
            expect.objectContaining({
                tracksAdded: 0,
                tracksUpdated: 0,
                tracksRemoved: 0,
            }),
        );

        const pathQueries = mockPrisma.track.findMany.mock.calls.filter(
            ([args]) => args.where?.filePath?.in,
        );
        expect(pathQueries).toHaveLength(2);
        expect(pathQueries[0][0].where.filePath.in).toHaveLength(10_000);
        expect(pathQueries[1][0].where.filePath.in).toHaveLength(1);
    });

    it("does not load or mark federated tracks as missing", async () => {
        const scanner = new MusicScannerService();
        const federatedTrack = identityTrack(
            "track-federated",
            "Peer/Track.flac",
            { origin: "FEDERATED" },
        );
        jest.spyOn(
            scanner as unknown as {
                findAudioFiles(path: string): Promise<string[]>;
            },
            "findAudioFiles",
        ).mockResolvedValue([]);
        mockPrisma.track.findMany.mockImplementation(async (args) =>
            args.where?.origin === "LOCAL" ? [] : [federatedTrack],
        );

        await expect(scanner.scanLibrary("/music")).resolves.toEqual(
            expect.objectContaining({ tracksRemoved: 0 }),
        );

        expect(mockPrisma.track.findMany).toHaveBeenCalledWith({
            where: {
                origin: "LOCAL",
                filePath: { not: null },
                removedAt: null,
            },
            select: expect.objectContaining({ filePath: true }),
        });
        expect(mockPrisma.libraryHealthRecord.upsert).not.toHaveBeenCalled();
        expect(mockPrisma.track.updateMany).not.toHaveBeenCalled();
    });

    it("chunks moved-track candidate path lookups beyond the bind-parameter batch size", async () => {
        const scanner = new MusicScannerService();
        const missing = identityTrack("track-old", "Old/Track.flac");
        const candidatePaths = Array.from(
            { length: 10_001 },
            (_, index) => `New/Track-${index}.flac`,
        );
        mockPrisma.track.findMany.mockResolvedValue([]);

        await expect(
            (
                scanner as unknown as {
                    rebindMovedTracks(
                        missingTracks: TestIdentityTrack[],
                        paths: readonly string[],
                    ): Promise<unknown>;
                }
            ).rebindMovedTracks([missing], candidatePaths),
        ).resolves.toEqual({
            unmatched: [missing],
            rebound: 0,
            consumedCandidatePaths: [],
        });

        expect(mockPrisma.track.findMany).toHaveBeenCalledTimes(2);
        expect(
            mockPrisma.track.findMany.mock.calls[0][0].where.filePath.in,
        ).toHaveLength(10_000);
        expect(
            mockPrisma.track.findMany.mock.calls[1][0].where.filePath.in,
        ).toHaveLength(1);
    });

    it("contains P2025 races while re-binding a moved track", async () => {
        const scanner = new MusicScannerService();
        const audioHash = "sha256:" + "0f".repeat(32);
        const missing = identityTrack("track-old", "Old/Track.flac", {
            audioHash,
        });
        const candidate = identityTrack("track-new", "New/Track.flac", {
            audioHash,
        });
        mockPrisma.track.findMany.mockResolvedValue([candidate]);
        mockPrisma.track.delete.mockRejectedValueOnce(
            Object.assign(new Error("record disappeared"), { code: "P2025" }),
        );

        await expect(
            (
                scanner as unknown as {
                    rebindMovedTracks(
                        missingTracks: TestIdentityTrack[],
                        paths: readonly string[],
                    ): Promise<unknown>;
                }
            ).rebindMovedTracks([missing], [candidate.filePath]),
        ).resolves.toEqual({
            unmatched: [missing],
            rebound: 0,
            consumedCandidatePaths: [],
        });
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Skipped re-binding track-old"),
        );
    });

    it("clears loudness when a lower-tier rebind cannot prove audio unchanged", async () => {
        const scanner = new MusicScannerService();
        const storedHash = "sha256:" + "1f".repeat(32);
        const storedHashedAt = new Date("2026-01-01T00:01:00.000Z");
        const missing = identityTrack("track-old", "Old/Track.flac", {
            audioHash: storedHash,
            audioHashedAt: storedHashedAt,
            recordingMbid: "recording-1",
        });
        const candidate = identityTrack("track-new", "New/Track.flac", {
            audioHash: null,
            recordingMbid: "recording-1",
        });
        mockPrisma.track.findMany.mockResolvedValue([candidate]);

        await (
            scanner as unknown as {
                rebindMovedTracks(
                    missingTracks: TestIdentityTrack[],
                    paths: readonly string[],
                ): Promise<unknown>;
            }
        ).rebindMovedTracks([missing], [candidate.filePath]);

        expect(mockPrisma.track.update).toHaveBeenCalledWith({
            where: { id: "track-old" },
            data: expect.objectContaining({
                filePath: "New/Track.flac",
                loudnessLufs: null,
                truePeakDb: null,
            }),
        });
        const [updateArg] = mockPrisma.track.update.mock.calls[0];
        expect(updateArg.data).not.toHaveProperty("audioHash");
        expect(updateArg.data).not.toHaveProperty("audioHashedAt");
        expect(mockPrisma.trackEmbedding.deleteMany).not.toHaveBeenCalled();
        expect(mockPrisma.transcodedFile.deleteMany).not.toHaveBeenCalled();
        expect(mockRecomputeAlbumLoudness).toHaveBeenCalledWith(mockPrisma, [
            "album-1",
            "album-1",
        ]);
    });

    it("skips the removed-track revival pool when retention is zero", async () => {
        const scanner = new MusicScannerService();
        mockConfig.workers.trackRemovalRetentionDays = 0;

        await expect(
            (
                scanner as unknown as {
                    reviveRemovedTracks(
                        paths: readonly string[],
                    ): Promise<number>;
                }
            ).reviveRemovedTracks(["New/Track.flac"]),
        ).resolves.toBe(0);
        expect(mockPrisma.track.findMany).not.toHaveBeenCalled();
    });

    it("skips unchanged files without parsing metadata again", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Track.mp3";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockPrisma.track.findMany.mockResolvedValue([
            {
                id: "track-1",
                filePath: "Artist/Track.mp3",
                fileModified: new Date("2026-02-10T00:00:00.000Z"),
            },
        ]);
        mockStat.mockResolvedValue({
            mtime: new Date("2026-02-01T00:00:00.000Z"),
            size: 777,
        });

        const result = await scanner.scanLibrary("/music");

        expect(result).toEqual(
            expect.objectContaining({
                tracksAdded: 0,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
            }),
        );
        expect(mockParseFile).not.toHaveBeenCalled();
        expect(mockPrisma.track.upsert).not.toHaveBeenCalled();
        expect(queueInstances[0].add).toHaveBeenCalledTimes(1);
        expect(queueInstances[0].onIdle).toHaveBeenCalledTimes(1);
    });

    it("reprocesses unchanged files when disc-number backfill is pending", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Track.mp3";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockPrisma.systemSettings.findFirst.mockResolvedValue({
            discNoBackfillDone: false,
        });
        mockPrisma.track.findMany.mockResolvedValue([
            {
                id: "track-1",
                filePath: "Artist/Track.mp3",
                fileModified: new Date("2026-02-10T00:00:00.000Z"),
            },
        ]);
        mockStat.mockResolvedValue({
            mtime: new Date("2026-02-01T00:00:00.000Z"),
            size: 777,
        });

        const result = await scanner.scanLibrary("/music");

        expect(result).toEqual(
            expect.objectContaining({
                tracksAdded: 0,
                tracksUpdated: 1,
                tracksRemoved: 0,
                errors: [],
            }),
        );
        expect(mockParseFile).toHaveBeenCalledWith(audioFile);
        expect(mockParseFile).not.toHaveBeenCalledWith(audioFile, {
            duration: true,
        });
        expect(mockPrisma.systemSettings.updateMany).toHaveBeenCalledWith({
            data: { discNoBackfillDone: true },
        });
    });

    it("processes new files and upserts tracks", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Test Track.flac";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);

        const result = await scanner.scanLibrary("/music");

        expect(result).toEqual(
            expect.objectContaining({
                tracksAdded: 1,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
            }),
        );
        expect(mockParseFile).toHaveBeenCalledWith(audioFile);
        expect(mockParseFile).not.toHaveBeenCalledWith(audioFile, {
            duration: true,
        });
        expect(mockPrisma.track.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { filePath: "Artist/Test Track.flac" },
                create: expect.objectContaining({
                    albumId: "album-1",
                    title: "Test Track",
                    filePath: "Artist/Test Track.flac",
                    mime: "audio/flac",
                    origin: "LOCAL",
                }),
                update: expect.objectContaining({
                    albumId: "album-1",
                    title: "Test Track",
                    mime: "audio/flac",
                }),
            }),
        );
        expect(mockBackfillAllArtistCounts).toHaveBeenCalledTimes(1);
    });

    it("populates identity keys (audioHash, recordingMbid, isrc) for new files", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Test Track.flac";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockParseFile.mockResolvedValue({
            common: {
                title: "Test Track",
                track: { no: 3 },
                disk: { no: 1 },
                albumartist: "Test Artist",
                album: "Test Album",
                year: 2024,
                musicbrainz_recordingid: "b1a9c0e5-d987-4042-ae91-78d6a3267d69",
                isrc: ["USRC17607839", "GBUM71029601"],
            },
            format: { duration: 218.7, codec: "audio/flac" },
        } as any);
        const expectedHash = "sha256:" + "cd".repeat(32);
        mockComputeAudioStreamHash.mockResolvedValue(expectedHash);

        await scanner.scanLibrary("/music");

        expect(mockComputeAudioStreamHash).toHaveBeenCalledWith(audioFile);
        const identityFields = {
            audioHash: expectedHash,
            audioHashedAt: expect.any(Date),
            recordingMbid: "b1a9c0e5-d987-4042-ae91-78d6a3267d69",
            isrc: "USRC17607839",
        };
        expect(mockPrisma.track.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining(identityFields),
                update: expect.objectContaining(identityFields),
            }),
        );
    });

    it("stores null identity keys when tags carry none", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Test Track.flac";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);

        await scanner.scanLibrary("/music");

        expect(mockPrisma.track.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    recordingMbid: null,
                    isrc: null,
                }),
            }),
        );
    });

    it("does not re-hash a backfill-reprocessed file that already has a hash", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Track.mp3";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockPrisma.systemSettings.findFirst.mockResolvedValue({
            discNoBackfillDone: false,
        });
        mockPrisma.track.findMany.mockResolvedValue([
            {
                id: "track-1",
                filePath: "Artist/Track.mp3",
                fileModified: new Date("2026-02-10T00:00:00.000Z"),
                audioHash: "sha256:" + "ee".repeat(32),
            },
        ]);
        mockStat.mockResolvedValue({
            mtime: new Date("2026-02-01T00:00:00.000Z"),
            size: 777,
        });

        await scanner.scanLibrary("/music");

        expect(mockComputeAudioStreamHash).not.toHaveBeenCalled();
        const [upsertArg] = mockPrisma.track.upsert.mock.calls[0];
        expect(upsertArg.update).not.toHaveProperty("audioHash");
        expect(upsertArg.update).not.toHaveProperty("audioHashedAt");
    });

    it("hashes a backfill-reprocessed file that lacks a hash", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Track.mp3";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockPrisma.systemSettings.findFirst.mockResolvedValue({
            discNoBackfillDone: false,
        });
        mockPrisma.track.findMany.mockResolvedValue([
            {
                id: "track-1",
                filePath: "Artist/Track.mp3",
                fileModified: new Date("2026-02-10T00:00:00.000Z"),
                audioHash: null,
            },
        ]);
        mockStat.mockResolvedValue({
            mtime: new Date("2026-02-01T00:00:00.000Z"),
            size: 777,
        });

        await scanner.scanLibrary("/music");

        expect(mockComputeAudioStreamHash).toHaveBeenCalledWith(audioFile);
    });

    it("preserves a stored hash when a changed file fails to hash", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Track.mp3";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockPrisma.track.findMany.mockResolvedValue([
            {
                id: "track-1",
                filePath: "Artist/Track.mp3",
                fileModified: new Date("2026-01-01T00:00:00.000Z"),
                audioHash: "sha256:" + "ee".repeat(32),
            },
        ]);
        mockStat.mockResolvedValue({
            mtime: new Date("2026-02-01T00:00:00.000Z"),
            size: 777,
        });
        mockComputeAudioStreamHash.mockResolvedValue(null);
        mockPrisma.track.upsert.mockResolvedValueOnce({ id: "track-1" });

        await scanner.scanLibrary("/music");

        expect(mockComputeAudioStreamHash).toHaveBeenCalledWith(audioFile);
        const [upsertArg] = mockPrisma.track.upsert.mock.calls[0];
        expect(upsertArg.update).not.toHaveProperty("audioHash");
        expect(upsertArg.update).not.toHaveProperty("audioHashedAt");
        expect(mockPrisma.track.update).toHaveBeenCalledWith({
            where: { id: "track-1" },
            data: { loudnessLufs: null, truePeakDb: null },
        });
        expect(mockRecomputeAlbumLoudness).toHaveBeenCalledWith(mockPrisma, [
            "album-1",
        ]);
        expect(mockPrisma.trackEmbedding.deleteMany).not.toHaveBeenCalled();
        expect(mockPrisma.transcodedFile.deleteMany).not.toHaveBeenCalled();
    });

    it("writes null hash fields when an unhashed changed file fails to hash", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Track.mp3";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockPrisma.track.findMany.mockResolvedValue([
            {
                id: "track-1",
                filePath: "Artist/Track.mp3",
                fileModified: new Date("2026-01-01T00:00:00.000Z"),
                audioHash: null,
            },
        ]);
        mockStat.mockResolvedValue({
            mtime: new Date("2026-02-01T00:00:00.000Z"),
            size: 777,
        });
        mockComputeAudioStreamHash.mockResolvedValue(null);
        mockPrisma.track.upsert.mockResolvedValueOnce({ id: "track-1" });

        await scanner.scanLibrary("/music");

        expect(mockPrisma.track.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: expect.objectContaining({
                    audioHash: null,
                    audioHashedAt: null,
                }),
            }),
        );
        expect(mockPrisma.track.update).toHaveBeenCalledWith({
            where: { id: "track-1" },
            data: { loudnessLufs: null, truePeakDb: null },
        });
        expect(mockRecomputeAlbumLoudness).toHaveBeenCalledWith(mockPrisma, [
            "album-1",
        ]);
        expect(mockPrisma.trackEmbedding.deleteMany).not.toHaveBeenCalled();
        expect(mockPrisma.transcodedFile.deleteMany).not.toHaveBeenCalled();
    });

    it("recomputes both albums when unchanged audio is reassigned", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Track.mp3";
        const audioHash = "sha256:" + "ef".repeat(32);
        const existing = identityTrack("track-1", "Artist/Track.mp3", {
            albumId: "album-old",
            audioHash,
        });

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockPrisma.track.findMany.mockResolvedValue([existing]);
        mockStat.mockResolvedValue({
            mtime: new Date("2026-02-01T00:00:00.000Z"),
            size: 777,
        });
        mockComputeAudioStreamHash.mockResolvedValue(audioHash);
        mockPrisma.album.findFirst.mockResolvedValue({
            id: "album-new",
            title: "Test Album",
            coverUrl: null,
            location: "LIBRARY",
            rgMbid: "rg-album-new",
        });
        mockPrisma.track.upsert.mockResolvedValue({ id: "track-1" });

        await scanner.scanLibrary("/music");

        expect(mockPrisma.track.update).not.toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ loudnessLufs: null }),
            }),
        );
        expect(mockRecomputeAlbumLoudness).toHaveBeenCalledWith(mockPrisma, [
            "album-old",
            "album-new",
        ]);
    });

    it("recomputes the album when same-hash duration changes", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Track.mp3";
        const audioHash = "sha256:" + "f0".repeat(32);
        const existing = identityTrack("track-1", "Artist/Track.mp3", {
            audioHash,
            duration: 218,
        });

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockPrisma.track.findMany.mockResolvedValue([existing]);
        mockParseFile.mockResolvedValue({
            common: {
                title: "Test Track",
                track: { no: 3 },
                disk: { no: 1 },
                albumartist: "Test Artist",
                album: "Test Album",
            },
            format: { duration: 200, codec: "audio/flac" },
        } as any);
        mockComputeAudioStreamHash.mockResolvedValue(audioHash);
        mockPrisma.track.upsert.mockResolvedValue({ id: "track-1" });

        await scanner.scanLibrary("/music");

        expect(mockRecomputeAlbumLoudness).toHaveBeenCalledWith(mockPrisma, [
            "album-1",
            "album-1",
        ]);
        expect(mockPrisma.libraryHealthRecord.deleteMany).toHaveBeenCalledWith({
            where: { trackId: "track-1" },
        });
    });

    it("keeps same-hash unchanged-duration updates on the fast path", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Track.mp3";
        const audioHash = "sha256:" + "f1".repeat(32);
        const existing = identityTrack("track-1", "Artist/Track.mp3", {
            audioHash,
            duration: 218,
        });

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockPrisma.track.findMany.mockResolvedValue([existing]);
        mockComputeAudioStreamHash.mockResolvedValue(audioHash);
        mockPrisma.track.upsert.mockResolvedValue({ id: "track-1" });

        await scanner.scanLibrary("/music");

        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        expect(mockRecomputeAlbumLoudness).not.toHaveBeenCalled();
        expect(mockPrisma.libraryHealthRecord.deleteMany).toHaveBeenCalledWith({
            where: { trackId: "track-1" },
        });
    });

    it("re-parses with duration:true only when the cheap parse lacks a duration (opus/ogg)", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/YouTube Rip.opus";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);

        const common = {
            title: "YouTube Rip",
            track: { no: 1 },
            disk: { no: 1 },
            album: "Test Album",
            artist: "Test Artist",
        };
        // Header-only parse: opus keeps duration in the last page → missing.
        mockParseFile.mockImplementation(
            async (_path: string, options?: { duration?: boolean }) => {
                if (options?.duration) {
                    return {
                        common,
                        format: { duration: 145.6, codec: "opus" },
                    } as any;
                }
                return { common, format: { codec: "opus" } } as any;
            },
        );

        const result = await scanner.scanLibrary("/music");

        expect(result.errors).toEqual([]);
        expect(mockParseFile).toHaveBeenCalledWith(audioFile);
        expect(mockParseFile).toHaveBeenCalledWith(audioFile, {
            duration: true,
        });
        expect(mockPrisma.track.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    duration: 145,
                }),
            }),
        );
    });

    it("resolves albums by release-group MBID so same-titled albums never merge", async () => {
        const scanner = new MusicScannerService();

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue(["/music/Crystal Castles/Crystal Castles/01.flac"]);
        // A tagged file from the 2010 self-titled album (distinct release group).
        mockParseFile.mockResolvedValue({
            common: {
                title: "Fainting Spells",
                track: { no: 1 },
                disk: { no: 1 },
                album: "Crystal Castles",
                albumartist: "Crystal Castles",
                year: 2010,
                musicbrainz_releasegroupid: "rg-2010",
            },
            format: { duration: 200, codec: "audio/flac" },
        } as any);
        // No existing album carries this release group.
        mockPrisma.album.findFirst.mockResolvedValue(null);
        mockPrisma.album.create.mockResolvedValue({
            id: "album-2010",
            title: "Crystal Castles",
            coverUrl: null,
            location: "LIBRARY",
            rgMbid: "rg-2010",
        });

        await scanner.scanLibrary("/music");

        // The lookup keys on the unique release-group MBID — NOT the title —
        // so the 2010 album is not found by the 2008 album's title and merged.
        expect(mockPrisma.album.findFirst).toHaveBeenCalledWith({
            where: { artistId: "artist-1", rgMbid: "rg-2010" },
        });
        // Not found by rgMbid -> a separate album is created.
        expect(mockPrisma.album.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    title: "Crystal Castles",
                    rgMbid: "rg-2010",
                }),
            }),
        );
    });

    it("falls back to a title match within the artist for un-tagged files", async () => {
        const scanner = new MusicScannerService();

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue(["/music/Artist/Untagged.flac"]);
        // Default parseFile mock has no musicbrainz_releasegroupid (un-tagged).
        mockPrisma.album.findFirst.mockResolvedValue(null);
        mockPrisma.album.create.mockResolvedValue({
            id: "album-temp",
            title: "Test Album",
            coverUrl: null,
            location: "LIBRARY",
            rgMbid: "temp-x",
        });

        await scanner.scanLibrary("/music");

        // Un-tagged files match by exact title against ALL of the artist's
        // albums (real rgMbid or temp-) so a mixed-tag folder does not split
        // into duplicate same-titled albums. Tagged files never reach this
        // path, so distinct release groups still never merge.
        expect(mockPrisma.album.findFirst).toHaveBeenCalledWith({
            where: {
                artistId: "artist-1",
                title: "Test Album",
            },
        });
    });

    it("re-binds a retagged and renamed file by audio hash without resetting analysis", async () => {
        const scanner = new MusicScannerService();
        const oldHash = "sha256:" + "11".repeat(32);
        const oldTrack = identityTrack(
            "track-old",
            "Artist/Album/01 Old Name.flac",
            { audioHash: oldHash },
        );
        const candidate = identityTrack(
            "track-new",
            "Artist/Album/01 Retagged Name.flac",
            {
                audioHash: oldHash,
                title: "Retagged Title",
                fileModified: new Date("2026-02-01T00:00:00.000Z"),
            },
        );

        jest.spyOn(
            scanner as unknown as {
                findAudioFiles(path: string): Promise<string[]>;
            },
            "findAudioFiles",
        ).mockResolvedValue(["/music/Artist/Album/01 Retagged Name.flac"]);
        mockPrisma.track.findMany
            .mockResolvedValueOnce([oldTrack])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([candidate]);
        mockPrisma.track.upsert.mockResolvedValueOnce(candidate);

        const result = await scanner.scanLibrary("/music");

        expect(result).toEqual(
            expect.objectContaining({
                tracksAdded: 0,
                tracksUpdated: 1,
                tracksRemoved: 0,
            }),
        );
        expect(mockPrisma.track.delete).toHaveBeenCalledWith({
            where: { id: "track-new" },
        });
        expect(mockPrisma.track.update).toHaveBeenCalledWith({
            where: { id: "track-old" },
            data: expect.objectContaining({
                filePath: "Artist/Album/01 Retagged Name.flac",
                title: "Retagged Title",
                audioHash: oldHash,
            }),
        });
        const oldUpdate = mockPrisma.track.update.mock.calls.find(
            ([args]) => args.where.id === "track-old",
        )?.[0];
        expect(oldUpdate?.data).not.toHaveProperty("analysisStatus");
        expect(mockPrisma.trackEmbedding.deleteMany).not.toHaveBeenCalled();
        expect(mockPrisma.transcodedFile.deleteMany).not.toHaveBeenCalled();
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.stringContaining(
                "Artist/Album/01 Old Name.flac → Artist/Album/01 Retagged Name.flac",
            ),
        );
    });

    it("re-binds an extension upgrade by recording id and resets derived audio data", async () => {
        const scanner = new MusicScannerService();
        const oldTrack = identityTrack(
            "track-old",
            "Artist/Album/01 Song.mp3",
            {
                audioHash: "sha256:" + "22".repeat(32),
                recordingMbid: "recording-1",
                mime: "audio/mpeg",
            },
        );
        const candidate = identityTrack(
            "track-new",
            "Artist/Album/01 Song.flac",
            {
                audioHash: "sha256:" + "33".repeat(32),
                audioHashedAt: new Date("2026-02-01T00:01:00.000Z"),
                recordingMbid: "recording-1",
                fileModified: new Date("2026-02-01T00:00:00.000Z"),
                fileSize: 8_192,
            },
        );

        jest.spyOn(
            scanner as unknown as {
                findAudioFiles(path: string): Promise<string[]>;
            },
            "findAudioFiles",
        ).mockResolvedValue(["/music/Artist/Album/01 Song.flac"]);
        mockPrisma.track.findMany
            .mockResolvedValueOnce([oldTrack])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([candidate]);
        mockPrisma.track.upsert.mockResolvedValueOnce(candidate);
        mockPrisma.track.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.transcodedFile.findMany.mockResolvedValueOnce([
            { cachePath: "track-old-high.mp3" },
        ]);

        const result = await scanner.scanLibrary("/music");

        expect(result).toEqual(
            expect.objectContaining({
                tracksAdded: 0,
                tracksUpdated: 1,
                tracksRemoved: 0,
            }),
        );
        expect(mockPrisma.track.updateMany).toHaveBeenCalledWith({
            where: { id: "track-old" },
            data: expect.objectContaining({
                filePath: "Artist/Album/01 Song.flac",
                audioHash: candidate.audioHash,
                analysisStatus: "pending",
                analyzedAt: null,
                analysisError: null,
                analysisRetryCount: 0,
                analysisStartedAt: null,
                vibeAnalysisStatus: "pending",
                vibeAnalysisError: null,
                vibeAnalysisRetryCount: 0,
                vibeAnalysisStartedAt: null,
                vibeAnalysisStatusUpdatedAt: expect.any(Date),
                vibeAnalysisGeneration: { increment: 1 },
            }),
        });
        expect(mockPrisma.trackEmbedding.deleteMany).toHaveBeenCalledWith({
            where: { trackId: "track-old" },
        });
        expect(mockPrisma.transcodedFile.deleteMany).toHaveBeenCalledWith({
            where: { trackId: "track-old" },
        });
        expect(mockUnlink).toHaveBeenCalledWith(
            "/cache/transcodes/track-old-high.mp3",
        );
    });

    it("keeps a same-path replacement id and invalidates derived audio data", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Album/01 Song.flac";
        const oldTrack = identityTrack(
            "track-old",
            "Artist/Album/01 Song.flac",
            { audioHash: "sha256:" + "44".repeat(32) },
        );
        const newHash = "sha256:" + "55".repeat(32);

        jest.spyOn(
            scanner as unknown as {
                findAudioFiles(path: string): Promise<string[]>;
            },
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockPrisma.track.findMany.mockResolvedValueOnce([oldTrack]);
        mockPrisma.track.upsert.mockResolvedValueOnce({ id: "track-old" });
        mockPrisma.track.updateMany.mockResolvedValueOnce({ count: 1 });
        mockComputeAudioStreamHash.mockResolvedValueOnce(newHash);
        mockPrisma.transcodedFile.findMany.mockResolvedValueOnce([
            { cachePath: "track-old-medium.mp3" },
        ]);

        const result = await scanner.scanLibrary("/music");

        expect(result).toEqual(
            expect.objectContaining({
                tracksAdded: 0,
                tracksUpdated: 1,
                tracksRemoved: 0,
            }),
        );
        expect(mockPrisma.track.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { filePath: "Artist/Album/01 Song.flac" },
                update: expect.objectContaining({ audioHash: newHash }),
            }),
        );
        expect(mockPrisma.track.updateMany).toHaveBeenCalledWith({
            where: { id: "track-old" },
            data: expect.objectContaining({
                analysisStatus: "pending",
                analyzedAt: null,
                analysisRetryCount: 0,
                vibeAnalysisStatus: "pending",
                vibeAnalysisRetryCount: 0,
                vibeAnalysisGeneration: { increment: 1 },
            }),
        });
        expect(mockPrisma.trackEmbedding.deleteMany).toHaveBeenCalledWith({
            where: { trackId: "track-old" },
        });
        expect(mockPrisma.transcodedFile.deleteMany).toHaveBeenCalledWith({
            where: { trackId: "track-old" },
        });
        expect(mockUnlink).toHaveBeenCalledWith(
            "/cache/transcodes/track-old-medium.mp3",
        );
        expect(mockPrisma.track.delete).not.toHaveBeenCalled();
        expect(
            mockPrisma.$transaction.mock.invocationCallOrder[0],
        ).toBeLessThan(mockPrisma.track.upsert.mock.invocationCallOrder[0]);
    });

    it("revives same-hash audio without clearing its measurements", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Album/01 Song.flac";
        const audioHash = "sha256:" + "57".repeat(32);
        const removedTrack = identityTrack(
            "track-removed",
            "Artist/Album/01 Song.flac",
            {
                audioHash,
                fileModified: new Date("2026-03-01T00:00:00.000Z"),
                removedAt: new Date("2026-02-01T00:00:00.000Z"),
            },
        );

        jest.spyOn(
            scanner as unknown as {
                findAudioFiles(path: string): Promise<string[]>;
            },
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockStat.mockResolvedValueOnce({
            mtime: new Date("2026-02-15T00:00:00.000Z"),
            size: 2_048,
        });
        mockPrisma.track.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([removedTrack]);
        mockPrisma.track.upsert.mockResolvedValueOnce({
            ...removedTrack,
            removedAt: null,
        });
        mockComputeAudioStreamHash.mockResolvedValueOnce(audioHash);

        const result = await scanner.scanLibrary("/music");

        expect(result).toEqual(
            expect.objectContaining({
                tracksAdded: 0,
                tracksUpdated: 1,
                tracksRemoved: 0,
            }),
        );
        expect(mockParseFile).toHaveBeenCalledWith(audioFile);
        expect(mockComputeAudioStreamHash).toHaveBeenCalledWith(audioFile);
        expect(mockPrisma.track.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { filePath: "Artist/Album/01 Song.flac" },
                update: expect.objectContaining({ removedAt: null }),
            }),
        );
        expect(mockPrisma.libraryHealthRecord.deleteMany).toHaveBeenCalledWith({
            where: { trackId: "track-removed" },
        });
        expect(mockRecomputeAlbumLoudness).toHaveBeenCalledWith(mockPrisma, [
            "album-1",
            "album-1",
        ]);
        expect(mockPrisma.trackEmbedding.deleteMany).not.toHaveBeenCalled();
        expect(mockPrisma.track.update).not.toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ loudnessLufs: null }),
            }),
        );
    });

    it("revives a removed track at a new path from the bounded removed pool", async () => {
        jest.spyOn(Date, "now").mockReturnValue(
            new Date("2026-03-01T00:00:00.000Z").getTime(),
        );
        const scanner = new MusicScannerService();
        const audioFile = "/music/New/01 Song.flac";
        const audioHash = "sha256:" + "58".repeat(32);
        const removedTrack = identityTrack(
            "track-removed",
            "Old/01 Song.flac",
            {
                audioHash,
                removedAt: new Date("2026-02-01T00:00:00.000Z"),
            },
        );
        const candidate = identityTrack("track-new", "New/01 Song.flac", {
            audioHash,
            fileModified: new Date("2026-02-15T00:00:00.000Z"),
        });

        jest.spyOn(
            scanner as unknown as {
                findAudioFiles(path: string): Promise<string[]>;
            },
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockComputeAudioStreamHash.mockResolvedValueOnce(audioHash);
        mockPrisma.track.upsert.mockResolvedValueOnce(candidate);
        mockPrisma.track.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([removedTrack])
            .mockResolvedValueOnce([candidate]);

        const result = await scanner.scanLibrary("/music");

        expect(mockPrisma.track.findMany).toHaveBeenNthCalledWith(1, {
            where: {
                origin: "LOCAL",
                filePath: { not: null },
                removedAt: null,
            },
            select: expect.objectContaining({ removedAt: true }),
        });
        expect(mockPrisma.track.findMany).toHaveBeenNthCalledWith(2, {
            where: {
                origin: "LOCAL",
                filePath: { in: ["New/01 Song.flac"] },
            },
            select: expect.objectContaining({ removedAt: true }),
        });
        expect(mockPrisma.track.findMany).toHaveBeenNthCalledWith(3, {
            where: {
                origin: "LOCAL",
                filePath: { not: null },
                removedAt: {
                    not: null,
                    gte: new Date("2025-12-01T00:00:00.000Z"),
                },
            },
            orderBy: { removedAt: "desc" },
            take: 10_000,
            select: expect.objectContaining({ removedAt: true }),
        });
        expect(mockPrisma.track.delete).toHaveBeenCalledWith({
            where: { id: "track-new" },
        });
        expect(mockPrisma.track.update).toHaveBeenCalledWith({
            where: { id: "track-removed" },
            data: expect.objectContaining({
                filePath: "New/01 Song.flac",
                audioHash,
                removedAt: null,
            }),
        });
        expect(mockPrisma.libraryHealthRecord.deleteMany).toHaveBeenCalledWith({
            where: { trackId: "track-removed" },
        });
        expect(mockRecomputeAlbumLoudness).toHaveBeenCalledWith(mockPrisma, [
            "album-1",
            "album-1",
        ]);
        expect(result).toEqual(
            expect.objectContaining({
                tracksAdded: 0,
                tracksUpdated: 1,
                tracksRemoved: 0,
            }),
        );
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.stringContaining("Revived track Old/01 Song.flac"),
        );
    });

    it("applies replacement semantics when revived content has a different hash", async () => {
        jest.spyOn(Date, "now").mockReturnValue(
            new Date("2026-03-01T00:00:00.000Z").getTime(),
        );
        const scanner = new MusicScannerService();
        const audioFile = "/music/New/01 Song.flac";
        const oldHash = "sha256:" + "59".repeat(32);
        const newHash = "sha256:" + "5a".repeat(32);
        const removedTrack = identityTrack("track-removed", "Old/01 Song.mp3", {
            audioHash: oldHash,
            recordingMbid: "recording-1",
            removedAt: new Date("2026-02-01T00:00:00.000Z"),
        });
        const candidate = identityTrack("track-new", "New/01 Song.flac", {
            audioHash: newHash,
            recordingMbid: "recording-1",
        });

        jest.spyOn(
            scanner as unknown as {
                findAudioFiles(path: string): Promise<string[]>;
            },
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockComputeAudioStreamHash.mockResolvedValueOnce(newHash);
        mockPrisma.track.upsert.mockResolvedValueOnce(candidate);
        mockPrisma.track.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.track.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([removedTrack])
            .mockResolvedValueOnce([candidate]);
        mockPrisma.transcodedFile.findMany.mockResolvedValueOnce([
            { cachePath: "track-removed-high.mp3" },
        ]);

        const result = await scanner.scanLibrary("/music");

        expect(mockPrisma.track.updateMany).toHaveBeenCalledWith({
            where: { id: "track-removed" },
            data: expect.objectContaining({
                filePath: "New/01 Song.flac",
                audioHash: newHash,
                removedAt: null,
                analysisStatus: "pending",
                vibeAnalysisStatus: "pending",
                vibeAnalysisGeneration: { increment: 1 },
            }),
        });
        expect(mockPrisma.trackEmbedding.deleteMany).toHaveBeenCalledWith({
            where: { trackId: "track-removed" },
        });
        expect(mockPrisma.transcodedFile.deleteMany).toHaveBeenCalledWith({
            where: { trackId: "track-removed" },
        });
        expect(mockUnlink).toHaveBeenCalledWith(
            "/cache/transcodes/track-removed-high.mp3",
        );
        expect(result.tracksUpdated).toBe(1);
    });

    it("soft-removes ambiguous identical moves when lower tiers cannot disambiguate them", async () => {
        const scanner = new MusicScannerService();
        const shared = {
            audioHash: "sha256:" + "66".repeat(32),
            recordingMbid: "recording-shared",
            isrc: "USRC10000001",
            title: "Duplicate",
            fileSize: 4_096,
            duration: 200,
        };
        const missing = [
            identityTrack("track-old-1", "Old/01.flac", shared),
            identityTrack("track-old-2", "Old/02.flac", shared),
        ];
        const candidates = [
            identityTrack("track-new-1", "New/01.flac", shared),
            identityTrack("track-new-2", "New/02.flac", shared),
        ];

        jest.spyOn(
            scanner as unknown as {
                findAudioFiles(path: string): Promise<string[]>;
            },
            "findAudioFiles",
        ).mockResolvedValue(["/music/New/01.flac", "/music/New/02.flac"]);
        mockPrisma.track.findMany
            .mockResolvedValueOnce(missing)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(candidates);
        mockPrisma.track.upsert
            .mockResolvedValueOnce(candidates[0])
            .mockResolvedValueOnce(candidates[1]);
        mockPrisma.track.updateMany.mockResolvedValueOnce({ count: 2 });

        const result = await scanner.scanLibrary("/music");

        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
        expect(mockPrisma.track.updateMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["track-old-1", "track-old-2"] },
                origin: "LOCAL",
                removedAt: null,
            },
            data: { removedAt: expect.any(Date) },
        });
        expect(mockRecomputeAlbumLoudness).toHaveBeenCalledWith(mockPrisma, [
            "album-1",
            "album-1",
        ]);
        expect(mockPrisma.track.deleteMany).not.toHaveBeenCalled();
        expect(result).toEqual(
            expect.objectContaining({
                tracksAdded: 2,
                tracksUpdated: 0,
                tracksRemoved: 2,
            }),
        );
    });

    it("marks missing tracks as unhealthy without deleting library context", async () => {
        const scanner = new MusicScannerService();

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([]);
        mockPrisma.track.findMany.mockResolvedValue([
            {
                id: "track-missing-1",
                filePath: "Missing/Track.mp3",
                fileModified: new Date("2026-01-01T00:00:00.000Z"),
            },
        ]);
        mockPrisma.album.findMany.mockResolvedValue([
            { id: "album-orphan-1", title: "Old Album" },
        ]);
        mockPrisma.artist.findMany.mockResolvedValue([
            { id: "artist-orphan-1", name: "Old Artist" },
        ]);

        const result = await scanner.scanLibrary("/music");

        expect(result).toEqual(
            expect.objectContaining({
                tracksAdded: 0,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
            }),
        );
        expect(mockPrisma.track.deleteMany).not.toHaveBeenCalled();
        expect(mockPrisma.libraryHealthRecord.upsert).toHaveBeenCalledWith({
            where: { trackId: "track-missing-1" },
            update: {
                status: "MISSING_FROM_DISK",
                filePath: "Missing/Track.mp3",
                detail: null,
            },
            create: {
                trackId: "track-missing-1",
                status: "MISSING_FROM_DISK",
                filePath: "Missing/Track.mp3",
                detail: null,
            },
        });
        expect(mockPrisma.album.deleteMany).not.toHaveBeenCalled();
        expect(mockPrisma.artist.deleteMany).not.toHaveBeenCalled();
        expect(mockParseFile).not.toHaveBeenCalled();
    });

    it("soft-removes missing tracks and keeps removed-only albums and artists", async () => {
        const scanner = new MusicScannerService();

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue(["/music/Present/Track.mp3"]);
        mockPrisma.track.findMany.mockResolvedValue([
            identityTrack("track-missing-1", "Missing/Track.mp3"),
            identityTrack("track-present-1", "Present/Track.mp3", {
                fileModified: new Date("2026-02-02T00:00:00.000Z"),
            }),
        ]);
        mockPrisma.track.updateMany.mockResolvedValue({ count: 1 });

        const result = await scanner.scanLibrary("/music");

        expect(mockPrisma.track.updateMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["track-missing-1"] },
                origin: "LOCAL",
                removedAt: null,
            },
            data: { removedAt: expect.any(Date) },
        });
        expect(mockPrisma.track.deleteMany).not.toHaveBeenCalled();
        expect(result.tracksRemoved).toBe(1);
        expect(mockPrisma.libraryHealthRecord.upsert).toHaveBeenCalledWith({
            where: { trackId: "track-missing-1" },
            update: {
                status: "MISSING_FROM_DISK",
                filePath: "Missing/Track.mp3",
                detail: null,
            },
            create: {
                trackId: "track-missing-1",
                status: "MISSING_FROM_DISK",
                filePath: "Missing/Track.mp3",
                detail: null,
            },
        });
        expect(mockPrisma.album.findMany).toHaveBeenCalledWith({
            where: { peerId: null, tracks: { none: {} } },
            orderBy: { id: "asc" },
            take: 10_000,
            select: { id: true },
        });
        expect(mockPrisma.artist.findMany).toHaveBeenCalledWith({
            where: { peerId: null, albums: { none: {} } },
            orderBy: { id: "asc" },
            take: 10_000,
            select: { id: true },
        });
        expect(mockPrisma.album.deleteMany).not.toHaveBeenCalled();
        expect(mockPrisma.artist.deleteMany).not.toHaveBeenCalled();
    });

    it("re-checks orphan relations in guarded catalog deletes", async () => {
        const scanner = new MusicScannerService();
        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([]);
        mockPrisma.album.findMany.mockResolvedValueOnce([{ id: "album-1" }]);
        mockPrisma.artist.findMany.mockResolvedValueOnce([{ id: "artist-1" }]);

        await scanner.scanLibrary("/music");

        expect(mockPrisma.album.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["album-1"] },
                peerId: null,
                tracks: { none: {} },
            },
        });
        expect(mockPrisma.artist.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["artist-1"] },
                peerId: null,
                albums: { none: {} },
            },
        });
    });

    it("does not re-mark tracks that were already soft-removed", async () => {
        const scanner = new MusicScannerService();

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue(["/music/Present/Track.mp3"]);
        mockPrisma.track.findMany.mockResolvedValue([
            identityTrack("track-removed-1", "Missing/Track.mp3", {
                removedAt: new Date("2026-02-01T00:00:00.000Z"),
            }),
            identityTrack("track-present-1", "Present/Track.mp3", {
                fileModified: new Date("2026-02-02T00:00:00.000Z"),
            }),
        ]);

        const result = await scanner.scanLibrary("/music");

        expect(mockPrisma.track.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.track.deleteMany).not.toHaveBeenCalled();
        expect(mockPrisma.libraryHealthRecord.upsert).not.toHaveBeenCalled();
        expect(result.tracksRemoved).toBe(0);
    });

    it("marks health only when no audio files are found", async () => {
        const scanner = new MusicScannerService();

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([]);
        mockPrisma.track.findMany.mockResolvedValue([
            {
                id: "track-missing-1",
                filePath: "Missing/Track.mp3",
                fileModified: new Date("2026-01-01T00:00:00.000Z"),
            },
        ]);

        const result = await scanner.scanLibrary("/music");

        expect(mockPrisma.track.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.track.deleteMany).not.toHaveBeenCalled();
        expect(mockPrisma.libraryHealthRecord.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    trackId: "track-missing-1",
                    status: "MISSING_FROM_DISK",
                }),
            }),
        );
        expect(result.tracksRemoved).toBe(0);
    });

    it("bounds missing-track health writes when no audio files are found", async () => {
        const scanner = new MusicScannerService();
        const tracks = Array.from({ length: 25 }, (_, index) => ({
            id: `track-missing-${index}`,
            filePath: `Missing/Track-${index}.mp3`,
            fileModified: new Date("2026-01-01T00:00:00.000Z"),
        }));
        let inFlight = 0;
        let maxInFlight = 0;

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([]);
        mockPrisma.track.findMany.mockResolvedValue(tracks);
        mockPrisma.libraryHealthRecord.upsert.mockImplementation(async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
                await Promise.resolve();
                return {};
            } finally {
                inFlight--;
            }
        });

        await expect(scanner.scanLibrary("/music")).resolves.toEqual(
            expect.objectContaining({ tracksRemoved: 0 }),
        );

        expect(mockPrisma.libraryHealthRecord.upsert).toHaveBeenCalledTimes(25);
        expect(maxInFlight).toBeLessThanOrEqual(4);
        expect(mockPrisma.libraryHealthRecord.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    trackId: "track-missing-0",
                    filePath: "Missing/Track-0.mp3",
                    status: "MISSING_FROM_DISK",
                }),
            }),
        );
        expect(mockPrisma.libraryHealthRecord.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    trackId: "track-missing-24",
                    filePath: "Missing/Track-24.mp3",
                    status: "MISSING_FROM_DISK",
                }),
            }),
        );
    });

    it("propagates missing-track health write failures on the no-audio guard path", async () => {
        const scanner = new MusicScannerService();
        const upsertError = new Error("health write failed");
        const tracks = Array.from({ length: 8 }, (_, index) => ({
            id: `track-missing-${index}`,
            filePath: `Missing/Track-${index}.mp3`,
            fileModified: new Date("2026-01-01T00:00:00.000Z"),
        }));

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([]);
        mockPrisma.track.findMany.mockResolvedValue(tracks);
        mockPrisma.libraryHealthRecord.upsert.mockRejectedValueOnce(
            upsertError,
        );

        await expect(scanner.scanLibrary("/music")).rejects.toBe(upsertError);
        expect(mockPrisma.libraryHealthRecord.upsert).toHaveBeenCalledTimes(4);
        expect(mockPrisma.track.deleteMany).not.toHaveBeenCalled();
    });

    it("collects file processing errors and continues scan completion", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Broken/Bad.flac";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockParseFile.mockRejectedValueOnce(new Error("metadata read failed"));

        const result = await scanner.scanLibrary("/music");

        expect(result.tracksAdded).toBe(0);
        expect(result.tracksUpdated).toBe(0);
        expect(result.tracksRemoved).toBe(0);
        expect(result.errors).toEqual([
            { file: audioFile, error: "metadata read failed" },
        ]);
        expect(mockPrisma.track.upsert).not.toHaveBeenCalled();
        expect(queueInstances[0].onIdle).toHaveBeenCalledTimes(1);
    });

    it("marks unreadable metadata for existing tracks when parseFile fails", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Broken/Bad.flac";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockPrisma.track.findMany.mockResolvedValue([
            {
                id: "track-existing-1",
                filePath: "Broken/Bad.flac",
                fileModified: new Date("2026-01-01T00:00:00.000Z"),
            },
        ]);
        mockParseFile.mockRejectedValueOnce(new Error("metadata read failed"));

        const result = await scanner.scanLibrary("/music");

        expect(result).toEqual(
            expect.objectContaining({
                tracksAdded: 0,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [{ file: audioFile, error: "metadata read failed" }],
            }),
        );
        expect(mockPrisma.libraryHealthRecord.upsert).toHaveBeenCalledWith({
            where: { trackId: "track-existing-1" },
            update: {
                status: "UNREADABLE_METADATA",
                filePath: "Broken/Bad.flac",
                detail: "metadata read failed",
            },
            create: {
                trackId: "track-existing-1",
                status: "UNREADABLE_METADATA",
                filePath: "Broken/Bad.flac",
                detail: "metadata read failed",
            },
        });
        expect(mockPrisma.track.upsert).not.toHaveBeenCalled();
    });

    it("clears health records for existing tracks after successful processing", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Track.mp3";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockPrisma.track.findMany.mockResolvedValue([
            {
                id: "track-existing-2",
                filePath: "Artist/Track.mp3",
                fileModified: new Date("2026-01-01T00:00:00.000Z"),
            },
        ]);
        mockPrisma.track.upsert.mockResolvedValueOnce({
            id: "track-existing-2",
        });

        const result = await scanner.scanLibrary("/music");

        expect(result).toEqual(
            expect.objectContaining({
                tracksAdded: 0,
                tracksUpdated: 1,
                tracksRemoved: 0,
                errors: [],
            }),
        );
        expect(mockPrisma.libraryHealthRecord.deleteMany).toHaveBeenCalledWith({
            where: { trackId: "track-existing-2" },
        });
    });

    it("continues scan with deterministic progress and mixed file outcomes", async () => {
        const progress: Array<{
            filesScanned: number;
            filesTotal: number;
            currentFile: string;
            errors: Array<{ file: string; error: string }>;
        }> = [];

        const scanner = new MusicScannerService((value) => {
            progress.push({ ...value, errors: [...value.errors] });
        });

        const goodFile = "/music/Good/Track.flac";
        const badFile = "/music/Broken/Bad.flac";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([goodFile, badFile]);

        mockPrisma.track.findMany.mockResolvedValue([]);
        mockParseFile
            .mockResolvedValueOnce({
                common: {
                    title: "Good Track",
                    track: { no: 3 },
                    disk: { no: 1 },
                    albumartist: "Good Artist",
                    album: "Good Album",
                    year: 2024,
                },
                format: {
                    duration: 200.3,
                    codec: "audio/flac",
                },
            } as any)
            .mockRejectedValueOnce(new Error("metadata read failed"));

        const result = await scanner.scanLibrary("/music");

        expect(result).toEqual(
            expect.objectContaining({
                tracksAdded: 1,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [
                    {
                        file: badFile,
                        error: "metadata read failed",
                    },
                ],
            }),
        );
        expect(progress[progress.length - 1]).toEqual(
            expect.objectContaining({
                filesScanned: 2,
                filesTotal: 2,
                currentFile: "Broken/Bad.flac",
                errors: [{ file: badFile, error: "metadata read failed" }],
            }),
        );
        expect(queueInstances[0].add).toHaveBeenCalledTimes(2);
        expect(queueInstances[0].onIdle).toHaveBeenCalledTimes(1);
    });

    it("propagates queue scheduling failures", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Queued/Fail.flac";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);

        queueInstances[0].add = jest
            .fn()
            .mockRejectedValue(new Error("queue unavailable"));

        await expect(scanner.scanLibrary("/music")).rejects.toThrow(
            "queue unavailable",
        );
        expect(mockPrisma.track.upsert).not.toHaveBeenCalled();
    });

    it("does not fail scan when artist count backfill fails asynchronously", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Track.mp3";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockBackfillAllArtistCounts.mockRejectedValueOnce(
            new Error("backfill timeout"),
        );

        const result = await scanner.scanLibrary("/music");

        expect(result.tracksAdded).toBe(1);
        expect(mockLogger.error).toHaveBeenCalledWith(
            "[Scan] Artist counts update failed:",
            expect.any(Error),
        );
        expect(result.errors).toEqual([]);
    });
});

function makeDirent(name: string, kind: "file" | "dir" | "symlink") {
    return {
        name,
        isDirectory: () => kind === "dir" || kind === "symlink",
        isFile: () => kind === "file",
        isSymbolicLink: () => kind === "symlink",
    };
}

describe("MusicScannerService helper methods", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPrisma.downloadJob.findMany.mockResolvedValue([]);
        mockPrisma.discoveryAlbum.findFirst.mockResolvedValue(null);
        mockPrisma.album.findFirst.mockResolvedValue(null);
    });

    it("detects discovery paths and normalizes metadata strings", () => {
        const scanner = new MusicScannerService() as any;

        expect(
            scanner.isDiscoveryPath("Discovery/Artist/Album/track.flac"),
        ).toBe(true);
        expect(
            scanner.isDiscoveryPath("discover\\Artist\\Album\\track.flac"),
        ).toBe(true);
        expect(scanner.isDiscoveryPath("library/Artist/Album/track.flac")).toBe(
            false,
        );

        expect(scanner.normalizeForMatching("  Café   Déjà   Vu  ")).toBe(
            "cafe deja vu",
        );
    });

    it("matches discovery downloads by exact and fallback matching passes", async () => {
        const scanner = new MusicScannerService() as any;

        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-exact",
                metadata: {
                    artistName: "Artist Name",
                    albumTitle: "Album Name",
                },
            },
        ]);

        await expect(
            scanner.isDiscoveryDownload("Artist Name", "Album Name"),
        ).resolves.toBe(true);

        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-partial",
                metadata: {
                    artistName: "Artist Name",
                    albumTitle: "Album Name",
                },
            },
        ]);

        await expect(
            scanner.isDiscoveryDownload("Artist Name", "Album Name (Deluxe)"),
        ).resolves.toBe(true);
    });

    it("returns true for discovery-by-artist matches with no library presence", async () => {
        const scanner = new MusicScannerService() as any;

        mockPrisma.downloadJob.findMany.mockResolvedValue([]);
        mockPrisma.discoveryAlbum.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "discover-artist" });
        mockPrisma.album.findFirst.mockResolvedValueOnce(null);

        await expect(
            scanner.isDiscoveryDownload("Featured Artist", "Some Album"),
        ).resolves.toBe(true);
        expect(mockPrisma.album.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    artist: {
                        name: {
                            equals: "Featured Artist",
                            mode: "insensitive",
                        },
                    },
                    location: "LIBRARY",
                },
            }),
        );
    });

    it("returns false for discovery-by-artist when album exists in library", async () => {
        const scanner = new MusicScannerService() as any;

        mockPrisma.downloadJob.findMany.mockResolvedValue([]);
        mockPrisma.discoveryAlbum.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "discover-artist" });
        mockPrisma.album.findFirst.mockResolvedValueOnce({
            id: "library-existing",
        });

        await expect(
            scanner.isDiscoveryDownload("Library Artist", "Some Album"),
        ).resolves.toBe(false);
        expect(mockPrisma.album.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    artist: {
                        name: { equals: "Library Artist", mode: "insensitive" },
                    },
                    location: "LIBRARY",
                },
            }),
        );
    });

    it("matches discovery downloads via album-only and DiscoveryAlbum fallbacks", async () => {
        const scanner = new MusicScannerService() as any;

        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-album-only",
                metadata: {
                    artistName: "Another Artist",
                    albumTitle: "Shared Album",
                },
            },
        ]);
        await expect(
            scanner.isDiscoveryDownload("Featured Guest", "Shared Album"),
        ).resolves.toBe(true);

        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([]);
        mockPrisma.discoveryAlbum.findFirst.mockResolvedValueOnce({
            id: "discovery-by-title",
        });
        await expect(
            scanner.isDiscoveryDownload("Any Artist", "Unique Album"),
        ).resolves.toBe(true);

        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([]);
        mockPrisma.discoveryAlbum.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "discovery-by-artist" });
        mockPrisma.album.findFirst.mockResolvedValueOnce(null);
        await expect(
            scanner.isDiscoveryDownload("Discovery Artist", "Other Album"),
        ).resolves.toBe(true);

        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([]);
        mockPrisma.discoveryAlbum.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "discovery-by-artist" });
        mockPrisma.album.findFirst.mockResolvedValueOnce({
            id: "library-album",
            location: "LIBRARY",
        });
        await expect(
            scanner.isDiscoveryDownload("Discovery Artist", "Other Album"),
        ).resolves.toBe(false);
    });

    it("returns false when discovery matching throws", async () => {
        const scanner = new MusicScannerService() as any;
        mockPrisma.downloadJob.findMany.mockRejectedValueOnce(
            new Error("db down"),
        );

        await expect(
            scanner.isDiscoveryDownload("Artist Name", "Album Name"),
        ).resolves.toBe(false);
        expect(mockLogger.error).toHaveBeenCalled();
    });

    it("returns false when discovery download cannot be matched", async () => {
        const scanner = new MusicScannerService() as any;
        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([]);
        mockPrisma.discoveryAlbum.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        mockPrisma.album.findFirst.mockResolvedValueOnce(null);

        await expect(
            scanner.isDiscoveryDownload("Non Matching Artist", "Strange Album"),
        ).resolves.toBe(false);
    });

    it("logs primary-artist normalization when extracted artist differs", async () => {
        const scanner = new MusicScannerService() as any;
        mockExtractPrimaryArtist.mockReturnValueOnce("Primary Artist");
        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([]);
        mockPrisma.discoveryAlbum.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        mockPrisma.album.findFirst.mockResolvedValueOnce(null);

        await expect(
            scanner.isDiscoveryDownload(
                "Primary Artist feat. Guest",
                "Normalization Album",
            ),
        ).resolves.toBe(false);
        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.stringContaining("Primary artist:"),
        );
    });

    it("iteratively finds audio files across nested directories", async () => {
        const scanner = new MusicScannerService() as any;
        mockReaddir.mockImplementation(async (dir: string) => {
            if (dir === "/music") {
                return [
                    makeDirent("Artist", "dir"),
                    makeDirent("README.txt", "file"),
                ];
            }
            if (dir === "/music/Artist") {
                return [
                    makeDirent("Track.mp3", "file"),
                    makeDirent("cover.jpg", "file"),
                    makeDirent("Sub", "dir"),
                ];
            }
            if (dir === "/music/Artist/Sub") {
                return [
                    makeDirent("Song.flac", "file"),
                    makeDirent("Demo.wav", "file"),
                    makeDirent("note.md", "file"),
                ];
            }
            return [];
        });

        const files = await scanner.findAudioFiles("/music");
        expect(files.sort()).toEqual(
            [
                "/music/Artist/Track.mp3",
                "/music/Artist/Sub/Song.flac",
                "/music/Artist/Sub/Demo.wav",
            ].sort(),
        );
    });

    it("does not descend into a symlinked directory cycle", async () => {
        const scanner = new MusicScannerService() as any;
        const rootEntries = [
            makeDirent("Real.mp3", "file"),
            makeDirent("ancestor", "symlink"),
        ];
        mockReaddir.mockImplementation(async (dir: string) => {
            if (mockReaddir.mock.calls.length > 2) {
                throw new Error("symlink cycle was followed");
            }
            if (dir === "/music" || dir.endsWith("/ancestor")) {
                return rootEntries;
            }
            return [];
        });

        await expect(scanner.findAudioFiles("/music")).resolves.toEqual([
            "/music/Real.mp3",
        ]);
        expect(mockReaddir).not.toHaveBeenCalledWith(
            "/music/ancestor",
            expect.any(Object),
        );
    });

    it("does not descend beyond the maximum scan depth and logs a warning", async () => {
        const scanner = new MusicScannerService() as any;
        const tooDeepPath = [
            "/music",
            ...Array.from({ length: 65 }, (_, index) => `d${index + 1}`),
        ].join("/");
        mockReaddir.mockImplementation(async (dir: string) => {
            const depth =
                dir === "/music"
                    ? 0
                    : Number(dir.slice(dir.lastIndexOf("/d") + 2));
            if (depth > 64) {
                throw new Error("depth limit was exceeded");
            }
            return [
                makeDirent(`d${depth + 1}`, "dir"),
                makeDirent(`Track-${depth}.flac`, "file"),
            ];
        });

        const files = await scanner.findAudioFiles("/music");

        expect(files).toContain("/music/Track-0.flac");
        expect(mockReaddir).not.toHaveBeenCalledWith(
            tooDeepPath,
            expect.any(Object),
        );
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining(tooDeepPath),
        );
    });

    it("skips hidden directories while recursively scanning audio files", async () => {
        const scanner = new MusicScannerService() as any;
        mockReaddir.mockImplementation(async (dir: string) => {
            if (dir === "/music") {
                return [
                    makeDirent(".hidden", "dir"),
                    makeDirent("Artist", "dir"),
                ];
            }
            if (dir === "/music/Artist") {
                return [makeDirent("Visible.mp3", "file")];
            }
            if (dir === "/music/.hidden") {
                return [makeDirent("Secret.flac", "file")];
            }
            return [];
        });

        const files = await scanner.findAudioFiles("/music");
        expect(files).toEqual(["/music/Artist/Visible.mp3"]);
        expect(mockReaddir).not.toHaveBeenCalledWith(
            "/music/.hidden",
            expect.any(Object),
        );
    });
});

describe("MusicScannerService.processAudioFile artist fallbacks", () => {
    beforeEach(() => {
        jest.clearAllMocks();

        mockStat.mockResolvedValue({
            mtime: new Date("2026-02-01T00:00:00.000Z"),
            size: 4096,
        });
        mockParseFile.mockResolvedValue({
            common: {
                title: "Track Title",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "",
                artist: "",
                album: "Album Name",
                year: 2024,
            },
            format: {
                duration: 222.3,
                codec: "audio/flac",
            },
        } as any);

        mockPrisma.artist.findFirst.mockResolvedValue(null);
        mockPrisma.artist.findMany.mockResolvedValue([]);
        mockPrisma.artist.findUnique.mockResolvedValue(null);
        mockPrisma.artist.create.mockResolvedValue({
            id: "artist-new",
            name: "Artist",
            normalizedName: "artist",
            mbid: "temp-artist",
        });
        mockPrisma.album.findFirst.mockResolvedValue(null);
        mockPrisma.album.findUnique.mockResolvedValue(null);
        mockPrisma.album.findMany.mockResolvedValue([]);
        mockPrisma.album.create.mockResolvedValue({
            id: "album-new",
            title: "Album Name",
            coverUrl: null,
            location: "LIBRARY",
            rgMbid: "temp-rg",
        });
        mockParseArtistFromPath.mockImplementation((name: string) => name);
        mockPrisma.track.upsert.mockResolvedValue({});
        mockPrisma.downloadJob.findMany.mockResolvedValue([]);
        mockPrisma.discoveryAlbum.findFirst.mockResolvedValue(null);
        mockPrisma.ownedAlbum.create.mockResolvedValue({});
        mockPrisma.ownedAlbum.upsert.mockResolvedValue({});
    });

    it("uses grandparent folder as artist when metadata artist is missing", async () => {
        const scanner = new MusicScannerService() as any;

        mockParseArtistFromPath.mockImplementation((name: string) => {
            if (name === "Robbin' The Hood") return "";
            if (name === "Sublime") return "Sublime";
            return "";
        });
        mockNormalizeArtistName.mockImplementation((name: string) =>
            name.trim().toLowerCase(),
        );
        mockPrisma.artist.create.mockResolvedValueOnce({
            id: "artist-sublime",
            name: "Sublime",
            normalizedName: "sublime",
            mbid: "temp-sublime",
        });

        await scanner.processAudioFile(
            "/music/Sublime/Robbin' The Hood/01 Track.flac",
            "Sublime/Robbin' The Hood/01 Track.flac",
            "/music",
        );

        expect(mockParseArtistFromPath).toHaveBeenCalledWith(
            "Robbin' The Hood",
        );
        expect(mockParseArtistFromPath).toHaveBeenCalledWith("Sublime");
        expect(mockPrisma.artist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    name: "Sublime",
                }),
            }),
        );
    });

    it("uses grandparent folder name directly when parser does not recognize it", async () => {
        const scanner = new MusicScannerService() as any;

        mockParseArtistFromPath.mockReturnValue("");
        mockNormalizeArtistName.mockImplementation((name: string) =>
            name.trim().toLowerCase(),
        );
        mockPrisma.artist.create.mockResolvedValueOnce({
            id: "artist-direct-grandparent",
            name: "Grandparent Artist",
            normalizedName: "grandparent artist",
            mbid: "temp-grandparent",
        });

        await scanner.processAudioFile(
            "/music/Grandparent Artist/Unparseable Album/01 Track.flac",
            "Grandparent Artist/Unparseable Album/01 Track.flac",
            "/music",
        );

        expect(mockPrisma.artist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    name: "Grandparent Artist",
                }),
            }),
        );
    });

    it("falls back to Unknown Artist when metadata and folder parsing fail", async () => {
        const scanner = new MusicScannerService() as any;

        mockParseArtistFromPath.mockReturnValue("");
        mockPrisma.artist.create.mockResolvedValueOnce({
            id: "artist-unknown",
            name: "Unknown Artist",
            normalizedName: "unknown artist",
            mbid: "temp-unknown",
        });

        await scanner.processAudioFile(
            "/music/2024/Album Name/01 Track.flac",
            "2024/Album Name/01 Track.flac",
            "/music",
        );

        expect(mockPrisma.artist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    name: "Unknown Artist",
                }),
            }),
        );
        expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("creates DISCOVER album when source file path indicates discovery", async () => {
        const scanner = new MusicScannerService() as any;

        mockPrisma.artist.findFirst.mockResolvedValueOnce({
            id: "artist-discovery",
            name: "Discovery Artist",
            normalizedName: "discovery artist",
        });

        await scanner.processAudioFile(
            "/music/discovery/Discovery Artist/Discovery Album/01 Track.flac",
            "discovery/Discovery Artist/Discovery Album/01 Track.flac",
            "/music",
        );

        expect(mockPrisma.album.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    location: "DISCOVER",
                    title: "Album Name",
                }),
            }),
        );
        expect(mockPrisma.ownedAlbum.upsert).not.toHaveBeenCalled();
    });

    it("falls back to Deezer cover when extractor returns no local art", async () => {
        const scanner = new MusicScannerService(
            undefined,
            "/tmp/covers",
        ) as any;
        mockExtractCoverArt.mockResolvedValueOnce(null);
        mockGetAlbumCover.mockResolvedValueOnce(
            "https://example.com/cover.jpg",
        );

        await scanner.processAudioFile(
            "/music/DiscFallback/Track.flac",
            "DiscFallback/Track.flac",
            "/music",
        );

        expect(mockExtractCoverArt).toHaveBeenCalledWith(
            "/music/DiscFallback/Track.flac",
            "album-new",
        );
        expect(mockGetAlbumCover).toHaveBeenCalledWith(
            "DiscFallback",
            "Album Name",
        );
        expect(mockPrisma.album.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "album-new" },
                data: { coverUrl: "https://example.com/cover.jpg" },
            }),
        );
    });

    it("updates an existing temp artist MBID when real MBID is discovered", async () => {
        const scanner = new MusicScannerService(
            undefined,
            "/tmp/covers",
        ) as any;

        mockPrisma.artist.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "temp-artist",
                name: "Temp Artist",
                normalizedName: "temp artist",
                mbid: "temp-old",
            });
        mockPrisma.artist.findUnique.mockResolvedValueOnce(null);
        mockPrisma.artist.update.mockResolvedValueOnce({
            id: "artist-1",
            name: "Real Artist",
            normalizedName: "real artist",
            mbid: "mbid-real",
        });

        mockParseFile.mockResolvedValue({
            common: {
                title: "Track Title",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "Real Artist",
                artist: "Real Artist",
                album: "Album Name",
                year: 2024,
                musicbrainz_artistid: ["mbid-real"],
            },
            format: {
                duration: 222.3,
                codec: "audio/flac",
            },
        } as any);

        await scanner.processAudioFile(
            "/music/RealArtist/Track.flac",
            "RealArtist/Track.flac",
            "/music",
        );

        expect(mockPrisma.artist.findFirst).toHaveBeenCalledWith({
            where: { normalizedName: "real artist" },
        });
        expect(mockPrisma.artist.findUnique).toHaveBeenCalledWith({
            where: { mbid: "mbid-real" },
        });
        expect(mockPrisma.artist.update).toHaveBeenCalledWith({
            where: { id: "temp-artist" },
            data: { mbid: "mbid-real" },
        });
        expect(mockPrisma.artist.create).not.toHaveBeenCalled();
    });

    it("retries artist creation on unique-constraint conflicts and uses existing MBID", async () => {
        const scanner = new MusicScannerService(
            undefined,
            "/tmp/covers",
        ) as any;
        const conflict = new Error("duplicate");
        (conflict as Error & { code: string }).code = "P2002";

        mockPrisma.artist.findFirst.mockResolvedValueOnce(null);
        mockPrisma.artist.findMany.mockResolvedValueOnce([]);
        mockPrisma.artist.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "artist-existing",
                name: "Existing Artist",
                normalizedName: "existing artist",
                mbid: "mbid-existing",
            });
        mockPrisma.artist.create.mockRejectedValueOnce(conflict);

        mockParseFile.mockResolvedValue({
            common: {
                title: "Track Title",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "Existing Artist",
                artist: "Existing Artist",
                album: "Album Name",
                year: 2024,
                musicbrainz_artistid: ["mbid-existing"],
            },
            format: {
                duration: 222.3,
                codec: "audio/flac",
            },
        } as any);

        await scanner.processAudioFile(
            "/music/Existing/Track.flac",
            "Existing/Track.flac",
            "/music",
        );

        expect(mockPrisma.artist.create).toHaveBeenCalledTimes(1);
        expect(mockPrisma.artist.findUnique).toHaveBeenCalledWith({
            where: { mbid: "mbid-existing" },
        });
        expect(mockPrisma.artist.findUnique).toHaveBeenCalledWith({
            where: { mbid: "mbid-existing" },
        });
        expect(mockPrisma.track.upsert).toHaveBeenCalledTimes(1);
    });

    it("creates deterministic temporary IDs when Date and RNG are controlled", async () => {
        const scanner = new MusicScannerService(
            undefined,
            "/tmp/covers",
        ) as any;
        const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1700000000000);
        const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.12345);

        mockPrisma.artist.findFirst.mockResolvedValueOnce(null);
        mockPrisma.artist.findMany.mockResolvedValue([]);
        mockPrisma.artist.findUnique.mockResolvedValue(null);
        mockPrisma.artist.create.mockResolvedValue({
            id: "artist-temp",
            name: "Temp Artist",
            normalizedName: "temp artist",
            mbid: "temp-1700000000000-0.12345",
        });
        mockPrisma.album.findFirst.mockResolvedValue(null);
        mockPrisma.album.create.mockResolvedValue({
            id: "album-temp",
            coverUrl: null,
            title: "Album Name",
            location: "LIBRARY",
            rgMbid: "temp-1700000000000-0.12345",
        });
        mockParseArtistFromPath.mockReturnValue("Temp Artist");
        mockParseFile.mockResolvedValue({
            common: {
                title: "Track Title",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "",
                artist: "",
                album: "Album Name",
                year: 2024,
            },
            format: {
                duration: 222.3,
                codec: "audio/flac",
            },
        } as any);

        await scanner.processAudioFile(
            "/music/Temp Artist/Track.flac",
            "Temp Artist/Track.flac",
            "/music",
        );

        expect(mockPrisma.artist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    mbid: "temp-1700000000000-0.12345",
                }),
            }),
        );
        expect(mockPrisma.album.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    rgMbid: "temp-1700000000000-0.12345",
                }),
            }),
        );

        nowSpy.mockRestore();
        randomSpy.mockRestore();
    });

    it("falls back to raw artist name when extracted primary artist differs", async () => {
        const scanner = new MusicScannerService() as any;
        const rawArtistName = "Of Mice & Men";
        const extractedPrimaryArtist = "Of Mice";

        mockParseFile.mockResolvedValue({
            common: {
                title: "Track Title",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: rawArtistName,
                artist: rawArtistName,
                album: "Album Name",
                year: 2024,
            },
            format: {
                duration: 222.3,
                codec: "audio/flac",
            },
        } as any);
        mockExtractPrimaryArtist.mockReturnValueOnce(extractedPrimaryArtist);
        mockPrisma.artist.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "artist-raw",
                name: rawArtistName,
                normalizedName: "of mice & men",
                mbid: "mbid-raw",
            });

        await scanner.processAudioFile(
            "/music/Of Mice & Men/Track.flac",
            "Of Mice & Men/Track.flac",
            "/music",
        );

        expect(mockPrisma.artist.findFirst).toHaveBeenNthCalledWith(1, {
            where: { normalizedName: "of mice" },
        });
        expect(mockPrisma.artist.findFirst).toHaveBeenNthCalledWith(2, {
            where: { normalizedName: "of mice & men" },
        });
        expect(mockPrisma.artist.findFirst).toHaveBeenCalledTimes(2);
        expect(mockPrisma.artist.create).not.toHaveBeenCalled();
    });

    it("updates artist capitalization when existing name is lowercase", async () => {
        const scanner = new MusicScannerService() as any;

        mockParseFile.mockResolvedValue({
            common: {
                title: "Track Title",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "Artist Name",
                artist: "Artist Name",
                album: "Album Name",
                year: 2024,
            },
            format: {
                duration: 222.3,
                codec: "audio/flac",
            },
        } as any);
        mockPrisma.artist.findFirst.mockResolvedValueOnce({
            id: "artist-lowercase",
            name: "artist name",
            normalizedName: "artist name",
            mbid: "mbid-lowercase",
        });
        mockPrisma.artist.update.mockResolvedValueOnce({
            id: "artist-lowercase",
            name: "Artist Name",
            normalizedName: "artist name",
            mbid: "mbid-lowercase",
        });

        await scanner.processAudioFile(
            "/music/Artist Name/Track.flac",
            "Artist Name/Track.flac",
            "/music",
        );

        expect(mockPrisma.artist.findFirst).toHaveBeenCalledWith({
            where: { normalizedName: "artist name" },
        });
        expect(mockPrisma.artist.update).toHaveBeenCalledWith({
            where: { id: "artist-lowercase" },
            data: { name: "Artist Name" },
        });
    });

    it("applies fuzzy artist matching before creating a new artist", async () => {
        const scanner = new MusicScannerService() as any;

        mockParseFile.mockResolvedValue({
            common: {
                title: "Track Title",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "The Weeknd",
                artist: "The Weeknd",
                album: "Album Name",
                year: 2024,
            },
            format: {
                duration: 222.3,
                codec: "audio/flac",
            },
        } as any);
        mockPrisma.artist.findFirst.mockResolvedValueOnce(null);
        mockPrisma.artist.findMany.mockResolvedValueOnce([
            {
                id: "artist-fuzzy",
                name: "The Weeknd",
                normalizedName: "the weeknd",
                mbid: "mbid-weeknd",
            },
        ]);
        mockAreArtistNamesSimilar.mockReturnValueOnce(true);

        await scanner.processAudioFile(
            "/music/The Weeknd/Track.flac",
            "The Weeknd/Track.flac",
            "/music",
        );

        expect(mockPrisma.artist.findMany).toHaveBeenCalledTimes(1);
        expect(mockPrisma.artist.create).not.toHaveBeenCalled();
        expect(mockAreArtistNamesSimilar).toHaveBeenCalledWith(
            "The Weeknd",
            "The Weeknd",
            95,
        );
    });

    it("keeps temp artist when MBID consolidation collides and fallback lookup returns null", async () => {
        const scanner = new MusicScannerService() as any;
        const collision = new Error("duplicate");
        (collision as Error & { code: string }).code = "P2002";

        mockParseFile.mockResolvedValue({
            common: {
                title: "Track Title",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "Artist Temp",
                artist: "Artist Temp",
                album: "Album Name",
                year: 2024,
                musicbrainz_artistid: ["mbid-collision"],
            },
            format: {
                duration: 222.3,
                codec: "audio/flac",
            },
        } as any);
        mockPrisma.artist.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "temp-artist",
                name: "Temp Artist",
                normalizedName: "temp artist",
                mbid: "temp-old",
            });
        mockPrisma.artist.findMany.mockResolvedValueOnce([]);
        mockPrisma.artist.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        mockPrisma.artist.update.mockRejectedValueOnce(collision);

        await scanner.processAudioFile(
            "/music/ArtistTemp/Track.flac",
            "ArtistTemp/Track.flac",
            "/music",
        );

        expect(mockPrisma.artist.update).toHaveBeenCalledWith({
            where: { id: "temp-artist" },
            data: { mbid: "mbid-collision" },
        });
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                "MBID collision detected for mbid-collision, but canonical artist lookup returned null; keeping temp artist linkage",
            ),
        );
        expect(mockPrisma.artist.create).not.toHaveBeenCalled();
    });

    it("rethrows MBID consolidation update failures that are not unique conflicts", async () => {
        const scanner = new MusicScannerService() as any;
        const updateFailure = new Error("update failed");
        (updateFailure as Error & { code: string }).code = "P5000";

        mockParseFile.mockResolvedValue({
            common: {
                title: "Track Title",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "Artist Temp",
                artist: "Artist Temp",
                album: "Album Name",
                year: 2024,
                musicbrainz_artistid: ["mbid-non-unique-failure"],
            },
            format: {
                duration: 222.3,
                codec: "audio/flac",
            },
        } as any);
        mockPrisma.artist.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "temp-artist",
                name: "Temp Artist",
                normalizedName: "artist temp",
                mbid: "temp-old",
            });
        mockPrisma.artist.findMany.mockResolvedValueOnce([]);
        mockPrisma.artist.findUnique.mockResolvedValueOnce(null);
        mockPrisma.artist.update.mockRejectedValueOnce(updateFailure);

        await expect(
            scanner.processAudioFile(
                "/music/ArtistTemp/Track.flac",
                "ArtistTemp/Track.flac",
                "/music",
            ),
        ).rejects.toThrow("update failed");
        expect(mockPrisma.track.upsert).not.toHaveBeenCalled();
    });

    it("rethrows artist create failures when no canonical MBID row exists", async () => {
        const scanner = new MusicScannerService() as any;
        const conflict = new Error("conflict");
        (conflict as Error & { code: string }).code = "P2002";

        mockParseFile.mockResolvedValue({
            common: {
                title: "Track Title",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "Unknown Conflict Artist",
                artist: "Unknown Conflict Artist",
                album: "Album Name",
                year: 2024,
                musicbrainz_artistid: ["mbid-conflict"],
            },
            format: {
                duration: 222.3,
                codec: "audio/flac",
            },
        } as any);
        mockPrisma.artist.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        mockPrisma.artist.findMany.mockResolvedValueOnce([]);
        mockPrisma.artist.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        mockPrisma.artist.create.mockRejectedValueOnce(conflict);

        await expect(
            scanner.processAudioFile(
                "/music/Conflict/Track.flac",
                "Conflict/Track.flac",
                "/music",
            ),
        ).rejects.toThrow("conflict");

        expect(mockPrisma.artist.create).toHaveBeenCalledTimes(1);
        expect(mockPrisma.track.upsert).not.toHaveBeenCalled();
    });

    it("rethrows artist create failures when unique conflict occurs without an MBID", async () => {
        const scanner = new MusicScannerService() as any;
        const conflict = new Error("mbidless conflict");
        (conflict as Error & { code: string }).code = "P2002";

        mockParseFile.mockResolvedValue({
            common: {
                title: "Track Title",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "No MBID Artist",
                artist: "No MBID Artist",
                album: "Album Name",
                year: 2024,
            },
            format: {
                duration: 222.3,
                codec: "audio/flac",
            },
        } as any);
        mockPrisma.artist.findFirst.mockResolvedValueOnce(null);
        mockPrisma.artist.findMany.mockResolvedValueOnce([]);
        mockPrisma.artist.create.mockRejectedValueOnce(conflict);

        await expect(
            scanner.processAudioFile(
                "/music/NoMBID/Track.flac",
                "NoMBID/Track.flac",
                "/music",
            ),
        ).rejects.toThrow("mbidless conflict");
        expect(mockPrisma.track.upsert).not.toHaveBeenCalled();
    });

    it("reuses existing album by MusicBrainz release group id", async () => {
        const scanner = new MusicScannerService() as any;

        mockParseFile.mockResolvedValue({
            common: {
                title: "Track Title",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "Album Band",
                artist: "Album Band",
                album: "Album Name",
                year: 2024,
                musicbrainz_releasegroupid: "rg-123",
            },
            format: {
                duration: 222.3,
                codec: "audio/flac",
            },
        } as any);
        mockPrisma.artist.findFirst.mockResolvedValueOnce({
            id: "artist-release",
            name: "Album Band",
            normalizedName: "album band",
            mbid: null,
        });
        // The album is resolved directly by its release-group MBID.
        mockPrisma.album.findFirst.mockResolvedValueOnce({
            id: "album-release",
            title: "Album Name",
            coverUrl: null,
            location: "LIBRARY",
            rgMbid: "rg-123",
        });

        await scanner.processAudioFile(
            "/music/Album Band/Track.flac",
            "Album Band/Track.flac",
            "/music",
        );

        expect(mockPrisma.album.findFirst).toHaveBeenCalledWith({
            where: { artistId: "artist-release", rgMbid: "rg-123" },
        });
        expect(mockPrisma.album.create).not.toHaveBeenCalled();
    });

    it("promotes existing remote albums for remote-only artists into the owned library when local files are scanned", async () => {
        const scanner = new MusicScannerService() as any;

        mockParseFile.mockResolvedValue({
            common: {
                title: "Track Title",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "John Williams",
                artist: "John Williams",
                album: "Hook (Original Motion Picture Soundtrack)",
                year: 1991,
            },
            format: {
                duration: 222.3,
                codec: "audio/flac",
            },
        } as any);
        mockPrisma.artist.findFirst.mockResolvedValueOnce({
            id: "artist-hook",
            name: "John Williams",
            normalizedName: "john williams",
            mbid: "artist-mbid-hook",
        });
        mockPrisma.album.findMany.mockResolvedValueOnce([
            { location: "REMOTE" },
        ] as any[]);
        mockPrisma.album.findFirst.mockResolvedValueOnce({
            id: "album-hook",
            title: "Hook (Original Motion Picture Soundtrack)",
            coverUrl: null,
            location: "REMOTE",
            rgMbid: "remote:hook",
        });
        mockPrisma.album.update.mockResolvedValueOnce({
            id: "album-hook",
            title: "Hook (Original Motion Picture Soundtrack)",
            coverUrl: null,
            location: "LIBRARY",
            rgMbid: "remote:hook",
        });

        await scanner.processAudioFile(
            "/music/John Williams/Hook (Original Motion Picture Soundtrack)/01 Track Title.flac",
            "John Williams/Hook (Original Motion Picture Soundtrack)/01 Track Title.flac",
            "/music",
        );

        expect(mockPrisma.album.update).toHaveBeenCalledWith({
            where: { id: "album-hook" },
            data: { location: "LIBRARY" },
        });
        expect(mockPrisma.ownedAlbum.upsert).toHaveBeenCalledWith({
            where: {
                artistId_rgMbid: {
                    artistId: "artist-hook",
                    rgMbid: "remote:hook",
                },
            },
            update: {
                source: "native_scan",
            },
            create: {
                rgMbid: "remote:hook",
                artistId: "artist-hook",
                source: "native_scan",
            },
        });
        expect(mockPrisma.album.create).not.toHaveBeenCalled();
    });

    it("marks artist as discovery when they have only discovery albums", async () => {
        const scanner = new MusicScannerService() as any;

        mockParseFile.mockResolvedValue({
            common: {
                title: "Track Title",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "Discovery Artist",
                artist: "Discovery Artist",
                album: "Discovery Album",
                year: 2024,
            },
            format: {
                duration: 222.3,
                codec: "audio/flac",
            },
        } as any);
        mockPrisma.artist.findFirst.mockResolvedValueOnce({
            id: "artist-discovery",
            name: "Discovery Artist",
            normalizedName: "discovery artist",
            mbid: null,
        });
        mockPrisma.album.findFirst.mockResolvedValueOnce(null);
        mockPrisma.album.findMany.mockResolvedValueOnce([
            { location: "DISCOVER" },
        ] as any[]);

        await scanner.processAudioFile(
            "/music/Discovery Artist/Track.flac",
            "Discovery Artist/Track.flac",
            "/music",
        );

        expect(mockPrisma.album.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    location: "DISCOVER",
                }),
            }),
        );
        expect(mockPrisma.ownedAlbum.upsert).not.toHaveBeenCalled();
        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.stringContaining(
                "Discovery-only artist detected: Discovery Artist",
            ),
        );
    });

    it("retries native cover extraction when cached extractor image is missing", async () => {
        const scanner = new MusicScannerService(
            undefined,
            "/tmp/covers",
        ) as any;

        mockParseFile.mockResolvedValue({
            common: {
                title: "Track Title",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "Cover Artist",
                artist: "Cover Artist",
                album: "Album Name",
                year: 2024,
            },
            format: {
                duration: 222.3,
                codec: "audio/flac",
            },
        } as any);
        mockPrisma.artist.findFirst.mockResolvedValueOnce({
            id: "artist-cover",
            name: "Cover Artist",
            normalizedName: "cover artist",
            mbid: null,
        });
        mockPrisma.album.findFirst.mockResolvedValueOnce(null);
        mockPrisma.album.create.mockResolvedValueOnce({
            id: "album-cover",
            title: "Album Name",
            coverUrl: "native:cover-path.jpg",
            location: "LIBRARY",
            rgMbid: "temp-cover",
        });
        mockExtractCoverArt.mockResolvedValueOnce("native-cover-path.jpg");
        mockExistsSync.mockImplementation(
            (value) => !String(value).includes("/tmp/covers/cover-path.jpg"),
        );

        await scanner.processAudioFile(
            "/music/Cover Artist/Track.flac",
            "Cover Artist/Track.flac",
            "/music",
        );

        expect(mockExtractCoverArt).toHaveBeenCalledWith(
            "/music/Cover Artist/Track.flac",
            "album-cover",
        );
        expect(mockPrisma.album.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "album-cover" },
                data: { coverUrl: "native:native-cover-path.jpg" },
            }),
        );
    });
});

describe("MusicScannerService.processAudioFile album resolution (PR #5 regressions)", () => {
    beforeEach(() => {
        jest.clearAllMocks();

        mockStat.mockResolvedValue({
            mtime: new Date("2026-02-01T00:00:00.000Z"),
            size: 4096,
        });

        mockPrisma.artist.findFirst.mockResolvedValue({
            id: "artist-b",
            name: "Artist B",
            normalizedName: "artist b",
            mbid: "mbid-artist-b",
        });
        mockPrisma.artist.findMany.mockResolvedValue([]);
        mockPrisma.artist.findUnique.mockResolvedValue(null);

        mockPrisma.album.findFirst.mockResolvedValue(null);
        mockPrisma.album.findUnique.mockResolvedValue(null);
        mockPrisma.album.findMany.mockResolvedValue([]);
        mockPrisma.album.create.mockResolvedValue({
            id: "album-created",
            title: "Shared Album",
            coverUrl: null,
            location: "LIBRARY",
            rgMbid: "rg-created",
        });
        mockPrisma.album.update.mockResolvedValue({});

        mockPrisma.track.upsert.mockResolvedValue({ id: "track-1" });
        mockPrisma.downloadJob.findMany.mockResolvedValue([]);
        mockPrisma.discoveryAlbum.findFirst.mockResolvedValue(null);
        mockPrisma.ownedAlbum.upsert.mockResolvedValue({});
        mockPrisma.libraryHealthRecord.deleteMany.mockResolvedValue({
            count: 0,
        });
    });

    function mockTaggedFile(rgMbid: string, album = "Shared Album") {
        mockParseFile.mockResolvedValue({
            common: {
                title: "Track Title",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "Artist B",
                artist: "Artist B",
                album,
                year: 2020,
                musicbrainz_releasegroupid: rgMbid,
            },
            format: {
                duration: 200,
                codec: "audio/flac",
            },
        } as any);
    }

    it("reuses an album whose release group already exists under a different artist", async () => {
        const scanner = new MusicScannerService() as any;
        mockTaggedFile("rg-shared");

        // Artist-scoped lookup misses (the album row belongs to artist-a),
        // but rgMbid is globally unique so the global lookup finds it.
        mockPrisma.album.findFirst.mockResolvedValueOnce(null);
        mockPrisma.album.findUnique.mockResolvedValueOnce({
            id: "album-other-artist",
            title: "Shared Album",
            coverUrl: null,
            location: "LIBRARY",
            rgMbid: "rg-shared",
            artistId: "artist-a",
        });

        await scanner.processAudioFile(
            "/music/Artist B/Shared Album/01 Track.flac",
            "Artist B/Shared Album/01 Track.flac",
            "/music",
        );

        expect(mockPrisma.album.findFirst).toHaveBeenCalledWith({
            where: { artistId: "artist-b", rgMbid: "rg-shared" },
        });
        expect(mockPrisma.album.findUnique).toHaveBeenCalledWith({
            where: { rgMbid: "rg-shared" },
        });
        // The existing album is reused — no create, so no P2002 crash that
        // would mark the file UNREADABLE_METADATA on every rescan.
        expect(mockPrisma.album.create).not.toHaveBeenCalled();
        expect(mockPrisma.track.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    albumId: "album-other-artist",
                }),
                update: expect.objectContaining({
                    albumId: "album-other-artist",
                }),
            }),
        );
    });

    it("recovers from album.create P2002 by re-looking up the album globally", async () => {
        const scanner = new MusicScannerService() as any;
        mockTaggedFile("rg-race");
        const conflict = new Error("unique violation on rgMbid");
        (conflict as Error & { code: string }).code = "P2002";

        mockPrisma.album.findFirst.mockResolvedValueOnce(null);
        mockPrisma.album.findUnique
            // Global fallback lookup before create: still nothing (a
            // concurrent scanner worker has not committed yet).
            .mockResolvedValueOnce(null)
            // Recovery re-lookup after the P2002: the racing worker's row.
            .mockResolvedValueOnce({
                id: "album-raced",
                title: "Shared Album",
                coverUrl: null,
                location: "LIBRARY",
                rgMbid: "rg-race",
            });
        mockPrisma.album.create.mockRejectedValueOnce(conflict);

        await scanner.processAudioFile(
            "/music/Artist B/Shared Album/01 Track.flac",
            "Artist B/Shared Album/01 Track.flac",
            "/music",
        );

        expect(mockPrisma.album.create).toHaveBeenCalledTimes(1);
        expect(mockPrisma.album.findUnique).toHaveBeenLastCalledWith({
            where: { rgMbid: "rg-race" },
        });
        // File is processed normally against the recovered album.
        expect(mockPrisma.track.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ albumId: "album-raced" }),
                update: expect.objectContaining({ albumId: "album-raced" }),
            }),
        );
    });

    it("rethrows album.create P2002 when the recovery lookup finds nothing", async () => {
        const scanner = new MusicScannerService() as any;
        mockTaggedFile("rg-ghost");
        const conflict = new Error("unique violation on rgMbid");
        (conflict as Error & { code: string }).code = "P2002";

        mockPrisma.album.findFirst.mockResolvedValueOnce(null);
        mockPrisma.album.findUnique.mockResolvedValue(null);
        mockPrisma.album.create.mockRejectedValueOnce(conflict);

        await expect(
            scanner.processAudioFile(
                "/music/Artist B/Shared Album/01 Track.flac",
                "Artist B/Shared Album/01 Track.flac",
                "/music",
            ),
        ).rejects.toThrow("unique violation on rgMbid");
        expect(mockPrisma.track.upsert).not.toHaveBeenCalled();
    });

    it("matches un-tagged files to a same-titled sibling album with a real rgMbid", async () => {
        const scanner = new MusicScannerService() as any;
        // Un-tagged file (no musicbrainz_releasegroupid) in a folder whose
        // tagged siblings already created a real-rgMbid album.
        mockParseFile.mockResolvedValue({
            common: {
                title: "Untagged Track",
                track: { no: 2 },
                disk: { no: 1 },
                albumartist: "Artist B",
                artist: "Artist B",
                album: "Mixed Album",
                year: 2020,
            },
            format: {
                duration: 180,
                codec: "audio/flac",
            },
        } as any);
        mockPrisma.album.findFirst.mockResolvedValueOnce({
            id: "album-real",
            title: "Mixed Album",
            coverUrl: null,
            location: "LIBRARY",
            rgMbid: "rg-real",
        });

        await scanner.processAudioFile(
            "/music/Artist B/Mixed Album/02 Untagged Track.flac",
            "Artist B/Mixed Album/02 Untagged Track.flac",
            "/music",
        );

        // Exact-title match within the artist across ALL albums — not just
        // temp- ones — so no duplicate same-titled album is created.
        expect(mockPrisma.album.findFirst).toHaveBeenCalledWith({
            where: { artistId: "artist-b", title: "Mixed Album" },
        });
        expect(mockPrisma.album.create).not.toHaveBeenCalled();
        expect(mockPrisma.track.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ albumId: "album-real" }),
                update: expect.objectContaining({ albumId: "album-real" }),
            }),
        );
    });
});
