const mockReaddir = jest.fn();
const mockStat = jest.fn();
const mockExistsSync = jest.fn();
const mockParseFile = jest.fn();
const queueInstances: Array<{ add: jest.Mock; onIdle: jest.Mock }> = [];

const mockPrisma = {
    track: {
        findMany: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
    },
    album: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
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
    },
};

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

const mockBackfillAllArtistCounts = jest.fn();
const mockGetAlbumCover = jest.fn();
const mockNormalizeArtistName = jest.fn((name: string) =>
    name.trim().toLowerCase()
);
const mockAreArtistNamesSimilar = jest.fn(() => false);
const mockCanonicalizeVariousArtists = jest.fn((name: string) => name);
const mockExtractPrimaryArtist = jest.fn((name: string) => name);
const mockParseArtistFromPath = jest.fn((name: string) => name);
const mockExtractCoverArt = jest.fn();

jest.mock("fs", () => ({
    promises: {
        readdir: mockReaddir,
        stat: mockStat,
    },
    existsSync: mockExistsSync,
}));

jest.mock("music-metadata", () => ({
    parseFile: mockParseFile,
}), { virtual: true });

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

const { MusicScannerService } = require("../musicScanner") as typeof import("../musicScanner");

describe("MusicScannerService.scanLibrary", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        queueInstances.length = 0;

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
        mockPrisma.track.upsert.mockResolvedValue({});
        mockPrisma.track.deleteMany.mockResolvedValue({ count: 0 });

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
        });
        mockPrisma.album.findMany.mockResolvedValue([]);
        mockPrisma.album.findUnique.mockResolvedValue(null);
        mockPrisma.album.create.mockResolvedValue({
            id: "album-1",
            title: "Test Album",
            coverUrl: null,
        });
        mockPrisma.album.update.mockResolvedValue({});
        mockPrisma.album.deleteMany.mockResolvedValue({ count: 0 });

        mockPrisma.downloadJob.findMany.mockResolvedValue([]);
        mockPrisma.discoveryAlbum.findFirst.mockResolvedValue(null);
        mockPrisma.ownedAlbum.create.mockResolvedValue({});

        mockBackfillAllArtistCounts.mockResolvedValue(undefined);
        mockGetAlbumCover.mockResolvedValue(null);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("skips unchanged files without parsing metadata again", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Track.mp3";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles"
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
            })
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
            "findAudioFiles"
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
            })
        );
        expect(mockParseFile).toHaveBeenCalledWith(audioFile);
        expect(mockPrisma.systemSettings.updateMany).toHaveBeenCalledWith({
            data: { discNoBackfillDone: true },
        });
    });

    it("processes new files and upserts tracks", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Test Track.flac";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles"
        ).mockResolvedValue([audioFile]);

        const result = await scanner.scanLibrary("/music");

        expect(result).toEqual(
            expect.objectContaining({
                tracksAdded: 1,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
            })
        );
        expect(mockParseFile).toHaveBeenCalledWith(audioFile);
        expect(mockPrisma.track.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { filePath: "Artist/Test Track.flac" },
                create: expect.objectContaining({
                    albumId: "album-1",
                    title: "Test Track",
                    filePath: "Artist/Test Track.flac",
                    mime: "audio/flac",
                }),
                update: expect.objectContaining({
                    albumId: "album-1",
                    title: "Test Track",
                    mime: "audio/flac",
                }),
            })
        );
        expect(mockBackfillAllArtistCounts).toHaveBeenCalledTimes(1);
    });

    it("removes missing tracks and cleans up orphan albums and artists", async () => {
        const scanner = new MusicScannerService();

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles"
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
                tracksRemoved: 1,
                errors: [],
            })
        );
        expect(mockPrisma.track.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["track-missing-1"] },
            },
        });
        expect(mockPrisma.album.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["album-orphan-1"] },
            },
        });
        expect(mockPrisma.artist.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["artist-orphan-1"] },
            },
        });
        expect(mockParseFile).not.toHaveBeenCalled();
    });

    it("collects file processing errors and continues scan completion", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Broken/Bad.flac";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles"
        ).mockResolvedValue([audioFile]);
        mockParseFile.mockRejectedValueOnce(new Error("metadata read failed"));

        const result = await scanner.scanLibrary("/music");

        expect(result.tracksAdded).toBe(1);
        expect(result.tracksUpdated).toBe(0);
        expect(result.tracksRemoved).toBe(0);
        expect(result.errors).toEqual([
            { file: audioFile, error: "metadata read failed" },
        ]);
        expect(mockPrisma.track.upsert).not.toHaveBeenCalled();
        expect(queueInstances[0].onIdle).toHaveBeenCalledTimes(1);
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
            "findAudioFiles"
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
                tracksAdded: 2,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [
                    {
                        file: badFile,
                        error: "metadata read failed",
                    },
                ],
            })
        );
        expect(progress[progress.length - 1]).toEqual(
            expect.objectContaining({
                filesScanned: 2,
                filesTotal: 2,
                currentFile: "Broken/Bad.flac",
                errors: [{ file: badFile, error: "metadata read failed" }],
            })
        );
        expect(queueInstances[0].add).toHaveBeenCalledTimes(2);
        expect(queueInstances[0].onIdle).toHaveBeenCalledTimes(1);
    });

    it("propagates queue scheduling failures", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Queued/Fail.flac";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles"
        ).mockResolvedValue([audioFile]);

        queueInstances[0].add = jest
            .fn()
            .mockRejectedValue(new Error("queue unavailable"));

        await expect(scanner.scanLibrary("/music")).rejects.toThrow(
            "queue unavailable"
        );
        expect(mockPrisma.track.upsert).not.toHaveBeenCalled();
    });

    it("does not fail scan when artist count backfill fails asynchronously", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Track.mp3";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles"
        ).mockResolvedValue([audioFile]);
        mockBackfillAllArtistCounts.mockRejectedValueOnce(
            new Error("backfill timeout")
        );

        const result = await scanner.scanLibrary("/music");

        expect(result.tracksAdded).toBe(1);
        expect(mockLogger.error).toHaveBeenCalledWith(
            "[Scan] Artist counts update failed:",
            expect.any(Error)
        );
        expect(result.errors).toEqual([]);
    });
});

