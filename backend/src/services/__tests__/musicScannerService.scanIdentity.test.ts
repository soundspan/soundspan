import {
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
    resolveScannerAlbum,
    persistScannedTrack,
    isLossyAudioCodec,
    albumOrphanRetentionGuardWhere,
    artistOrphanRetentionGuardWhere,
    identityTrack,
    deferred,
    waitForCondition,
    makeDirent,
} from "./musicScannerService.helpers";

describe("MusicScannerService.scanLibrary", () => {
    beforeEach(() => {
        jest.clearAllMocks();
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
        mockPrisma.album.findMany.mockImplementation(async (query) =>
            query?.where?.artistId === "artist-1" && query?.select?.rgMbid
                ? [
                      {
                          id: "album-1",
                          title: "Test Album",
                          coverUrl: null,
                          location: "LIBRARY",
                          rgMbid: "rg-album-1",
                          _count: { tracks: 1 },
                      },
                  ]
                : [],
        );
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
        mockComputeAudioStreamHash.mockResolvedValue(
            "sha256:" + "ab".repeat(32),
        );
        mockCreateMapping.mockResolvedValue({ id: "mapping-1" });
        mockBumpSearchCacheVersion.mockResolvedValue(undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
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
        expect(mockParseFile).toHaveBeenCalledWith(audioFile, {
            skipCovers: true,
        });
        expect(mockParseFile).not.toHaveBeenCalledWith(audioFile, {
            duration: true,
            skipCovers: true,
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
        expect(mockUpdateArtistCountsInBatches).toHaveBeenCalledWith([
            "artist-1",
        ]);
    });

    it.each([
        { extension: "ape", expectedLabel: "APE" },
        { extension: "wv", expectedLabel: "WavPack" },
    ])(
        "derives a lossless $expectedLabel label when .$extension metadata has no codec or container",
        async ({ extension, expectedLabel }) => {
            const scanner = new MusicScannerService();
            const audioFile = `/music/Artist/Test Track.${extension}`;
            jest.spyOn(
                MusicScannerService.prototype as any,
                "findAudioFiles",
            ).mockResolvedValue([audioFile]);
            mockParseFile.mockResolvedValue({
                common: {
                    title: "Test Track",
                    track: { no: 1 },
                    disk: { no: 1 },
                    albumartist: "Test Artist",
                    album: "Test Album",
                },
                format: { duration: 218.7 },
            } as any);

            await scanner.scanLibrary("/music");

            const storedLabel =
                mockPrisma.track.upsert.mock.calls[0]?.[0]?.create?.mime;
            expect(storedLabel).toBe(expectedLabel);
            expect(isLossyAudioCodec(storedLabel)).toBe(false);
        },
    );

    it("keeps the unknown-format fallback out of lossy quality results", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Test Track.unknown";
        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockParseFile.mockResolvedValue({
            common: {
                title: "Test Track",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "Test Artist",
                album: "Test Album",
            },
            format: { duration: 218.7 },
        } as any);

        await scanner.scanLibrary("/music");

        const storedLabel =
            mockPrisma.track.upsert.mock.calls[0]?.[0]?.create?.mime;
        expect(storedLabel).toBe("audio/mpeg");
        expect(isLossyAudioCodec(storedLabel)).toBe(false);
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
        mockPrisma.album.findMany.mockResolvedValue([
            {
                id: "album-new",
                title: "Test Album",
                coverUrl: null,
                location: "LIBRARY",
                rgMbid: "rg-album-new",
                _count: { tracks: 1 },
            },
        ]);
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

        // Fast path plus one bounded transaction per orphan entity phase.
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(3);
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
        expect(mockParseFile).toHaveBeenCalledWith(audioFile, {
            skipCovers: true,
        });
        expect(mockParseFile).toHaveBeenCalledWith(audioFile, {
            duration: true,
            skipCovers: true,
        });
        expect(mockPrisma.track.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    duration: 145,
                }),
            }),
        );
    });

    it("serializes full-file duration fallbacks while header parses remain concurrent", async () => {
        const scanner = new MusicScannerService();
        const audioFiles = [
            "/music/Artist/First.opus",
            "/music/Artist/Second.opus",
        ];
        const firstFallback = deferred<any>();
        const secondFallback = deferred<any>();
        const fallbackStarts: string[] = [];
        const headerStarts: string[] = [];
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue(
            audioFiles,
        );
        mockParseFile.mockImplementation(
            async (audioFile: string, options?: { duration?: boolean }) => {
                const common = {
                    title: audioFile.includes("First") ? "First" : "Second",
                    track: { no: 1 },
                    disk: { no: 1 },
                    albumartist: "Test Artist",
                    album: "Test Album",
                };
                if (!options?.duration) {
                    headerStarts.push(audioFile);
                    return { common, format: { codec: "opus" } };
                }
                fallbackStarts.push(audioFile);
                return audioFile.includes("First")
                    ? firstFallback.promise
                    : secondFallback.promise;
            },
        );

        const scan = scanner.scanLibrary("/music");
        await waitForCondition(() => headerStarts.length === 2);
        await waitForCondition(() => fallbackStarts.length > 0);

        expect(headerStarts).toHaveLength(2);
        const fallbacksBeforeFirstCompletion = [...fallbackStarts];
        firstFallback.resolve({
            common: {
                title: "First",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "Test Artist",
                album: "Test Album",
            },
            format: { duration: 180, codec: "opus" },
        });
        await waitForCondition(() => fallbackStarts.length === 2);
        secondFallback.resolve({
            common: {
                title: "Second",
                track: { no: 2 },
                disk: { no: 1 },
                albumartist: "Test Artist",
                album: "Test Album",
            },
            format: { duration: 181, codec: "opus" },
        });

        await scan;
        expect(fallbacksBeforeFirstCompletion).toEqual([audioFiles[0]]);
        expect(fallbackStarts).toEqual(audioFiles);
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

    it("uses insensitive and normalized title matching for untagged files", async () => {
        const scanner = new MusicScannerService();

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue(["/music/Artist/Untagged.flac"]);
        mockParseFile.mockResolvedValue({
            common: {
                title: "Test Track",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "Test Artist",
                album: "Cafe and Rain",
            },
            format: { duration: 180, codec: "audio/flac" },
        } as any);
        // The insensitive query misses, then exact-key normalization joins the
        // punctuation, diacritic, and conjunction variant.
        mockPrisma.album.findFirst.mockResolvedValue(null);
        mockPrisma.album.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                {
                    id: "album-existing",
                    title: "Café & Rain",
                    coverUrl: null,
                    location: "LIBRARY",
                    rgMbid: "real-existing",
                    _count: { tracks: 1 },
                },
            ]);

        await scanner.scanLibrary("/music");

        expect(mockPrisma.album.findMany).toHaveBeenCalledWith({
            where: {
                artistId: "artist-1",
                title: { equals: "Cafe and Rain", mode: "insensitive" },
            },
            orderBy: { id: "asc" },
            take: 100,
            select: {
                coverUrl: true,
                id: true,
                location: true,
                rgMbid: true,
                title: true,
                _count: {
                    select: { tracks: { where: { removedAt: null } } },
                },
            },
        });
        expect(mockPrisma.album.findMany).toHaveBeenCalledWith({
            where: { artistId: "artist-1" },
            orderBy: { id: "asc" },
            select: {
                coverUrl: true,
                id: true,
                location: true,
                rgMbid: true,
                title: true,
                _count: {
                    select: { tracks: { where: { removedAt: null } } },
                },
            },
            take: 100,
        });
        expect(mockPrisma.album.create).not.toHaveBeenCalled();
    });

    it("prefers a sole real album across case and punctuation match tiers", async () => {
        mockPrisma.album.findFirst.mockResolvedValue(null);
        mockPrisma.album.findMany
            .mockResolvedValueOnce([
                {
                    id: "album-temp",
                    title: "CAFE AND RAIN",
                    coverUrl: null,
                    location: "LIBRARY",
                    rgMbid: "temp-existing",
                    _count: { tracks: 20 },
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: "album-real",
                    title: "Café & Rain",
                    coverUrl: null,
                    location: "LIBRARY",
                    rgMbid: "real-existing",
                    _count: { tracks: 1 },
                },
                {
                    id: "album-temp",
                    title: "CAFE AND RAIN",
                    coverUrl: null,
                    location: "LIBRARY",
                    rgMbid: "temp-existing",
                    _count: { tracks: 20 },
                },
            ]);

        const resolved = await resolveScannerAlbum({
            albumPromotions: new Map(),
            albumTitle: "Cafe and Rain",
            artistId: "artist-1",
            isDiscoveryAlbum: false,
            year: null,
        });

        expect(resolved.album.id).toBe("album-real");
    });

    it("uses active-track count and lowest id when multiple real rows match", async () => {
        mockPrisma.album.findFirst.mockResolvedValue(null);
        mockPrisma.album.findMany
            .mockResolvedValueOnce([
                {
                    id: "album-b",
                    title: "ALBUM",
                    coverUrl: null,
                    location: "LIBRARY",
                    rgMbid: "real-b",
                    _count: { tracks: 4 },
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: "album-b",
                    title: "ALBUM",
                    coverUrl: null,
                    location: "LIBRARY",
                    rgMbid: "real-b",
                    _count: { tracks: 4 },
                },
                {
                    id: "album-a",
                    title: "Album!",
                    coverUrl: null,
                    location: "LIBRARY",
                    rgMbid: "real-a",
                    _count: { tracks: 4 },
                },
            ]);

        const resolved = await resolveScannerAlbum({
            albumPromotions: new Map(),
            albumTitle: "Album",
            artistId: "artist-1",
            isDiscoveryAlbum: false,
            year: null,
        });

        expect(resolved.album.id).toBe("album-a");
    });

    it("keeps untagged album editions distinct", async () => {
        const scanner = new MusicScannerService();

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue(["/music/Artist/Take Care Deluxe/01.flac"]);
        mockParseFile.mockResolvedValue({
            common: {
                title: "Over My Dead Body",
                track: { no: 1 },
                disk: { no: 1 },
                albumartist: "Test Artist",
                album: "Take Care (Deluxe)",
            },
            format: { duration: 180, codec: "audio/flac" },
        } as any);
        mockPrisma.album.findFirst.mockResolvedValue(null);
        mockPrisma.album.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                {
                    id: "album-standard",
                    title: "Take Care",
                    coverUrl: null,
                    location: "LIBRARY",
                    rgMbid: "real-standard",
                },
            ]);
        mockPrisma.album.create.mockResolvedValue({
            id: "album-deluxe",
            title: "Take Care (Deluxe)",
            coverUrl: null,
            location: "LIBRARY",
            rgMbid: "temp-deluxe",
        });

        await scanner.scanLibrary("/music");

        expect(mockPrisma.album.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    title: "Take Care (Deluxe)",
                }),
            }),
        );
    });

    it("shares an in-scan album resolution across normalized title variants", async () => {
        const scanner = new MusicScannerService();
        const lookup = deferred<{
            id: string;
            title: string;
            coverUrl: null;
            location: "LIBRARY";
            rgMbid: string;
            _count: { tracks: number };
        }>();
        const audioFiles = [
            "/music/Artist/Album/01.flac",
            "/music/Artist/Album/02.flac",
        ];
        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue(audioFiles);
        mockParseFile.mockImplementation(async (audioFile: string) => ({
            common: {
                title: audioFile.endsWith("01.flac") ? "First" : "Second",
                track: { no: audioFile.endsWith("01.flac") ? 1 : 2 },
                disk: { no: 1 },
                albumartist: "Test Artist",
                album: audioFile.endsWith("01.flac")
                    ? "Café & Rain"
                    : "Cafe and Rain",
            },
            format: { duration: 180, codec: "audio/flac" },
        }));
        mockPrisma.album.findMany.mockReturnValue(lookup.promise);

        const scan = scanner.scanLibrary("/music");
        await waitForCondition(() => mockParseFile.mock.calls.length === 2);
        await waitForCondition(
            () => mockPrisma.album.findMany.mock.calls.length > 0,
        );
        lookup.resolve({
            id: "album-existing",
            title: "Café & Rain",
            coverUrl: null,
            location: "LIBRARY",
            rgMbid: "real-existing",
            _count: { tracks: 1 },
        });

        await scan;

        const identityLookups = mockPrisma.album.findMany.mock.calls.filter(
            ([query]) =>
                query?.where?.artistId === "artist-1" && query?.select?._count,
        );
        expect(identityLookups).toHaveLength(2);
        expect(mockPrisma.album.create).not.toHaveBeenCalled();
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
        expect(mockParseFile).toHaveBeenCalledWith(audioFile, {
            skipCovers: true,
        });
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

    it("promotes a shared album once before soft-removing ambiguous moves", async () => {
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

        // Promotion, soft-remove, and one transaction per orphan entity phase.
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(4);
        expect(mockPrisma.ownedAlbum.upsert).toHaveBeenCalledTimes(1);
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

    it("shares an in-flight album promotion and retries after failure", async () => {
        const scanner = new MusicScannerService() as any;
        const promotions = new Map<string, Promise<void>>();
        const album = {
            id: "album-1",
            artistId: "artist-1",
            rgMbid: "rg-album-1",
            location: "DISCOVER",
        };
        let rejectPromotion: ((error: Error) => void) | undefined;
        mockPrisma.$transaction.mockImplementationOnce(
            () =>
                new Promise<void>((_resolve, reject) => {
                    rejectPromotion = reject;
                }),
        );

        const first = scanner.promoteNativeAlbumOnce(album, promotions);
        const concurrent = scanner.promoteNativeAlbumOnce(album, promotions);

        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
        rejectPromotion?.(new Error("promotion failed"));
        await expect(first).rejects.toThrow("promotion failed");
        await expect(concurrent).rejects.toThrow("promotion failed");
        expect(promotions.has(album.id)).toBe(false);

        await expect(
            scanner.promoteNativeAlbumOnce(album, promotions),
        ).resolves.toBeUndefined();
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
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
        expect(mockUpdateArtistCountsInBatches).toHaveBeenCalledWith([
            "artist-1",
        ]);
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
        const orphanAlbumQuery = mockPrisma.album.findMany.mock.calls.find(
            ([args]: [{ where?: { tracksTidal?: unknown } }]) =>
                args?.where?.tracksTidal,
        )?.[0];
        const orphanCutoff = orphanAlbumQuery?.where?.tracksTidal?.none?.NOT
            ?.createdAt?.lt as Date;
        expect(orphanCutoff).toBeInstanceOf(Date);
        expect(orphanAlbumQuery).toEqual({
            where: {
                peerId: null,
                location: {
                    in: ["LIBRARY", "DISCOVER", "REMOTE", "FEDERATED"],
                },
                tracks: { none: {} },
                ...albumOrphanRetentionGuardWhere(orphanCutoff),
            },
            orderBy: { id: "asc" },
            take: 100,
            select: { id: true },
        });
        expect(mockPrisma.artist.findMany).toHaveBeenCalledWith({
            where: {
                peerId: null,
                albums: { none: {} },
                ...artistOrphanRetentionGuardWhere(orphanCutoff),
            },
            orderBy: { id: "asc" },
            take: 100,
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

        const guardedAlbumDelete =
            mockPrisma.album.deleteMany.mock.calls[0]?.[0];
        const deleteCutoff = guardedAlbumDelete?.where?.tracksTidal?.none?.NOT
            ?.createdAt?.lt as Date;
        expect(deleteCutoff).toBeInstanceOf(Date);
        expect(guardedAlbumDelete).toEqual({
            where: {
                id: { in: ["album-1"] },
                peerId: null,
                location: {
                    in: ["LIBRARY", "DISCOVER", "REMOTE", "FEDERATED"],
                },
                tracks: { none: {} },
                ...albumOrphanRetentionGuardWhere(deleteCutoff),
            },
        });
        expect(mockPrisma.artist.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["artist-1"] },
                peerId: null,
                albums: { none: {} },
                ...artistOrphanRetentionGuardWhere(deleteCutoff),
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

    it("refreshes the persisted artist when health cleanup fails", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Track.flac";
        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        mockPrisma.libraryHealthRecord.deleteMany.mockRejectedValueOnce(
            new Error("health cleanup failed"),
        );

        const result = await scanner.scanLibrary("/music");

        expect(mockPrisma.track.upsert).toHaveBeenCalledTimes(1);
        expect(result.errors).toEqual([
            { file: audioFile, error: "health cleanup failed" },
        ]);
        expect(mockUpdateArtistCountsInBatches).toHaveBeenCalledWith([
            "artist-1",
        ]);
    });

    it("keeps a fast-path persist successful when mutation recording throws", async () => {
        const recorderError = new Error("mutation recorder failed");
        const artistIds = new Set<string>();
        const clearHealthIssue = jest.fn(async () => undefined);
        mockPrisma.track.upsert.mockResolvedValueOnce({ id: "track-new" });

        await expect(
            persistScannedTrack(
                {} as Parameters<typeof persistScannedTrack>[0],
                "album-1",
                218,
                {
                    contentChangeDetected: false,
                    storedAudioHash: null,
                    computedAudioHash: null,
                    previousAlbumId: null,
                    previousDuration: null,
                    revival: false,
                },
                clearHealthIssue,
                () => {
                    artistIds.add("artist-1");
                    throw recorderError;
                },
            ),
        ).resolves.toBeUndefined();

        expect(clearHealthIssue).toHaveBeenCalledWith("track-new");
        expect(artistIds).toEqual(new Set(["artist-1"]));
        expect(mockLogger.warn).toHaveBeenCalledWith(
            "Failed to record durable scanned track mutation",
            { error: recorderError },
        );
    });

    it("keeps a transactional persist successful when mutation recording throws", async () => {
        const recorderError = new Error("mutation recorder failed");
        const artistIds = new Set<string>();
        mockPrisma.track.upsert.mockResolvedValueOnce({
            id: "track-existing",
        });

        await expect(
            persistScannedTrack(
                {} as Parameters<typeof persistScannedTrack>[0],
                "album-1",
                218,
                {
                    contentChangeDetected: false,
                    storedAudioHash: null,
                    computedAudioHash: null,
                    previousAlbumId: "album-1",
                    previousDuration: 218,
                    revival: true,
                },
                jest.fn(async () => undefined),
                () => {
                    artistIds.add("artist-1");
                    throw recorderError;
                },
            ),
        ).resolves.toBeUndefined();

        expect(mockRecomputeAlbumLoudness).toHaveBeenCalled();
        expect(artistIds).toEqual(new Set(["artist-1"]));
        expect(mockLogger.warn).toHaveBeenCalledWith(
            "Failed to record durable scanned track mutation",
            { error: recorderError },
        );
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
            identityTrack("track-existing-2", "Artist/Track.mp3", {
                fileModified: new Date("2026-01-01T00:00:00.000Z"),
            }),
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

    it("continues scan with completion-ordered progress and mixed file outcomes", async () => {
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
                currentFile: "Good/Track.flac",
                errors: [{ file: badFile, error: "metadata read failed" }],
            }),
        );
        expect(queueInstances[0].add).toHaveBeenCalledTimes(2);
        expect(queueInstances[0].onIdle).toHaveBeenCalledTimes(1);
    });

    it("records a task-wrapper failure exactly once without rejecting the queue", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Callback/Fail.flac";

        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue([audioFile]);
        const progressFailure = jest.fn(() => {
            throw new Error("progress callback failed");
        });
        (scanner as any).progressCallback = progressFailure;

        await expect(scanner.scanLibrary("/music")).resolves.toEqual(
            expect.objectContaining({
                tracksAdded: 0,
                errors: [
                    { file: audioFile, error: "progress callback failed" },
                ],
            }),
        );
        expect(mockPrisma.track.upsert).not.toHaveBeenCalled();
        expect(progressFailure).toHaveBeenCalledTimes(2);
    });

    it("does not fail the scan when scoped artist count refresh fails", async () => {
        const scanner = new MusicScannerService();
        jest.spyOn(
            MusicScannerService.prototype as any,
            "findAudioFiles",
        ).mockResolvedValue(["/music/Artist/Track.mp3"]);
        mockUpdateArtistCountsInBatches.mockRejectedValueOnce(
            new Error("count refresh failed"),
        );

        const result = await scanner.scanLibrary("/music");
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(result.tracksAdded).toBe(1);
        expect(mockLogger.error).toHaveBeenCalledWith(
            "[Scan] Artist counts update failed:",
            expect.any(Error),
        );
    });
});
