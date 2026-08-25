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

        scanner.discoveryDownloadIdentities = undefined;
        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([]);
        mockPrisma.discoveryAlbum.findFirst.mockResolvedValueOnce({
            id: "discovery-by-title",
        });
        await expect(
            scanner.isDiscoveryDownload("Any Artist", "Unique Album"),
        ).resolves.toBe(true);

        scanner.discoveryDownloadIdentities = undefined;
        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([]);
        mockPrisma.discoveryAlbum.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "discovery-by-artist" });
        mockPrisma.album.findFirst.mockResolvedValueOnce(null);
        await expect(
            scanner.isDiscoveryDownload("Discovery Artist", "Other Album"),
        ).resolves.toBe(true);

        scanner.discoveryDownloadIdentities = undefined;
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

    it("propagates discovery matching failures and retries after cache rejection", async () => {
        const scanner = new MusicScannerService() as any;
        mockPrisma.downloadJob.findMany
            .mockRejectedValueOnce(new Error("db down"))
            .mockResolvedValueOnce([]);
        mockPrisma.discoveryAlbum.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        mockPrisma.album.findFirst.mockResolvedValueOnce(null);

        await expect(
            scanner.isDiscoveryDownload("Artist Name", "Album Name"),
        ).rejects.toThrow("db down");
        await expect(
            scanner.isDiscoveryDownload("Artist Name", "Album Name"),
        ).resolves.toBe(false);
        expect(mockPrisma.downloadJob.findMany).toHaveBeenCalledTimes(2);
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

    it("falls back to the album-cover resolver when extractor returns no local art", async () => {
        const scanner = new MusicScannerService(
            undefined,
            "/tmp/covers",
        ) as any;
        mockExtractCoverArt.mockResolvedValueOnce(null);
        mockResolveAlbumCover.mockResolvedValueOnce({
            url: "https://example.com/cover.jpg",
            source: "deezer",
        });

        await scanner.processAudioFile(
            "/music/DiscFallback/Track.flac",
            "DiscFallback/Track.flac",
            "/music",
        );

        expect(mockExtractCoverArt).toHaveBeenCalledWith(
            "/music/DiscFallback/Track.flac",
            "album-new",
        );
        expect(mockResolveAlbumCover).toHaveBeenCalledWith({
            artistName: "DiscFallback",
            albumTitle: "Album Name",
            rgMbid: undefined,
        });
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

        mockPrisma.artist.findFirst.mockResolvedValue(null);
        mockPrisma.artist.findMany.mockResolvedValue([]);
        mockPrisma.artist.findUnique
            .mockResolvedValueOnce(null)
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

        mockPrisma.artist.findFirst.mockResolvedValue(null);
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

    it("updates artist capitalization after an exact normalized-name match", async () => {
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

    it("does not rename an artist resolved by a fuzzy-name match", async () => {
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
                name: "the weekend",
                normalizedName: "the weekend",
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
        expect(mockPrisma.artist.update).not.toHaveBeenCalled();
        expect(mockAreArtistNamesSimilar).toHaveBeenCalledWith(
            "The Weeknd",
            "the weekend",
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
