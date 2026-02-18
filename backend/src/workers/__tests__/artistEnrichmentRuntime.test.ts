describe("artistEnrichment runtime", () => {
    function setupRuntime() {
        jest.resetModules();

        const prisma = {
            artist: {
                update: jest.fn().mockResolvedValue({}),
                findUnique: jest.fn().mockResolvedValue(null),
                findFirst: jest.fn().mockResolvedValue(null),
            },
            album: {
                findMany: jest.fn().mockResolvedValue([]),
                update: jest.fn().mockResolvedValue({}),
            },
            similarArtist: {
                deleteMany: jest.fn().mockResolvedValue({}),
                upsert: jest.fn().mockResolvedValue({}),
            },
        };

        const logger = {
            debug: jest.fn(),
            error: jest.fn(),
        };

        const wikidataService = {
            getArtistInfo: jest.fn().mockResolvedValue(null),
        };
        const lastFmService = {
            getArtistInfo: jest.fn().mockResolvedValue(null),
            getSimilarArtists: jest.fn().mockResolvedValue([]),
        };
        const fanartService = {
            getArtistImage: jest.fn().mockResolvedValue(null),
        };
        const deezerService = {
            getArtistImage: jest.fn().mockResolvedValue(null),
        };
        const musicBrainzService = {
            searchArtist: jest.fn().mockResolvedValue([]),
        };
        const coverArtService = {
            getCoverArt: jest.fn().mockResolvedValue(null),
        };
        const redisClient = {
            setEx: jest.fn().mockResolvedValue(undefined),
        };
        const imageStorage = {
            downloadAndStoreImage: jest.fn().mockResolvedValue(null),
            isNativePath: jest.fn().mockReturnValue(false),
        };

        jest.doMock("../../utils/db", () => ({ prisma }));
        jest.doMock("../../utils/logger", () => ({ logger }));
        jest.doMock("../../services/wikidata", () => ({ wikidataService }));
        jest.doMock("../../services/lastfm", () => ({ lastFmService }));
        jest.doMock("../../services/fanart", () => ({ fanartService }));
        jest.doMock("../../services/deezer", () => ({ deezerService }));
        jest.doMock("../../services/musicbrainz", () => ({ musicBrainzService }));
        jest.doMock("../../services/coverArt", () => ({ coverArtService }));
        jest.doMock("../../utils/redis", () => ({ redisClient }));
        jest.doMock("../../services/imageStorage", () => imageStorage);

        const { enrichSimilarArtist } = require("../artistEnrichment");

        return {
            enrichSimilarArtist: enrichSimilarArtist as (artist: any) => Promise<void>,
            prisma,
            logger,
            wikidataService,
            lastFmService,
            fanartService,
            deezerService,
            musicBrainzService,
            coverArtService,
            redisClient,
            imageStorage,
        };
    }

    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    it("enriches an artist end-to-end with MBID upgrade, similarity links, album covers, and cache writes", async () => {
        const runtime = setupRuntime();

        runtime.musicBrainzService.searchArtist.mockResolvedValueOnce([
            { id: "real-mbid-1" },
        ]);
        runtime.prisma.artist.findUnique.mockImplementation(
            async ({ where }: any) => {
                if (where?.mbid === "real-mbid-1") return null;
                if (where?.mbid === "sim-mbid-1") return { id: "sim-artist-1" };
                return null;
            }
        );
        runtime.prisma.artist.findFirst.mockResolvedValueOnce({
            id: "sim-artist-2",
        });

        runtime.wikidataService.getArtistInfo.mockResolvedValueOnce({
            summary: "Wiki summary",
            heroUrl: "https://wiki/images/artist.jpg",
        });
        runtime.lastFmService.getArtistInfo.mockResolvedValueOnce({
            tags: {
                tag: [{ name: "rock" }, { name: "indie" }],
            },
            image: [{ size: "large", "#text": "https://lastfm/artist.jpg" }],
        });
        runtime.lastFmService.getSimilarArtists.mockResolvedValueOnce([
            { name: "Similar Artist 1", mbid: "sim-mbid-1", match: 0.95 },
            { name: "Similar Artist 2", match: 0.75 },
        ]);

        runtime.imageStorage.isNativePath.mockReturnValue(false);
        runtime.imageStorage.downloadAndStoreImage.mockResolvedValueOnce(
            "/images/artists/a1.jpg"
        );

        runtime.prisma.album.findMany.mockResolvedValueOnce([
            { id: "album-1", rgMbid: "rg-1", title: "Album One" },
            { id: "album-2", rgMbid: null, title: "Album Two" },
        ]);
        runtime.coverArtService.getCoverArt.mockResolvedValueOnce(
            "https://covers/rg-1.jpg"
        );

        const artist = { id: "a1", name: "Artist One", mbid: "temp-123" } as any;
        await runtime.enrichSimilarArtist(artist);

        const updateCalls = runtime.prisma.artist.update.mock.calls.map(
            (call: any[]) => call[0]
        );
        expect(updateCalls).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    where: { id: "a1" },
                    data: { enrichmentStatus: "enriching" },
                }),
                expect.objectContaining({
                    where: { id: "a1" },
                    data: { mbid: "real-mbid-1" },
                }),
            ])
        );

        const completedUpdate = updateCalls.find(
            (entry: any) => entry?.data?.enrichmentStatus === "completed"
        );
        expect(completedUpdate).toBeDefined();
        expect(completedUpdate.data).toEqual(
            expect.objectContaining({
                summary: "Wiki summary",
                heroUrl: "/images/artists/a1.jpg",
                genres: ["rock", "indie"],
                enrichmentStatus: "completed",
            })
        );
        expect(completedUpdate.data.similarArtistsJson).toEqual([
            expect.objectContaining({ name: "Similar Artist 1", mbid: "sim-mbid-1" }),
            expect.objectContaining({ name: "Similar Artist 2", mbid: null }),
        ]);

        expect(runtime.prisma.similarArtist.deleteMany).toHaveBeenCalledWith({
            where: { fromArtistId: "a1" },
        });
        expect(runtime.prisma.similarArtist.upsert).toHaveBeenCalledTimes(2);
        expect(runtime.coverArtService.getCoverArt).toHaveBeenCalledWith("rg-1");
        expect(runtime.prisma.album.update).toHaveBeenCalledWith({
            where: { id: "album-1" },
            data: { coverUrl: "https://covers/rg-1.jpg" },
        });
        expect(runtime.redisClient.setEx).toHaveBeenCalledWith(
            "hero:a1",
            7 * 24 * 60 * 60,
            "/images/artists/a1.jpg"
        );
    });

    it("uses a native hero path without attempting local download", async () => {
        const runtime = setupRuntime();

        runtime.wikidataService.getArtistInfo.mockResolvedValueOnce({
            summary: "Native hero from wikidata",
            heroUrl: "/assets/artist/native-cover.jpg",
        });
        runtime.lastFmService.getArtistInfo.mockResolvedValueOnce({
            tags: { tag: [{ name: "ambient" }] },
        });
        runtime.imageStorage.isNativePath.mockReturnValueOnce(true);

        const artist = {
            id: "a8",
            name: "Native Hero Artist",
            mbid: "real-native-mbid",
        } as any;
        await runtime.enrichSimilarArtist(artist);

        expect(runtime.imageStorage.isNativePath).toHaveBeenCalledWith(
            "/assets/artist/native-cover.jpg"
        );
        expect(runtime.imageStorage.downloadAndStoreImage).not.toHaveBeenCalled();

        const completed = runtime.prisma.artist.update.mock.calls
            .map((call: any[]) => call[0] as any)
            .find((call) => call?.data?.enrichmentStatus === "completed");
        expect(completed).toBeDefined();
        expect(completed.data).toEqual(
            expect.objectContaining({
                summary: "Native hero from wikidata",
                heroUrl: "/assets/artist/native-cover.jpg",
                genres: ["ambient"],
                enrichmentStatus: "completed",
            })
        );
        expect(runtime.redisClient.setEx).toHaveBeenCalledWith(
            "hero:a8",
            7 * 24 * 60 * 60,
            "/assets/artist/native-cover.jpg"
        );
    });

    it("continues when MBID update races with a unique conflict", async () => {
        const runtime = setupRuntime();

        runtime.musicBrainzService.searchArtist.mockResolvedValueOnce([
            { id: "real-mbid-2" },
        ]);
        runtime.prisma.artist.findUnique.mockResolvedValueOnce(null);
        runtime.prisma.artist.update.mockImplementation(async ({ data }: any) => {
            if (data?.mbid === "real-mbid-2") {
                const error: any = new Error("Unique constraint failed on `mbid`");
                error.code = "P2002";
                throw error;
            }
            return {};
        });

        const artist = { id: "a2", name: "Artist Two", mbid: "temp-456" } as any;
        await expect(runtime.enrichSimilarArtist(artist)).resolves.toBeUndefined();

        const completedCall = runtime.prisma.artist.update.mock.calls.find(
            (call: any[]) => call?.[0]?.data?.enrichmentStatus === "completed"
        );
        expect(completedCall).toBeDefined();
    });

    it("skips similar-artist persistence when local lookup does not resolve a match", async () => {
        const runtime = setupRuntime();

        runtime.lastFmService.getArtistInfo.mockResolvedValueOnce({
            bio: { summary: "Bio summary for missing similar artist" },
            tags: { tag: [{ name: "electronic" }] },
        });
        runtime.lastFmService.getSimilarArtists.mockResolvedValueOnce([
            {
                name: "Ghost Artist",
                mbid: "ghost-mbid",
                match: 0.83,
            },
        ]);
        runtime.prisma.artist.findUnique.mockResolvedValue(null);
        runtime.prisma.artist.findFirst.mockResolvedValue(null);

        const artist = {
            id: "a9",
            name: "Missing Similar Match",
            mbid: "real-missing-mbid",
        } as any;
        await runtime.enrichSimilarArtist(artist);

        expect(runtime.prisma.similarArtist.deleteMany).toHaveBeenCalledWith({
            where: { fromArtistId: "a9" },
        });
        expect(runtime.prisma.similarArtist.upsert).not.toHaveBeenCalled();

        const completed = runtime.prisma.artist.update.mock.calls
            .map((call: any[]) => call[0] as any)
            .find((call) => call?.data?.enrichmentStatus === "completed");
        expect(completed).toBeDefined();
        expect(completed.data.similarArtistsJson).toEqual([
            expect.objectContaining({
                name: "Ghost Artist",
                mbid: "ghost-mbid",
                match: 0.83,
            }),
        ]);
    });

    it("falls back to Last.fm summary and Deezer image when earlier sources miss", async () => {
        const runtime = setupRuntime();

        runtime.wikidataService.getArtistInfo.mockResolvedValueOnce(null);
        runtime.lastFmService.getArtistInfo.mockResolvedValueOnce({
            bio: { summary: "Last.fm summary" },
            tags: { tag: [{ name: "electronic" }] },
            image: [
                {
                    size: "extralarge",
                    "#text":
                        "https://lastfm/2a96cbd8b46e442fc41c2b86b821562f-placeholder.jpg",
                },
            ],
        });
        runtime.fanartService.getArtistImage.mockResolvedValueOnce(null);
        runtime.deezerService.getArtistImage.mockResolvedValueOnce(
            "https://deezer/images/artist.jpg"
        );
        runtime.imageStorage.isNativePath.mockReturnValue(false);
        runtime.imageStorage.downloadAndStoreImage.mockResolvedValueOnce(null);

        const artist = {
            id: "a3",
            name: "Artist Three",
            mbid: "real-artist-mbid",
        } as any;
        await runtime.enrichSimilarArtist(artist);

        expect(runtime.fanartService.getArtistImage).toHaveBeenCalledWith(
            "real-artist-mbid"
        );
        expect(runtime.deezerService.getArtistImage).toHaveBeenCalledWith(
            "Artist Three"
        );
        expect(runtime.imageStorage.downloadAndStoreImage).toHaveBeenCalledWith(
            "https://deezer/images/artist.jpg",
            "a3",
            "artist"
        );

        const completedCall = runtime.prisma.artist.update.mock.calls
            .map((c: any[]) => c[0])
            .find((entry: any) => entry?.data?.enrichmentStatus === "completed");
        expect(completedCall.data).toEqual(
            expect.objectContaining({
                summary: "Last.fm summary",
                heroUrl: "https://deezer/images/artist.jpg",
                genres: ["electronic"],
            })
        );
    });

    it("skips MBID overwrite when a resolved MBID is already owned by another artist", async () => {
        const runtime = setupRuntime();

        runtime.musicBrainzService.searchArtist.mockResolvedValueOnce([
            { id: "already-taken-mbid" },
        ]);
        runtime.prisma.artist.findUnique.mockImplementation(async ({ where }: any) => {
            if (where?.mbid === "already-taken-mbid") {
                return { id: "other-artist-id" };
            }
            return null;
        });

        const artist = {
            id: "a5",
            name: "Shared Mbid Artist",
            mbid: "temp-shared",
        } as any;
        await runtime.enrichSimilarArtist(artist);

        expect(runtime.prisma.artist.update).toHaveBeenCalledWith({
            where: { id: "a5" },
            data: { enrichmentStatus: "enriching" },
        });

        expect(runtime.prisma.artist.update).not.toHaveBeenCalledWith({
            where: { id: "a5" },
            data: { mbid: "already-taken-mbid" },
        });

        const completed = runtime.prisma.artist.update.mock.calls
            .map((call: any[]) => call[0] as any)
            .find((call) => call?.data?.enrichmentStatus === "completed");
        expect(completed).toBeDefined();
        expect(completed.data.summary).toBe(null);
        expect(completed.data.heroUrl).toBe(null);

        expect(runtime.lastFmService.getArtistInfo).toHaveBeenCalledWith(
            "Shared Mbid Artist",
            "already-taken-mbid"
        );
    });

    it("continues when Last.fm similar artist lookup fails", async () => {
        const runtime = setupRuntime();

        runtime.lastFmService.getArtistInfo.mockResolvedValueOnce({
            bio: { summary: "Artist bio summary" },
            image: [{ size: "extralarge", "#text": "https://lastfm/artist.jpg" }],
            tags: { tag: [{ name: "rock" }, { name: "metal" }] },
        });
        runtime.lastFmService.getSimilarArtists.mockRejectedValueOnce(
            new Error("similar lookup failed")
        );

        const artist = {
            id: "a6",
            name: "Similar Fail Artist",
            mbid: "real-similar-mbid",
        } as any;
        await runtime.enrichSimilarArtist(artist);

        const completed = runtime.prisma.artist.update.mock.calls
            .map((call: any[]) => call[0] as any)
            .find((call) => call?.data?.enrichmentStatus === "completed");
        expect(completed).toBeDefined();
        expect(completed.data.summary).toBe("Artist bio summary");
        expect(completed.data.similarArtistsJson).toBeNull();
        expect(runtime.prisma.similarArtist.deleteMany).not.toHaveBeenCalled();
        expect(runtime.prisma.similarArtist.upsert).not.toHaveBeenCalled();
    });

    it("continues when album cover lookup fails for an owned album", async () => {
        const runtime = setupRuntime();

        runtime.lastFmService.getArtistInfo.mockResolvedValueOnce({
            bio: { summary: "Bio summary with genres" },
            image: [{ size: "extralarge", "#text": "https://lastfm/artist.jpg" }],
            tags: { tag: [{ name: "rock" }] },
        });
        runtime.prisma.album.findMany.mockResolvedValueOnce([
            {
                id: "owned-album-1",
                rgMbid: "rg-cover-miss",
                title: "Missing cover",
            },
        ]);
        runtime.coverArtService.getCoverArt.mockRejectedValueOnce(
            new Error("cover lookup failed")
        );

        const artist = {
            id: "a7",
            name: "Album Cover Miss",
            mbid: "real-album-cover-mbid",
        } as any;
        await runtime.enrichSimilarArtist(artist);

        expect(runtime.coverArtService.getCoverArt).toHaveBeenCalledWith("rg-cover-miss");
        expect(runtime.prisma.album.update).not.toHaveBeenCalled();
        const completed = runtime.prisma.artist.update.mock.calls
            .map((call: any[]) => call[0] as any)
            .find((call) => call?.data?.enrichmentStatus === "completed");
        expect(completed).toBeDefined();
        expect(completed.data.summary).toBe("Bio summary with genres");
        expect(completed.data.genres).toEqual(["rock"]);
    });

    it("continues when hero cache write fails after successful enrichment", async () => {
        const runtime = setupRuntime();

        runtime.wikidataService.getArtistInfo.mockResolvedValueOnce({
            summary: "Cache resilient summary",
            heroUrl: "https://images.example.com/artist-hero.jpg",
        });
        runtime.lastFmService.getArtistInfo.mockResolvedValueOnce(null);
        runtime.imageStorage.isNativePath.mockReturnValue(false);
        runtime.imageStorage.downloadAndStoreImage.mockResolvedValueOnce(
            "/images/artists/a10.jpg"
        );
        runtime.redisClient.setEx.mockRejectedValueOnce(
            new Error("redis unavailable")
        );

        const artist = {
            id: "a10",
            name: "Cache Fail Artist",
            mbid: "real-cache-fail",
        } as any;
        await runtime.enrichSimilarArtist(artist);

        const completed = runtime.prisma.artist.update.mock.calls
            .map((call: any[]) => call[0] as any)
            .find((call) => call?.data?.enrichmentStatus === "completed");
        expect(completed).toBeDefined();
        expect(completed.data.summary).toBe("Cache resilient summary");
        expect(completed.data.heroUrl).toBe("/images/artists/a10.jpg");
        expect(runtime.redisClient.setEx).toHaveBeenCalledWith(
            "hero:a10",
            7 * 24 * 60 * 60,
            "/images/artists/a10.jpg"
        );
    });

    it("marks enrichment failed and rethrows when completion write fails", async () => {
        const runtime = setupRuntime();

        runtime.prisma.artist.update.mockImplementation(async ({ data }: any) => {
            if (data?.enrichmentStatus === "completed") {
                throw new Error("final write failed");
            }
            return {};
        });

        const artist = { id: "a4", name: "Artist Four", mbid: "real-4" } as any;

        await expect(runtime.enrichSimilarArtist(artist)).rejects.toThrow(
            "final write failed"
        );

        expect(runtime.prisma.artist.update).toHaveBeenCalledWith({
            where: { id: "a4" },
            data: { enrichmentStatus: "failed" },
        });
        expect(runtime.logger.error).toHaveBeenCalledWith(
            "[ENRICH Artist Four] ENRICHMENT FAILED:",
            "final write failed"
        );
    });
});
