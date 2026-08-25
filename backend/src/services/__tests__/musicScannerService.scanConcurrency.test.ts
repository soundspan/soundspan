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
    persistScannedTrack,
    isLossyAudioCodec,
    albumOrphanRetentionGuardWhere,
    artistOrphanRetentionGuardWhere,
    identityTrack,
    deferred,
    waitForCondition,
    makeDirent,
} from "./musicScannerService.helpers";
import type { TestIdentityTrack } from "./musicScannerService.helpers";

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

    it("bumps the search cache version once after a completed scan", async () => {
        const scanner = new MusicScannerService();
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue([]);

        await scanner.scanLibrary("/music");

        expect(mockBumpSearchCacheVersion).toHaveBeenCalledTimes(1);
    });

    it("starts multiple per-file tasks before the first one completes", async () => {
        const scanner = new MusicScannerService();
        const audioFiles = [
            "/music/Artist/First.flac",
            "/music/Artist/Second.flac",
            "/music/Artist/Third.flac",
        ];
        const controls = new Map(audioFiles.map((file) => [file, deferred()]));
        const started: string[] = [];
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue(
            audioFiles,
        );
        jest.spyOn(scanner as any, "processAudioFile").mockImplementation(
            async (...args: unknown[]) => {
                const audioFile = String(args[0]);
                started.push(audioFile);
                await controls.get(audioFile)!.promise;
            },
        );

        const scan = scanner.scanLibrary("/music");
        await waitForCondition(
            () => queueInstances[0]?.add.mock.calls.length > 0,
        );

        expect(started).toEqual(audioFiles.slice(0, 2));
        controls.forEach((control) => control.resolve());
        await scan;
    });

    it("never exceeds the configured per-file concurrency", async () => {
        const scanner = new MusicScannerService();
        const audioFiles = Array.from(
            { length: 5 },
            (_, index) => `/music/Artist/Track-${index}.flac`,
        );
        const releases: Array<() => void> = [];
        let inFlight = 0;
        let maxInFlight = 0;
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue(
            audioFiles,
        );
        jest.spyOn(scanner as any, "processAudioFile").mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    inFlight++;
                    maxInFlight = Math.max(maxInFlight, inFlight);
                    releases.push(() => {
                        inFlight--;
                        resolve();
                    });
                }),
        );

        const scan = scanner.scanLibrary("/music");
        await waitForCondition(
            () => queueInstances[0]?.add.mock.calls.length > 0,
        );
        expect(inFlight).toBe(2);
        releases.splice(0).forEach((release) => release());
        await new Promise<void>((resolve) => setImmediate(resolve));
        releases.splice(0).forEach((release) => release());
        await new Promise<void>((resolve) => setImmediate(resolve));
        releases.splice(0).forEach((release) => release());
        await scan;

        expect(maxInFlight).toBe(mockConfig.scanFileConcurrency);
    });

    it("keeps the pending producer backlog within four concurrency batches", async () => {
        const scanner = new MusicScannerService();
        const audioFiles = Array.from(
            { length: 50 },
            (_, index) => `/music/Artist/Track-${index}.flac`,
        );
        const work = deferred();
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue(
            audioFiles,
        );
        jest.spyOn(scanner as any, "processAudioFile").mockImplementation(
            () => work.promise,
        );

        const scan = scanner.scanLibrary("/music");
        await waitForCondition(() => queueInstances[0]?.size >= 8);

        const maxPendingSize = queueInstances[0].maxSize;
        work.resolve();
        await scan;
        expect(maxPendingSize).toBeLessThanOrEqual(
            mockConfig.scanFileConcurrency * 4,
        );
    });

    it("serializes artist creation but preserves exact untagged album titles", async () => {
        const scanner = new MusicScannerService();
        const audioFiles = [
            "/music/New Artist/New Album/01.flac",
            "/music/New Artist/New Album/02.flac",
        ];
        const artistLookup = deferred<null>();
        const artistCreate = deferred<any>();
        let createdArtist: any;
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue(
            audioFiles,
        );
        mockParseFile.mockImplementation(async (audioFile: string) => ({
            common: {
                title: audioFile.includes("01") ? "Track 1" : "Track 2",
                track: { no: audioFile.includes("01") ? 1 : 2 },
                disk: { no: 1 },
                albumartist: "New Artist",
                album: audioFile.includes("01")
                    ? "New Album"
                    : "  NEW   ALBUM ",
            },
            format: { duration: 180, codec: "audio/flac" },
        }));
        mockPrisma.artist.findFirst.mockImplementation(() =>
            createdArtist
                ? Promise.resolve(createdArtist)
                : artistLookup.promise,
        );
        mockPrisma.artist.findMany.mockResolvedValue([]);
        mockPrisma.artist.create.mockImplementation(() =>
            artistCreate.promise.then((artist) => {
                createdArtist = artist;
                return artist;
            }),
        );
        mockPrisma.album.findFirst.mockResolvedValue(null);
        mockPrisma.album.create.mockImplementation(
            async ({ data }: { data: { title: string } }) => ({
                id: data.title === "New Album" ? "album-exact" : "album-spaced",
                title: data.title,
                coverUrl: null,
                location: "LIBRARY",
                rgMbid: `temp-${data.title}`,
            }),
        );

        const scan = scanner.scanLibrary("/music");
        await waitForCondition(() => mockParseFile.mock.calls.length === 2);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const artistLookupCalls = mockPrisma.artist.findFirst.mock.calls.length;

        artistLookup.resolve(null);
        await waitForCondition(
            () => mockPrisma.artist.create.mock.calls.length > 0,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        artistCreate.resolve({
            id: "artist-new",
            name: "New Artist",
            normalizedName: "new artist",
        });

        await scan;
        expect(artistLookupCalls).toBe(2);
        expect(mockPrisma.artist.findFirst).toHaveBeenCalledTimes(4);
        expect(mockPrisma.artist.create).toHaveBeenCalledTimes(1);
        expect(mockPrisma.album.findFirst).toHaveBeenCalledTimes(2);
        expect(mockPrisma.album.findFirst).toHaveBeenCalledWith({
            where: { artistId: "artist-new", title: "New Album" },
        });
        expect(mockPrisma.album.findFirst).toHaveBeenCalledWith({
            where: { artistId: "artist-new", title: "  NEW   ALBUM " },
        });
        expect(mockPrisma.album.create).toHaveBeenCalledTimes(2);
        expect(mockPrisma.track.upsert).toHaveBeenCalledTimes(2);
        expect(
            mockPrisma.track.upsert.mock.calls.map(
                ([args]) => args.create.albumId,
            ),
        ).toEqual(expect.arrayContaining(["album-exact", "album-spaced"]));
    });

    it("resolves concurrent raw artist fallbacks independently", async () => {
        const scanner = new MusicScannerService();
        const audioFiles = [
            "/music/Artist & Guest A/Shared Album/01.flac",
            "/music/Artist & Guest B/Shared Album/02.flac",
        ];
        const primaryLookup = deferred<null>();
        const artistsByNormalizedName = new Map([
            [
                "artist & guest a",
                {
                    id: "artist-guest-a",
                    name: "Artist & Guest A",
                    normalizedName: "artist & guest a",
                },
            ],
            [
                "artist & guest b",
                {
                    id: "artist-guest-b",
                    name: "Artist & Guest B",
                    normalizedName: "artist & guest b",
                },
            ],
        ]);
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue(
            audioFiles,
        );
        mockExtractPrimaryArtist
            .mockReturnValueOnce("Artist")
            .mockReturnValueOnce("Artist");
        mockParseFile.mockImplementation(async (audioFile: string) => ({
            common: {
                title: audioFile.includes("01") ? "Track 1" : "Track 2",
                track: { no: audioFile.includes("01") ? 1 : 2 },
                disk: { no: 1 },
                albumartist: audioFile.includes("Guest A")
                    ? "Artist & Guest A"
                    : "Artist & Guest B",
                album: "Shared Album",
            },
            format: { duration: 180, codec: "audio/flac" },
        }));
        mockPrisma.artist.findFirst.mockImplementation(
            ({ where }: { where: { normalizedName: string } }) => {
                if (where.normalizedName === "artist") {
                    return primaryLookup.promise;
                }
                return Promise.resolve(
                    artistsByNormalizedName.get(where.normalizedName) ?? null,
                );
            },
        );
        mockPrisma.album.findFirst.mockImplementation(
            async ({ where }: { where: { artistId: string } }) => ({
                id: `album-${where.artistId}`,
                title: "Shared Album",
                coverUrl: null,
                location: "LIBRARY",
                rgMbid: `rg-${where.artistId}`,
            }),
        );

        const scan = scanner.scanLibrary("/music");
        await waitForCondition(() => mockParseFile.mock.calls.length === 2);
        await new Promise<void>((resolve) => setImmediate(resolve));
        primaryLookup.resolve(null);
        await scan;

        expect(mockPrisma.artist.findFirst).toHaveBeenCalledWith({
            where: { normalizedName: "artist & guest a" },
        });
        expect(mockPrisma.artist.findFirst).toHaveBeenCalledWith({
            where: { normalizedName: "artist & guest b" },
        });
        expect(
            mockPrisma.track.upsert.mock.calls.map(([args]) => [
                args.create.filePath,
                args.create.albumId,
            ]),
        ).toEqual(
            expect.arrayContaining([
                [
                    "Artist & Guest A/Shared Album/01.flac",
                    "album-artist-guest-a",
                ],
                [
                    "Artist & Guest B/Shared Album/02.flac",
                    "album-artist-guest-b",
                ],
            ]),
        );
    });

    it("serializes concurrent creation by normalized artist name", async () => {
        const scanner = new MusicScannerService();
        const audioFiles = [
            "/music/Artist feat. Guest A/Shared Album/01.flac",
            "/music/Artist feat. Guest B/Shared Album/02.flac",
        ];
        let createdArtist:
            | {
                  id: string;
                  name: string;
                  normalizedName: string;
              }
            | undefined;
        let primaryLookupDelayed = false;
        const albumsByIdentity = new Map<
            string,
            {
                id: string;
                title: string;
                coverUrl: null;
                location: string;
                rgMbid: string;
            }
        >();
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue(
            audioFiles,
        );
        mockExtractPrimaryArtist
            .mockReturnValueOnce("Artist")
            .mockReturnValueOnce("Artist");
        mockParseFile.mockImplementation(async (audioFile: string) => ({
            common: {
                title: audioFile.includes("01") ? "Track 1" : "Track 2",
                track: { no: audioFile.includes("01") ? 1 : 2 },
                disk: { no: 1 },
                albumartist: audioFile.includes("Guest A")
                    ? "Artist feat. Guest A"
                    : "Artist feat. Guest B",
                album: "Shared Album",
            },
            format: { duration: 180, codec: "audio/flac" },
        }));
        mockPrisma.artist.findFirst.mockImplementation(
            async ({ where }: { where: { normalizedName: string } }) => {
                if (where.normalizedName !== "artist") return null;
                const artistAtLookup = createdArtist;
                if (!artistAtLookup && !primaryLookupDelayed) {
                    primaryLookupDelayed = true;
                    await new Promise<void>((resolve) => setImmediate(resolve));
                }
                return artistAtLookup ?? null;
            },
        );
        mockPrisma.artist.create.mockImplementation(
            async ({ data }: { data: { name: string } }) => {
                createdArtist = {
                    id: `artist-${mockPrisma.artist.create.mock.calls.length}`,
                    name: data.name,
                    normalizedName: "artist",
                };
                return createdArtist;
            },
        );
        mockPrisma.album.findFirst.mockImplementation(
            async ({ where }: { where: { artistId: string; title: string } }) =>
                albumsByIdentity.get(`${where.artistId}:${where.title}`) ??
                null,
        );
        mockPrisma.album.create.mockImplementation(
            async ({ data }: { data: { artistId: string; title: string } }) => {
                const album = {
                    id: `album-${data.artistId}`,
                    title: data.title,
                    coverUrl: null,
                    location: "LIBRARY",
                    rgMbid: `temp-${data.artistId}`,
                };
                albumsByIdentity.set(`${data.artistId}:${data.title}`, album);
                return album;
            },
        );

        await scanner.scanLibrary("/music");

        expect(mockPrisma.artist.create).toHaveBeenCalledTimes(1);
        expect(createdArtist?.id).toBe("artist-1");
        expect(mockPrisma.album.create).toHaveBeenCalledTimes(1);
        expect(mockPrisma.album.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ artistId: "artist-1" }),
            }),
        );
        expect(mockPrisma.track.upsert).toHaveBeenCalledTimes(2);
        for (const [args] of mockPrisma.track.upsert.mock.calls) {
            expect(args.create.albumId).toBe("album-artist-1");
        }
    });

    it("serializes concurrent creation for fuzzy-equivalent artist names", async () => {
        const scanner = new MusicScannerService();
        const audioFiles = [
            "/music/The Weeknd/Shared Album/01.flac",
            "/music/the weekend/Shared Album/02.flac",
        ];
        const initialFuzzyLookups = deferred<never[]>();
        const artistsByNormalizedName = new Map<
            string,
            {
                id: string;
                name: string;
                normalizedName: string;
            }
        >();
        const albumsByIdentity = new Map<
            string,
            {
                id: string;
                title: string;
                coverUrl: null;
                location: string;
                rgMbid: string;
            }
        >();
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue(
            audioFiles,
        );
        mockParseFile.mockImplementation(async (audioFile: string) => {
            const first = audioFile.includes("/The Weeknd/");
            return {
                common: {
                    title: first ? "Track 1" : "Track 2",
                    track: { no: first ? 1 : 2 },
                    disk: { no: 1 },
                    albumartist: first ? "The Weeknd" : "the weekend",
                    album: "Shared Album",
                },
                format: { duration: 180, codec: "audio/flac" },
            };
        });
        mockPrisma.artist.findFirst.mockImplementation(
            async ({ where }: { where: { normalizedName: string } }) =>
                artistsByNormalizedName.get(where.normalizedName) ?? null,
        );
        mockPrisma.artist.findMany.mockImplementation(
            ({
                where,
            }: {
                where: { normalizedName: { startsWith: string } };
            }) => {
                if (mockPrisma.artist.findMany.mock.calls.length <= 2) {
                    return initialFuzzyLookups.promise;
                }
                return Promise.resolve(
                    [...artistsByNormalizedName.values()].filter((artist) =>
                        artist.normalizedName.startsWith(
                            where.normalizedName.startsWith,
                        ),
                    ),
                );
            },
        );
        mockAreArtistNamesSimilar.mockImplementation(
            (first: string, second: string, threshold: number) =>
                threshold === 95 &&
                new Set([first.toLowerCase(), second.toLowerCase()]).size === 2,
        );
        mockPrisma.artist.create.mockImplementation(
            async ({
                data,
            }: {
                data: { name: string; normalizedName: string };
            }) => {
                const artist = {
                    id: `artist-${mockPrisma.artist.create.mock.calls.length}`,
                    name: data.name,
                    normalizedName: data.normalizedName,
                };
                artistsByNormalizedName.set(data.normalizedName, artist);
                return artist;
            },
        );
        mockPrisma.album.findFirst.mockImplementation(
            async ({ where }: { where: { artistId: string; title: string } }) =>
                albumsByIdentity.get(`${where.artistId}:${where.title}`) ??
                null,
        );
        mockPrisma.album.create.mockImplementation(
            async ({ data }: { data: { artistId: string; title: string } }) => {
                const album = {
                    id: `album-${data.artistId}`,
                    title: data.title,
                    coverUrl: null,
                    location: "LIBRARY",
                    rgMbid: `temp-${data.artistId}`,
                };
                albumsByIdentity.set(`${data.artistId}:${data.title}`, album);
                return album;
            },
        );

        const scan = scanner.scanLibrary("/music");
        await waitForCondition(
            () => mockPrisma.artist.findMany.mock.calls.length === 2,
        );
        initialFuzzyLookups.resolve([]);
        await scan;

        expect(mockPrisma.artist.create).toHaveBeenCalledTimes(1);
        expect(mockPrisma.track.upsert).toHaveBeenCalledTimes(2);
        expect(
            mockPrisma.track.upsert.mock.calls.map(
                ([args]) => args.create.albumId,
            ),
        ).toEqual(["album-artist-1", "album-artist-1"]);
    });

    it("singleflights concurrent tagged creation of the same new album", async () => {
        const scanner = new MusicScannerService();
        const audioFiles = [
            "/music/Tagged Artist/Tagged Album/01.flac",
            "/music/Tagged Artist/Tagged Album/02.flac",
        ];
        const albumLookup = deferred<null>();
        const albumCreate = deferred<any>();
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue(
            audioFiles,
        );
        mockParseFile.mockImplementation(async (audioFile: string) => ({
            common: {
                title: audioFile.includes("01") ? "Track 1" : "Track 2",
                track: { no: audioFile.includes("01") ? 1 : 2 },
                disk: { no: 1 },
                albumartist: "Test Artist",
                album: "Tagged Album",
                musicbrainz_releasegroupid: "rg-tagged",
            },
            format: { duration: 180, codec: "audio/flac" },
        }));
        mockPrisma.album.findFirst.mockReturnValue(albumLookup.promise);
        mockPrisma.album.create.mockReturnValue(albumCreate.promise);

        const scan = scanner.scanLibrary("/music");
        await waitForCondition(
            () => mockPrisma.album.findFirst.mock.calls.length > 0,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        const albumLookupCalls = mockPrisma.album.findFirst.mock.calls.length;
        albumLookup.resolve(null);
        await waitForCondition(
            () => mockPrisma.album.create.mock.calls.length > 0,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        const albumCreateCalls = mockPrisma.album.create.mock.calls.length;
        albumCreate.resolve({
            id: "album-tagged",
            title: "Tagged Album",
            coverUrl: null,
            location: "LIBRARY",
            rgMbid: "rg-tagged",
        });

        await scan;
        expect(albumLookupCalls).toBe(1);
        expect(albumCreateCalls).toBe(1);
        expect(mockPrisma.track.upsert).toHaveBeenCalledTimes(2);
        for (const [args] of mockPrisma.track.upsert.mock.calls) {
            expect(args.create.albumId).toBe("album-tagged");
        }
    });

    it("creates same-titled tagged albums with different release-group MBIDs concurrently", async () => {
        const scanner = new MusicScannerService();
        const audioFiles = [
            "/music/Tagged Artist/Self Titled/01.flac",
            "/music/Tagged Artist/Self Titled/02.flac",
        ];
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue(
            audioFiles,
        );
        mockParseFile.mockImplementation(async (audioFile: string) => {
            const first = audioFile.includes("01");
            return {
                common: {
                    title: first ? "Track 1" : "Track 2",
                    track: { no: first ? 1 : 2 },
                    disk: { no: 1 },
                    albumartist: "Test Artist",
                    album: "Self Titled",
                    musicbrainz_releasegroupid: first ? "rg-one" : "rg-two",
                },
                format: { duration: 180, codec: "audio/flac" },
            };
        });
        mockPrisma.album.findFirst.mockResolvedValue(null);
        mockPrisma.album.findUnique.mockResolvedValue(null);
        mockPrisma.album.create.mockImplementation(
            async ({ data }: { data: { rgMbid: string; title: string } }) => ({
                id: `album-${data.rgMbid}`,
                title: data.title,
                coverUrl: null,
                location: "LIBRARY",
                rgMbid: data.rgMbid,
            }),
        );

        await scanner.scanLibrary("/music");

        expect(mockPrisma.album.findFirst).toHaveBeenCalledTimes(2);
        expect(mockPrisma.album.create).toHaveBeenCalledTimes(2);
        expect(
            mockPrisma.track.upsert.mock.calls.map(
                ([args]) => args.create.albumId,
            ),
        ).toEqual(expect.arrayContaining(["album-rg-one", "album-rg-two"]));
    });

    it("loads selected discovery download identities once per scan and resets between scans", async () => {
        const scanner = new MusicScannerService();
        const findAudioFiles = jest
            .spyOn(scanner as any, "findAudioFiles")
            .mockResolvedValueOnce([
                "/music/Artist/First.flac",
                "/music/Artist/Second.flac",
            ])
            .mockResolvedValueOnce(["/music/Artist/Third.flac"]);

        await scanner.scanLibrary("/music");
        expect(mockPrisma.downloadJob.findMany).toHaveBeenCalledTimes(1);
        expect(mockPrisma.downloadJob.findMany).toHaveBeenCalledWith({
            where: {
                discoveryBatchId: { not: null },
                status: { in: ["pending", "processing", "completed"] },
            },
            select: { id: true, metadata: true },
        });

        await scanner.scanLibrary("/music");
        expect(findAudioFiles).toHaveBeenCalledTimes(2);
        expect(mockPrisma.downloadJob.findMany).toHaveBeenCalledTimes(2);
    });

    it("retries discovery identity loading after a per-file database failure", async () => {
        mockConfig.scanFileConcurrency = 1;
        const scanner = new MusicScannerService();
        const firstFile = "/music/Artist/First.flac";
        const secondFile = "/music/Artist/Second.flac";
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue([
            firstFile,
            secondFile,
        ]);
        mockPrisma.downloadJob.findMany
            .mockRejectedValueOnce(new Error("transient discovery query"))
            .mockResolvedValueOnce([]);

        const result = await scanner.scanLibrary("/music");

        expect(result).toEqual(
            expect.objectContaining({
                tracksAdded: 1,
                errors: [
                    { file: firstFile, error: "transient discovery query" },
                ],
            }),
        );
        expect(mockPrisma.downloadJob.findMany).toHaveBeenCalledTimes(2);
        expect(mockPrisma.track.upsert).toHaveBeenCalledTimes(1);
    });

    it("waits for every per-file task before producing the scan result", async () => {
        const scanner = new MusicScannerService();
        const lateFile = "/music/Artist/Late.flac";
        const late = deferred();
        let scanSettled = false;
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue([
            "/music/Artist/Early.flac",
            lateFile,
        ]);
        jest.spyOn(scanner as any, "processAudioFile").mockImplementation(
            (...args: unknown[]) =>
                String(args[0]) === lateFile ? late.promise : Promise.resolve(),
        );

        const scan = scanner.scanLibrary("/music").then((result) => {
            scanSettled = true;
            return result;
        });
        await waitForCondition(
            () => (scanner as any).processAudioFile.mock.calls.length === 2,
        );

        expect(scanSettled).toBe(false);
        late.resolve();
        await expect(scan).resolves.toEqual(
            expect.objectContaining({ tracksAdded: 2, errors: [] }),
        );
    });

    it("retains successful file results when a concurrent file records an error", async () => {
        const scanner = new MusicScannerService();
        const badFile = "/music/Artist/Bad.flac";
        const audioFiles = [
            "/music/Artist/First.flac",
            badFile,
            "/music/Artist/Last.flac",
        ];
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue(
            audioFiles,
        );
        jest.spyOn(scanner as any, "processAudioFile").mockImplementation(
            (...args: unknown[]) =>
                String(args[0]) === badFile
                    ? Promise.reject(new Error("metadata read failed"))
                    : Promise.resolve(),
        );

        const result = await scanner.scanLibrary("/music");

        expect(result).toEqual(
            expect.objectContaining({
                tracksAdded: 2,
                errors: [{ file: badFile, error: "metadata read failed" }],
            }),
        );
        expect((scanner as any).processAudioFile).toHaveBeenCalledTimes(3);
    });

    it("counts a null task rejection as one file error and completes", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Null.flac";
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue([
            audioFile,
        ]);
        mockPrisma.track.findMany.mockResolvedValue([
            identityTrack("track-null", "Artist/Null.flac"),
        ]);
        mockParseFile.mockRejectedValueOnce(null);

        await expect(scanner.scanLibrary("/music")).resolves.toEqual(
            expect.objectContaining({
                tracksAdded: 0,
                tracksUpdated: 0,
                errors: [{ file: audioFile, error: "null" }],
            }),
        );
        expect(mockPrisma.libraryHealthRecord.upsert).toHaveBeenCalledTimes(1);
    });

    it("accounts for a queue admission rejection exactly once", async () => {
        const scanner = new MusicScannerService();
        const audioFile = "/music/Artist/Rejected.flac";
        jest.spyOn(scanner as any, "findAudioFiles").mockResolvedValue([
            audioFile,
        ]);
        queueInstances[0].add.mockRejectedValueOnce(
            new Error("queue admission failed"),
        );

        await expect(scanner.scanLibrary("/music")).resolves.toEqual(
            expect.objectContaining({
                tracksAdded: 0,
                errors: [{ file: audioFile, error: "queue admission failed" }],
            }),
        );
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
                album: {
                    rgMbid: "rg-other",
                    location: "FEDERATED",
                    artistId: "artist-other",
                },
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
            album: {
                rgMbid: "rg-album-1",
                location: "DISCOVER",
                artistId: "artist-1",
            },
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
        expect(mockUpdateArtistCountsInBatches).not.toHaveBeenCalled();
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
            identityTrack("track-1", "Artist/Track.mp3", {
                fileModified: new Date("2026-02-10T00:00:00.000Z"),
            }),
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
        expect(mockParseFile).toHaveBeenCalledWith(audioFile, {
            skipCovers: true,
        });
        expect(mockParseFile).not.toHaveBeenCalledWith(audioFile, {
            duration: true,
            skipCovers: true,
        });
        expect(mockPrisma.systemSettings.updateMany).toHaveBeenCalledWith({
            data: { discNoBackfillDone: true },
        });
    });
});