function makeDirent(name: string, kind: "file" | "dir") {
    return {
        name,
        isDirectory: () => kind === "dir",
        isFile: () => kind === "file",
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

        expect(scanner.isDiscoveryPath("Discovery/Artist/Album/track.flac")).toBe(
            true
        );
        expect(scanner.isDiscoveryPath("discover\\Artist\\Album\\track.flac")).toBe(
            true
        );
        expect(scanner.isDiscoveryPath("library/Artist/Album/track.flac")).toBe(
            false
        );

        expect(scanner.normalizeForMatching("  Café   Déjà   Vu  ")).toBe(
            "cafe deja vu"
        );
    });

    it("matches discovery downloads by exact and fallback matching passes", async () => {
        const scanner = new MusicScannerService() as any;

        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-exact",
                metadata: { artistName: "Artist Name", albumTitle: "Album Name" },
            },
        ]);

        await expect(
            scanner.isDiscoveryDownload("Artist Name", "Album Name")
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
            scanner.isDiscoveryDownload("Artist Name", "Album Name (Deluxe)")
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
            scanner.isDiscoveryDownload("Featured Artist", "Some Album")
        ).resolves.toBe(true);
        expect(mockPrisma.album.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    artist: { name: { equals: "Featured Artist", mode: "insensitive" } },
                    location: "LIBRARY",
                },
            })
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
            scanner.isDiscoveryDownload("Library Artist", "Some Album")
        ).resolves.toBe(false);
        expect(mockPrisma.album.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    artist: { name: { equals: "Library Artist", mode: "insensitive" } },
                    location: "LIBRARY",
                },
            })
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
            scanner.isDiscoveryDownload("Featured Guest", "Shared Album")
        ).resolves.toBe(true);

        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([]);
        mockPrisma.discoveryAlbum.findFirst.mockResolvedValueOnce({
            id: "discovery-by-title",
        });
        await expect(
            scanner.isDiscoveryDownload("Any Artist", "Unique Album")
        ).resolves.toBe(true);

        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([]);
        mockPrisma.discoveryAlbum.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "discovery-by-artist" });
        mockPrisma.album.findFirst.mockResolvedValueOnce(null);
        await expect(
            scanner.isDiscoveryDownload("Discovery Artist", "Other Album")
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
            scanner.isDiscoveryDownload("Discovery Artist", "Other Album")
        ).resolves.toBe(false);
    });

    it("returns false when discovery matching throws", async () => {
        const scanner = new MusicScannerService() as any;
        mockPrisma.downloadJob.findMany.mockRejectedValueOnce(new Error("db down"));

        await expect(
            scanner.isDiscoveryDownload("Artist Name", "Album Name")
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
            scanner.isDiscoveryDownload("Non Matching Artist", "Strange Album")
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
                "Normalization Album"
            )
        ).resolves.toBe(false);
        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.stringContaining("Primary artist:")
        );
    });

    it("recursively finds audio files and filters unsupported extensions", async () => {
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
            ["/music/Artist/Track.mp3", "/music/Artist/Sub/Song.flac", "/music/Artist/Sub/Demo.wav"].sort()
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
            expect.any(Object)
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
    });

    it("uses grandparent folder as artist when metadata artist is missing", async () => {
        const scanner = new MusicScannerService() as any;

        mockParseArtistFromPath.mockImplementation((name: string) => {
            if (name === "Robbin' The Hood") return "";
            if (name === "Sublime") return "Sublime";
            return "";
        });
        mockNormalizeArtistName.mockImplementation((name: string) =>
            name.trim().toLowerCase()
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
            "/music"
        );

        expect(mockParseArtistFromPath).toHaveBeenCalledWith("Robbin' The Hood");
        expect(mockParseArtistFromPath).toHaveBeenCalledWith("Sublime");
        expect(mockPrisma.artist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    name: "Sublime",
                }),
            })
        );
    });

    it("uses grandparent folder name directly when parser does not recognize it", async () => {
        const scanner = new MusicScannerService() as any;

        mockParseArtistFromPath.mockReturnValue("");
        mockNormalizeArtistName.mockImplementation((name: string) =>
            name.trim().toLowerCase()
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
            "/music"
        );

        expect(mockPrisma.artist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    name: "Grandparent Artist",
                }),
            })
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
            "/music"
        );

        expect(mockPrisma.artist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    name: "Unknown Artist",
                }),
            })
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
            "/music"
        );

        expect(mockPrisma.album.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    location: "DISCOVER",
                    title: "Album Name",
                }),
            })
        );
        expect(mockPrisma.ownedAlbum.create).not.toHaveBeenCalled();
    });

    it("falls back to Deezer cover when extractor returns no local art", async () => {
        const scanner = new MusicScannerService(undefined, "/tmp/covers") as any;
        mockExtractCoverArt.mockResolvedValueOnce(null);
        mockGetAlbumCover.mockResolvedValueOnce("https://example.com/cover.jpg");

        await scanner.processAudioFile(
            "/music/DiscFallback/Track.flac",
            "DiscFallback/Track.flac",
            "/music"
        );

        expect(mockExtractCoverArt).toHaveBeenCalledWith(
            "/music/DiscFallback/Track.flac",
            "album-new"
        );
        expect(mockGetAlbumCover).toHaveBeenCalledWith(
            "DiscFallback",
            "Album Name"
        );
        expect(mockPrisma.album.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "album-new" },
                data: { coverUrl: "https://example.com/cover.jpg" },
            })
        );
    });

    it("updates an existing temp artist MBID when real MBID is discovered", async () => {
        const scanner = new MusicScannerService(undefined, "/tmp/covers") as any;

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
            "/music"
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
        const scanner = new MusicScannerService(undefined, "/tmp/covers") as any;
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
            "/music"
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
        const scanner = new MusicScannerService(undefined, "/tmp/covers") as any;
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
            "/music"
        );

        expect(mockPrisma.artist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    mbid: "temp-1700000000000-0.12345",
                }),
            })
        );
        expect(mockPrisma.album.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    rgMbid: "temp-1700000000000-0.12345",
                }),
            })
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
            "/music"
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
            "/music"
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
            "/music"
        );

        expect(mockPrisma.artist.findMany).toHaveBeenCalledTimes(1);
        expect(mockPrisma.artist.create).not.toHaveBeenCalled();
        expect(mockAreArtistNamesSimilar).toHaveBeenCalledWith(
            "The Weeknd",
            "The Weeknd",
            95
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
            "/music"
        );

        expect(mockPrisma.artist.update).toHaveBeenCalledWith({
            where: { id: "temp-artist" },
            data: { mbid: "mbid-collision" },
        });
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                "MBID collision detected for mbid-collision, but canonical artist lookup returned null; keeping temp artist linkage"
            )
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
                "/music"
            )
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
                "/music"
            )
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
                "/music"
            )
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
        mockPrisma.album.findFirst.mockResolvedValueOnce(null);
        mockPrisma.album.findUnique.mockResolvedValueOnce({
            id: "album-release",
            title: "Album Name",
            coverUrl: null,
            location: "LIBRARY",
            rgMbid: "rg-123",
        });

        await scanner.processAudioFile(
            "/music/Album Band/Track.flac",
            "Album Band/Track.flac",
            "/music"
        );

        expect(mockPrisma.album.findUnique).toHaveBeenCalledWith({
            where: { rgMbid: "rg-123" },
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
            "/music"
        );

        expect(mockPrisma.album.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    location: "DISCOVER",
                }),
            })
        );
        expect(mockPrisma.ownedAlbum.create).not.toHaveBeenCalled();
        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.stringContaining("Discovery-only artist detected: Discovery Artist")
        );
    });

    it("retries native cover extraction when cached extractor image is missing", async () => {
        const scanner = new MusicScannerService(undefined, "/tmp/covers") as any;

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
        mockExistsSync.mockImplementation((value) => !String(value).includes("/tmp/covers/cover-path.jpg"));

        await scanner.processAudioFile(
            "/music/Cover Artist/Track.flac",
            "Cover Artist/Track.flac",
            "/music"
        );

        expect(mockExtractCoverArt).toHaveBeenCalledWith(
            "/music/Cover Artist/Track.flac",
            "album-cover"
        );
        expect(mockPrisma.album.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "album-cover" },
                data: { coverUrl: "native:native-cover-path.jpg" },
            })
        );
    });
}); 
