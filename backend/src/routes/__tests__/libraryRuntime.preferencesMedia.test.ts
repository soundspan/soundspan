import {
    express,
    Request,
    fs,
    request,
    mockStreamGetStreamFilePath,
    mockStreamWithRangeSupport,
    mockStreamDestroy,
    mockParseFile,
    mockLookup,
    mockProxyFederatedTrackStream,
    mockProxyFederatedCover,
    mockLoadPeerPlaybackFallback,
    mockServeMappedProviderStream,
    mockTerminateCommittedStream,
    mockGetYtMusicUserIdOrPublic,
    mockBumpSearchCacheVersion,
    mockResolveArtistImage,
    mockPersistCatalogReleaseGroups,
    mockLidarrDeleteArtist,
    router,
    flattenLibraryRouteLayers,
    errorHandler,
    config,
    prisma,
    redisClient,
    scanQueue,
    organizeSingles,
    logger,
    AudioStreamingService,
    coverArtService,
    fetchExternalImage,
    normalizeExternalImageUrl,
    downloadAndStoreImage,
    extractColorsFromImage,
    getSystemSettings,
    dataCacheService,
    lastFmService,
    deezerService,
    imageProviderService,
    musicBrainzService,
    nativeCoverHealInFlight,
    getMergedGenres,
    isBackfillNeeded,
    getBackfillProgress,
    isBackfillInProgress,
    backfillAllArtistCounts,
    isImageBackfillNeeded,
    getImageBackfillProgress,
    backfillAllImages,
    getDecadeFromYear,
    getDecadeWhereClause,
    getEffectiveYear,
    shuffleArray,
    mockTrackFindUnique,
    mockTrackFindMany,
    mockTrackCount,
    mockTrackDelete,
    mockTrackDeleteMany,
    mockLikedTrackFindUnique,
    mockLikedTrackFindMany,
    mockLikedTrackCount,
    mockLikedTrackUpsert,
    mockLikedTrackCreateMany,
    mockLikedTrackDeleteMany,
    mockDislikedEntityFindUnique,
    mockDislikedEntityFindMany,
    mockDislikedEntityUpsert,
    mockDislikedEntityCreateMany,
    mockDislikedEntityDeleteMany,
    mockRemoteLikedTrackFindMany,
    mockRemoteLikedTrackCount,
    mockRedisGet,
    mockRedisSetEx,
    mockPlayFindFirst,
    mockPlayCreate,
    mockPlayFindMany,
    mockPlayGroupBy,
    mockTrackMappingFindMany,
    mockFederationPeerFindUnique,
    mockUserSettingsFindUnique,
    mockArtistFindMany,
    mockArtistFindUnique,
    mockArtistFindFirst,
    mockArtistCount,
    mockArtistUpdateMany,
    mockArtistUpdate,
    mockArtistDeleteMany,
    mockArtistDelete,
    mockAlbumFindMany,
    mockAlbumGroupBy,
    mockAlbumCount,
    mockAlbumFindFirst,
    mockAlbumFindUnique,
    mockAlbumDelete,
    mockAlbumUpdate,
    mockAlbumUpdateMany,
    mockAudiobookProgressFindMany,
    mockPodcastProgressFindMany,
    mockOwnedAlbumGroupBy,
    mockOwnedAlbumFindMany,
    mockOwnedAlbumFindUnique,
    mockOwnedAlbumDeleteMany,
    mockGenreFindMany,
    mockSimilarArtistFindMany,
    mockSimilarArtistDeleteMany,
    mockPrismaTransaction,
    mockPrismaQueryRaw,
    mockPrismaExecuteRaw,
    mockScanQueueAdd,
    mockScanQueueGetJob,
    mockScanQueueGetJobs,
    mockScanQueueClientSet,
    mockScanQueueClientEval,
    mockOrganizeSingles,
    mockLoggerInfo,
    mockLoggerError,
    mockLoggerWarn,
    mockLoggerDebug,
    mockAudioStreamingCtor,
    mockCoverArtGetCoverArt,
    mockCoverArtClearNotFoundCache,
    mockFetchExternalImage,
    mockNormalizeExternalImageUrl,
    mockDownloadAndStoreImage,
    mockExtractColorsFromImage,
    mockGetSystemSettings,
    mockGetArtistImagesBatch,
    mockGetArtistImage,
    mockLastFmGetArtistTopTracks,
    mockLastFmGetSimilarArtists,
    mockImageProviderGetAlbumCover,
    mockMusicBrainzSearchArtist,
    mockMusicBrainzGetReleaseGroups,
    mockIsBackfillNeeded,
    mockGetBackfillProgress,
    mockIsBackfillInProgress,
    mockBackfillAllArtistCounts,
    mockIsImageBackfillNeeded,
    mockGetImageBackfillProgress,
    mockBackfillAllImages,
    mockGetDecadeFromYear,
    mockGetDecadeWhereClause,
    mockGetEffectiveYear,
    mockShuffleArray,
    mockGetMergedGenres,
    mockDeezerGetAlbumCover,
    getHandler,
    getFinalHandler,
    createRes,
    flushPromises,
    invokeWithErrorHandler,
    createNativeTrack,
    createRadioTrack,
    visibleAlbumRelationWhere,
    expectBoundedRandomQuery,
    expectNoUnboundedIdPoolFetch,
} from "./libraryRuntime.helpers";

describe("library catalog list runtime coverage", () => {
    const recentlyListenedHandler = getHandler("get", "/recently-listened");
    const recentlyAddedHandler = getHandler("get", "/recently-added");
    const artistsHandler = getHandler("get", "/artists");
    const artistByIdHandler = getHandler("get", "/artists/:id");
    const albumsHandler = getHandler("get", "/albums");
    const albumByIdHandler = getHandler("get", "/albums/:id");
    const tracksHandler = getHandler("get", "/tracks");
    const likedPlaylistHandler = getHandler("get", "/liked");
    const shuffleHandler = getHandler("get", "/tracks/shuffle");
    const coverArtHandler = getFinalHandler("get", "/cover-art{/:id}");
    const albumCoverHandler = getFinalHandler("get", "/album-cover/:mbid");
    const coverArtColorsHandler = getFinalHandler("get", "/cover-art-colors");
    const trackPreferenceHandler = getHandler("get", "/tracks/:id/preference");
    const setTrackPreferenceHandler = getHandler(
        "post",
        "/tracks/:id/preference",
    );
    const setAlbumPreferenceHandler = getHandler(
        "post",
        "/albums/:id/preference",
    );
    const trackByIdHandler = getHandler("get", "/tracks/:id");
    const audioInfoHandler = getHandler("get", "/tracks/:id/audio-info", 1);
    const deleteTrackHandler = getHandler("delete", "/tracks/:id", 1);
    const deleteAlbumHandler = getHandler("delete", "/albums/:id", 1);
    const deleteArtistHandler = getHandler("delete", "/artists/:id", 1);
    const genresHandler = getHandler("get", "/genres");
    const decadesHandler = getHandler("get", "/decades");
    const radioHandler = getHandler("get", "/radio");

    beforeEach(() => {
        jest.clearAllMocks();
        nativeCoverHealInFlight.clear();
        mockLookup.mockReset();
        mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
        mockTrackFindUnique.mockReset();
        mockTrackFindMany.mockReset();
        mockTrackCount.mockReset();
        mockPlayFindFirst.mockReset();
        mockPlayFindMany.mockReset();
        mockPlayGroupBy.mockReset();
        mockPlayCreate.mockReset();
        mockLikedTrackFindUnique.mockReset();
        mockLikedTrackFindMany.mockReset();
        mockLikedTrackCount.mockReset();
        mockLikedTrackUpsert.mockReset();
        mockLikedTrackCreateMany.mockReset();
        mockLikedTrackDeleteMany.mockReset();
        mockDislikedEntityFindUnique.mockReset();
        mockDislikedEntityFindMany.mockReset();
        mockDislikedEntityUpsert.mockReset();
        mockDislikedEntityCreateMany.mockReset();
        mockDislikedEntityDeleteMany.mockReset();
        mockRemoteLikedTrackFindMany.mockReset();
        mockRemoteLikedTrackCount.mockReset();
        mockTrackMappingFindMany.mockReset();
        mockAlbumFindMany.mockReset();
        mockAlbumGroupBy.mockReset();
        mockAlbumCount.mockReset();
        mockAlbumFindFirst.mockReset();
        mockAlbumFindUnique.mockReset();
        mockAlbumDelete.mockReset();
        mockAlbumUpdate.mockReset();
        mockAlbumUpdateMany.mockReset();
        mockPersistCatalogReleaseGroups.mockReset();
        mockPersistCatalogReleaseGroups.mockResolvedValue(undefined);
        mockOwnedAlbumGroupBy.mockReset();
        mockOwnedAlbumFindMany.mockReset();
        mockOwnedAlbumFindUnique.mockReset();
        mockOwnedAlbumDeleteMany.mockReset();
        mockArtistFindMany.mockReset();
        mockArtistFindUnique.mockReset();
        mockArtistFindFirst.mockReset();
        mockArtistCount.mockReset();
        mockArtistUpdateMany.mockReset();
        mockArtistUpdate.mockReset();
        mockArtistDeleteMany.mockReset();
        mockArtistDelete.mockReset();
        mockGenreFindMany.mockReset();
        mockSimilarArtistFindMany.mockReset();
        mockSimilarArtistDeleteMany.mockReset();
        mockPrismaTransaction.mockReset();
        mockPrismaQueryRaw.mockReset();
        mockUserSettingsFindUnique.mockReset();
        mockStreamGetStreamFilePath.mockReset();
        mockStreamWithRangeSupport.mockReset();
        mockStreamDestroy.mockReset();
        mockParseFile.mockReset();
        mockAudioStreamingCtor.mockImplementation(
            () =>
                ({
                    getStreamFilePath: mockStreamGetStreamFilePath,
                    streamFileWithRangeSupport: mockStreamWithRangeSupport,
                    destroy: mockStreamDestroy,
                }) as any,
        );
        mockPlayFindMany.mockResolvedValue([]);
        mockAudiobookProgressFindMany.mockResolvedValue([]);
        mockPodcastProgressFindMany.mockResolvedValue([]);
        mockOwnedAlbumGroupBy.mockResolvedValue([]);
        mockAlbumFindMany.mockResolvedValue([]);
        mockAlbumGroupBy.mockResolvedValue([]);
        mockAlbumCount.mockResolvedValue(0);
        mockAlbumFindFirst.mockResolvedValue(null);
        mockOwnedAlbumFindMany.mockResolvedValue([]);
        mockOwnedAlbumFindUnique.mockResolvedValue(null);
        mockOwnedAlbumDeleteMany.mockResolvedValue({ count: 0 });
        mockGenreFindMany.mockResolvedValue([]);
        mockSimilarArtistFindMany.mockResolvedValue([]);
        mockTrackFindMany.mockResolvedValue([]);
        mockTrackFindUnique.mockResolvedValue(null);
        mockTrackCount.mockResolvedValue(0);
        mockTrackDelete.mockImplementation(async ({ where }) => ({
            id: where.id,
            albumId: "album-1",
        }));
        mockTrackDeleteMany.mockResolvedValue({ count: 0 });
        mockLikedTrackFindUnique.mockResolvedValue(null);
        mockLikedTrackFindMany.mockResolvedValue([]);
        mockLikedTrackCount.mockResolvedValue(0);
        mockLikedTrackUpsert.mockResolvedValue({
            userId: "user-1",
            trackId: "track-1",
        });
        mockLikedTrackCreateMany.mockResolvedValue({ count: 0 });
        mockLikedTrackDeleteMany.mockResolvedValue({ count: 0 });
        mockDislikedEntityFindUnique.mockResolvedValue(null);
        mockDislikedEntityFindMany.mockResolvedValue([]);
        mockDislikedEntityUpsert.mockResolvedValue({ id: "disliked-1" });
        mockDislikedEntityCreateMany.mockResolvedValue({ count: 0 });
        mockDislikedEntityDeleteMany.mockResolvedValue({ count: 0 });
        mockRemoteLikedTrackFindMany.mockResolvedValue([]);
        mockRemoteLikedTrackCount.mockResolvedValue(0);
        mockTrackMappingFindMany.mockResolvedValue([]);
        mockDownloadAndStoreImage.mockResolvedValue(
            "native:albums/library-runtime-default-cover.jpg",
        );
        mockPlayGroupBy.mockResolvedValue([]);
        mockPlayFindFirst.mockResolvedValue(null);
        mockPlayCreate.mockResolvedValue({});
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue("OK");
        mockPrismaQueryRaw.mockResolvedValue([]);
        mockPrismaExecuteRaw.mockResolvedValue(0);
        // The transactional client mirrors the full prisma mock so services
        // that run model operations inside $transaction (track deletion with
        // album-loudness recompute, artist backfills) see the same stubs.
        mockPrismaTransaction.mockImplementation(async (callback: any) =>
            callback(prisma),
        );
        mockGetArtistImagesBatch.mockResolvedValue(new Map());
        mockGetArtistImage.mockResolvedValue(null);
        mockLastFmGetArtistTopTracks.mockResolvedValue([]);
        mockLastFmGetSimilarArtists.mockResolvedValue([]);
        mockResolveArtistImage.mockResolvedValue(null);
        mockImageProviderGetAlbumCover.mockResolvedValue(null);
        mockMusicBrainzSearchArtist.mockResolvedValue([]);
        mockMusicBrainzGetReleaseGroups.mockResolvedValue([]);
        mockArtistFindMany.mockResolvedValue([]);
        mockArtistFindUnique.mockResolvedValue(null);
        mockArtistFindFirst.mockResolvedValue(null);
        mockArtistCount.mockResolvedValue(1);
        mockArtistUpdate.mockResolvedValue(undefined);
        mockArtistDeleteMany.mockResolvedValue({ count: 0 });
        mockArtistDelete.mockResolvedValue(undefined);
        mockAlbumFindUnique.mockResolvedValue(null);
        mockAlbumDelete.mockResolvedValue(undefined);
        mockAlbumUpdate.mockResolvedValue(undefined);
        mockAlbumUpdateMany.mockResolvedValue({ count: 1 });
        mockSimilarArtistDeleteMany.mockResolvedValue({ count: 0 });
        mockUserSettingsFindUnique.mockResolvedValue({
            playbackQuality: "medium",
        });
        mockStreamGetStreamFilePath.mockResolvedValue({
            filePath: "/tmp/stream.flac",
            mimeType: "audio/flac",
        });
        mockStreamWithRangeSupport.mockResolvedValue(undefined);
        mockStreamDestroy.mockImplementation(() => undefined);
        mockCoverArtGetCoverArt.mockResolvedValue(null);
        mockNormalizeExternalImageUrl.mockImplementation((url: string) => url);
        mockFetchExternalImage.mockResolvedValue({
            ok: true,
            url: "https://images.example/cover.jpg",
            buffer: Buffer.from("cover"),
            etag: "etag-1",
            contentType: "image/jpeg",
        });
        mockExtractColorsFromImage.mockResolvedValue({
            vibrant: "#111111",
            darkVibrant: "#222222",
            lightVibrant: "#333333",
            muted: "#444444",
            darkMuted: "#555555",
            lightMuted: "#666666",
        });
        mockParseFile.mockResolvedValue({
            format: {
                codec: "flac",
                bitrate: 960000,
                sampleRate: 48000,
                bitsPerSample: 24,
                lossless: true,
                numberOfChannels: 2,
            },
        });
        mockShuffleArray.mockImplementation((arr: unknown[]) => arr);
        mockGetEffectiveYear.mockImplementation(
            (album: any) =>
                album.displayYear ?? album.originalYear ?? album.year ?? null,
        );
        mockGetDecadeWhereClause.mockImplementation((decadeStart: number) => ({
            OR: [
                { displayYear: { gte: decadeStart, lt: decadeStart + 10 } },
                {
                    displayYear: null,
                    originalYear: { gte: decadeStart, lt: decadeStart + 10 },
                },
                {
                    displayYear: null,
                    originalYear: null,
                    year: { gte: decadeStart, lt: decadeStart + 10 },
                },
            ],
        }));
        mockGetDecadeFromYear.mockImplementation(
            (year: number) => Math.floor(year / 10) * 10,
        );
        mockGetMergedGenres.mockReturnValue([]);
    });

    it("returns an empty result for an empty library", async () => {
        mockTrackCount.mockResolvedValueOnce(0);
        const emptyReq = { query: { limit: "3" } } as any;
        const emptyRes = createRes();
        await shuffleHandler(emptyReq, emptyRes);
        expect(emptyRes.statusCode).toBe(200);
        expect(emptyRes.body).toEqual({ tracks: [], total: 0 });
    });

    it("does not count removed rows when choosing a shuffle strategy", async () => {
        mockTrackCount.mockImplementationOnce(
            async ({ where }: { where?: { removedAt?: null } } = {}) =>
                where?.removedAt === null ? 0 : 1,
        );
        const res = createRes();

        await shuffleHandler({ query: { limit: "3" } } as any, res);

        expect(res.body).toEqual({ tracks: [], total: 0 });
        expect(mockTrackFindMany).not.toHaveBeenCalled();
    });

    it("shuffles small libraries fully in memory", async () => {
        mockTrackCount.mockResolvedValueOnce(2);
        mockTrackFindMany.mockResolvedValueOnce([
            {
                id: "track-1",
                title: "Track 1",
                album: { id: "album-1", title: "A1", coverUrl: "c1.jpg" },
            },
            {
                id: "track-2",
                title: "Track 2",
                album: { id: "album-2", title: "A2", coverUrl: "c2.jpg" },
            },
        ]);
        const smallReq = { query: { limit: "5" } } as any;
        const smallRes = createRes();
        await shuffleHandler(smallReq, smallRes);
        expect(mockShuffleArray).toHaveBeenCalled();
        expect(smallRes.statusCode).toBe(200);
        expect(smallRes.body.total).toBe(2);
        expect(smallRes.body.tracks[0].album.coverArt).toBe("c1.jpg");
    });

    it("routes the totalTracks === limit boundary to the small-library in-memory branch", async () => {
        // Guards the `totalTracks <= limit` comparison: at exact equality the
        // handler must fetch-all + shuffle in memory, never pivot-sample (a
        // future `<=` -> `<` typo would silently flip this to the large path).
        const five = Array.from({ length: 5 }, (_, i) => ({
            id: `track-${i + 1}`,
            title: `Track ${i + 1}`,
            album: {
                id: `album-${i + 1}`,
                title: `A${i + 1}`,
                coverUrl: `c${i + 1}.jpg`,
            },
        }));
        mockTrackCount.mockResolvedValueOnce(5);
        mockTrackFindMany.mockResolvedValueOnce(five);
        const req = { query: { limit: "5" } } as any;
        const res = createRes();

        await shuffleHandler(req, res);

        // Exactly one findMany — the fetch-all call, which carries no pivot
        // filter (the sampling query would pass `where: { random: ... }`).
        expect(mockTrackFindMany).toHaveBeenCalledTimes(1);
        expect(mockTrackFindMany.mock.calls[0][0].where).toEqual(
            expect.objectContaining({
                removedAt: null,
                AND: expect.any(Array),
            }),
        );
        expect(mockShuffleArray).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body.total).toBe(5);
        expect(res.body.tracks).toHaveLength(5);
    });

    it("samples large libraries via the indexed random-pivot query and returns exactly `limit` tracks when the pivot page is full", async () => {
        mockTrackCount.mockResolvedValueOnce(10);
        mockTrackFindMany
            // Pivot-sample query (id-only): full page, no top-up needed.
            .mockResolvedValueOnce([{ id: "track-9" }, { id: "track-8" }])
            // Hydrate the sampled ids into full track rows.
            .mockResolvedValueOnce([
                {
                    id: "track-9",
                    title: "Track 9",
                    album: { id: "album-9", title: "A9", coverUrl: "c9.jpg" },
                },
                {
                    id: "track-8",
                    title: "Track 8",
                    album: { id: "album-8", title: "A8", coverUrl: "c8.jpg" },
                },
            ]);
        const largeReq = { query: { limit: "2" } } as any;
        const largeRes = createRes();

        await shuffleHandler(largeReq, largeRes);

        // Pure Prisma now — no raw SQL site left in this handler.
        expect(mockPrismaQueryRaw).not.toHaveBeenCalled();
        expect(mockTrackFindMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                where: {
                    removedAt: null,
                    ...visibleAlbumRelationWhere,
                    AND: expect.any(Array),
                    random: { gte: expect.any(Number) },
                },
                orderBy: { random: "asc" },
                take: 2,
                select: { id: true },
            }),
        );
        // The pivot page already had `limit` rows, so no wrap-around top-up
        // query fired — exactly 2 findMany calls total (sample + hydrate).
        expect(mockTrackFindMany).toHaveBeenCalledTimes(2);
        expect(mockTrackFindMany).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                where: {
                    removedAt: null,
                    ...visibleAlbumRelationWhere,
                    AND: expect.any(Array),
                    id: { in: ["track-9", "track-8"] },
                },
            }),
        );
        expect(largeRes.statusCode).toBe(200);
        expect(largeRes.body.total).toBe(10);
        expect(largeRes.body.tracks).toHaveLength(2);
        expect(largeRes.body.tracks.map((t: any) => t.id).sort()).toEqual([
            "track-8",
            "track-9",
        ]);
    });

    it("tops up with a wrap-around query when the pivot page is short, and still returns exactly `limit` distinct tracks", async () => {
        mockTrackCount.mockResolvedValueOnce(500);
        mockTrackFindMany
            // Pivot lands near 1.0: only 1 of the requested 3 rows sort at/above it.
            .mockResolvedValueOnce([{ id: "track-1" }])
            // Top-up wraps to the start of the random range for the other 2.
            .mockResolvedValueOnce([{ id: "track-2" }, { id: "track-3" }])
            // Hydrate all 3 sampled ids into full track rows.
            .mockResolvedValueOnce([
                {
                    id: "track-1",
                    title: "T1",
                    album: { id: "a1", title: "A1", coverUrl: "c1.jpg" },
                },
                {
                    id: "track-2",
                    title: "T2",
                    album: { id: "a2", title: "A2", coverUrl: "c2.jpg" },
                },
                {
                    id: "track-3",
                    title: "T3",
                    album: { id: "a3", title: "A3", coverUrl: "c3.jpg" },
                },
            ]);
        const req = { query: { limit: "3" } } as any;
        const res = createRes();

        await shuffleHandler(req, res);

        expect(mockTrackFindMany).toHaveBeenCalledTimes(3);
        expect(mockTrackFindMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                where: {
                    removedAt: null,
                    ...visibleAlbumRelationWhere,
                    AND: expect.any(Array),
                    random: { gte: expect.any(Number) },
                },
                orderBy: { random: "asc" },
                take: 3,
                select: { id: true },
            }),
        );
        // Top-up asks for exactly the shortfall (3 requested - 1 already found).
        expect(mockTrackFindMany).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                where: {
                    removedAt: null,
                    ...visibleAlbumRelationWhere,
                    AND: expect.any(Array),
                    random: { lt: expect.any(Number) },
                },
                orderBy: { random: "asc" },
                take: 2,
                select: { id: true },
            }),
        );
        const hydrateArgs = mockTrackFindMany.mock.calls[2][0];
        const hydratedIds = hydrateArgs.where.id.in as string[];
        expect([...hydratedIds].sort()).toEqual([
            "track-1",
            "track-2",
            "track-3",
        ]);
        expect(new Set(hydratedIds).size).toBe(3);

        expect(res.statusCode).toBe(200);
        expect(res.body.tracks).toHaveLength(3);
        const returnedIds = res.body.tracks.map((t: any) => t.id);
        expect(new Set(returnedIds).size).toBe(3);
    });

    it("returns 500 when the shuffle handler errors", async () => {
        mockTrackCount.mockRejectedValueOnce(new Error("shuffle failed"));
        const errReq = { query: {} } as any;
        const errRes = createRes();
        await invokeWithErrorHandler(shuffleHandler, errReq, errRes);
        expect(errRes.statusCode).toBe(500);
    });

    it("formats single track responses and handles not-found/errors", async () => {
        mockTrackFindUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "track-1",
                title: "Track 1",
                duration: 201,
                loudnessLufs: -19.2,
                truePeakDb: -2.4,
                album: {
                    id: "album-1",
                    title: "Album 1",
                    coverUrl: "cover-1.jpg",
                    albumLoudnessLufs: -18.6,
                    albumTruePeakDb: -1.8,
                    artist: { id: "artist-1", name: "Artist 1" },
                },
            })
            .mockRejectedValueOnce(new Error("track read failed"));

        const missingReq = { params: { id: "missing-track" } } as any;
        const missingRes = createRes();
        await trackByIdHandler(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);

        const okReq = { params: { id: "track-1" } } as any;
        const okRes = createRes();
        await trackByIdHandler(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual({
            id: "track-1",
            title: "Track 1",
            loudnessLufs: -19.2,
            truePeakDb: -2.4,
            artist: { name: "Artist 1", id: "artist-1" },
            album: {
                title: "Album 1",
                coverArt: "cover-1.jpg",
                id: "album-1",
                albumLoudnessLufs: -18.6,
                albumTruePeakDb: -1.8,
            },
            duration: 201,
            source: "local",
        });

        const errReq = { params: { id: "err-track" } } as any;
        const errRes = createRes();
        await invokeWithErrorHandler(trackByIdHandler, errReq, errRes);
        expect(errRes.statusCode).toBe(500);
    });

    it("returns federated provenance when restoring a track by id", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "federated-track-1",
            title: "Federated Track",
            trackNo: 2,
            duration: 240,
            filePath: null,
            fileSize: 30_000_000,
            origin: "FEDERATED",
            loudnessLufs: null,
            truePeakDb: null,
            album: {
                id: "federated-album-1",
                title: "Federated Album",
                coverUrl: null,
                albumLoudnessLufs: null,
                albumTruePeakDb: null,
                artist: {
                    id: "federated-artist-1",
                    name: "Federated Artist",
                },
            },
            federationPeer: {
                id: "peer-1",
                name: "Peer One",
                outboundStatus: "ACTIVE",
            },
        });
        const res = createRes();

        await trackByIdHandler(
            { params: { id: "federated-track-1" } } as any,
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            id: "federated-track-1",
            source: "federated",
            streamSource: "peer",
            peer: { id: "peer-1", name: "Peer One", online: true },
        });
    });

    it("returns resolved thumbs preference state for a track", async () => {
        mockTrackFindUnique.mockResolvedValue({ id: "track-1" });
        mockLikedTrackFindUnique
            .mockResolvedValueOnce({
                likedAt: new Date("2026-02-19T00:00:00.000Z"),
            })
            .mockResolvedValueOnce({
                likedAt: new Date("2026-02-18T00:00:00.000Z"),
            });
        mockDislikedEntityFindUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                dislikedAt: new Date("2026-02-19T12:00:00.000Z"),
            });

        const likedReq = {
            params: { id: "track-1" },
            user: { id: "user-1" },
        } as any;
        const likedRes = createRes();
        await trackPreferenceHandler(likedReq, likedRes);
        expect(likedRes.statusCode).toBe(200);
        expect(likedRes.body).toEqual(
            expect.objectContaining({
                trackId: "track-1",
                signal: "thumbs_up",
                state: "liked",
                score: 1,
            }),
        );

        const conflictedReq = {
            params: { id: "track-1" },
            user: { id: "user-1" },
        } as any;
        const conflictedRes = createRes();
        await trackPreferenceHandler(conflictedReq, conflictedRes);
        expect(conflictedRes.statusCode).toBe(200);
        expect(conflictedRes.body).toEqual(
            expect.objectContaining({
                trackId: "track-1",
                signal: "thumbs_down",
                state: "disliked",
                score: -1,
            }),
        );
    });

    it("updates thumbs preference state for up/down/clear signals", async () => {
        mockTrackFindUnique.mockResolvedValue({ id: "track-1" });
        mockLikedTrackUpsert.mockResolvedValue({
            userId: "user-1",
            trackId: "track-1",
        });
        mockLikedTrackDeleteMany.mockResolvedValue({ count: 1 });
        mockDislikedEntityUpsert.mockResolvedValue({ id: "disliked-track-1" });
        mockDislikedEntityDeleteMany.mockResolvedValue({ count: 1 });

        const invalidReq = {
            params: { id: "track-1" },
            user: { id: "user-1" },
            body: { signal: "invalid" },
        } as any;
        const invalidRes = createRes();
        await setTrackPreferenceHandler(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({
            error: "Invalid preference signal. Use thumbs_up, thumbs_down, or clear.",
        });

        const thumbsUpReq = {
            params: { id: "track-1" },
            user: { id: "user-1" },
            body: { signal: "thumbs_up" },
        } as any;
        const thumbsUpRes = createRes();
        await setTrackPreferenceHandler(thumbsUpReq, thumbsUpRes);
        expect(thumbsUpRes.statusCode).toBe(200);
        expect(thumbsUpRes.body).toEqual(
            expect.objectContaining({
                signal: "thumbs_up",
                state: "liked",
                score: 1,
            }),
        );
        expect(mockLikedTrackUpsert).toHaveBeenCalled();
        expect(mockDislikedEntityDeleteMany).toHaveBeenCalled();

        const thumbsDownReq = {
            params: { id: "track-1" },
            user: { id: "user-1" },
            body: { signal: "thumbs_down" },
        } as any;
        const thumbsDownRes = createRes();
        await setTrackPreferenceHandler(thumbsDownReq, thumbsDownRes);
        expect(thumbsDownRes.statusCode).toBe(200);
        expect(thumbsDownRes.body).toEqual(
            expect.objectContaining({
                signal: "thumbs_down",
                state: "disliked",
                score: -1,
            }),
        );
        expect(mockDislikedEntityUpsert).toHaveBeenCalled();
        expect(mockLikedTrackDeleteMany).toHaveBeenCalled();

        const clearReq = {
            params: { id: "track-1" },
            user: { id: "user-1" },
            body: { signal: "clear" },
        } as any;
        const clearRes = createRes();
        await setTrackPreferenceHandler(clearReq, clearRes);
        expect(clearRes.statusCode).toBe(200);
        expect(clearRes.body).toEqual(
            expect.objectContaining({
                signal: "clear",
                state: "neutral",
                score: 0,
            }),
        );
        expect(mockLikedTrackDeleteMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                trackId: "track-1",
            },
        });
        expect(mockDislikedEntityDeleteMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                entityType: "track",
                entityId: "track-1",
            },
        });
    });

    it("likes and reads a FEDERATED track through the standard preference route", async () => {
        const federatedTrack = {
            id: "federated-track-1",
            origin: "FEDERATED",
        };
        let likedEntry: { likedAt: Date } | null = null;
        mockTrackFindUnique.mockImplementation(async ({ where }) =>
            where.id === federatedTrack.id ? federatedTrack : null,
        );
        mockLikedTrackUpsert.mockImplementation(async ({ create }) => {
            likedEntry = { likedAt: create.likedAt };
            return { ...create, origin: federatedTrack.origin };
        });
        mockLikedTrackFindUnique.mockImplementation(async () => likedEntry);
        mockDislikedEntityFindUnique.mockResolvedValue(null);
        mockDislikedEntityDeleteMany.mockResolvedValue({ count: 0 });

        const routeApp = express();
        routeApp.use(express.json());
        routeApp.use((req, _res, next) => {
            req.user = { id: "user-1" } as never;
            next();
        });
        routeApp.use("/api/library", router);

        const postResponse = await request(routeApp)
            .post("/api/library/tracks/federated-track-1/preference")
            .send({ signal: "thumbs_up" });
        expect(postResponse.status).toBe(200);
        expect(postResponse.body).toEqual(
            expect.objectContaining({
                trackId: "federated-track-1",
                signal: "thumbs_up",
                state: "liked",
            }),
        );
        expect(mockLikedTrackUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    userId: "user-1",
                    trackId: "federated-track-1",
                }),
            }),
        );

        const getResponse = await request(routeApp).get(
            "/api/library/tracks/federated-track-1/preference",
        );
        expect(getResponse.status).toBe(200);
        expect(getResponse.body).toEqual(
            expect.objectContaining({
                trackId: "federated-track-1",
                signal: "thumbs_up",
                state: "liked",
            }),
        );
    });

    it("updates album-wide track preferences in one batch request", async () => {
        mockAlbumFindFirst.mockResolvedValue({
            id: "album-1",
        });
        mockTrackFindMany
            .mockResolvedValueOnce([{ id: "track-1" }, { id: "track-2" }])
            .mockResolvedValueOnce([{ id: "track-1" }, { id: "track-2" }])
            .mockResolvedValueOnce([{ id: "track-1" }, { id: "track-2" }]);
        mockLikedTrackCreateMany.mockResolvedValue({ count: 2 });
        mockDislikedEntityCreateMany.mockResolvedValue({ count: 2 });
        mockPrismaTransaction.mockImplementation(async (callback: any) =>
            callback({
                likedTrack: {
                    deleteMany: mockLikedTrackDeleteMany,
                    createMany: mockLikedTrackCreateMany,
                },
                dislikedEntity: {
                    deleteMany: mockDislikedEntityDeleteMany,
                    createMany: mockDislikedEntityCreateMany,
                },
            }),
        );

        const invalidReq = {
            params: { id: "album-1" },
            user: { id: "user-1" },
            body: { signal: "invalid" },
        } as any;
        const invalidRes = createRes();
        await setAlbumPreferenceHandler(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({
            error: "Invalid preference signal. Use thumbs_up, thumbs_down, or clear.",
        });

        const thumbsUpReq = {
            params: { id: "album-1" },
            user: { id: "user-1" },
            body: { signal: "thumbs_up" },
        } as any;
        const thumbsUpRes = createRes();
        await setAlbumPreferenceHandler(thumbsUpReq, thumbsUpRes);
        expect(thumbsUpRes.statusCode).toBe(200);
        expect(thumbsUpRes.body).toEqual(
            expect.objectContaining({
                albumId: "album-1",
                trackCount: 2,
                signal: "thumbs_up",
                state: "liked",
                score: 1,
            }),
        );
        expect(mockLikedTrackCreateMany).toHaveBeenCalledWith({
            data: [
                {
                    userId: "user-1",
                    trackId: "track-1",
                    likedAt: expect.any(Date),
                },
                {
                    userId: "user-1",
                    trackId: "track-2",
                    likedAt: expect.any(Date),
                },
            ],
            skipDuplicates: true,
        });

        const thumbsDownReq = {
            params: { id: "album-1" },
            user: { id: "user-1" },
            body: { signal: "thumbs_down" },
        } as any;
        const thumbsDownRes = createRes();
        await setAlbumPreferenceHandler(thumbsDownReq, thumbsDownRes);
        expect(thumbsDownRes.statusCode).toBe(200);
        expect(thumbsDownRes.body).toEqual(
            expect.objectContaining({
                albumId: "album-1",
                trackCount: 2,
                signal: "thumbs_down",
                state: "disliked",
                score: -1,
            }),
        );
        expect(mockDislikedEntityCreateMany).toHaveBeenCalledWith({
            data: [
                {
                    userId: "user-1",
                    entityType: "track",
                    entityId: "track-1",
                    dislikedAt: expect.any(Date),
                },
                {
                    userId: "user-1",
                    entityType: "track",
                    entityId: "track-2",
                    dislikedAt: expect.any(Date),
                },
            ],
            skipDuplicates: true,
        });

        const clearReq = {
            params: { id: "album-1" },
            user: { id: "user-1" },
            body: { signal: "clear" },
        } as any;
        const clearRes = createRes();
        await setAlbumPreferenceHandler(clearReq, clearRes);
        expect(clearRes.statusCode).toBe(200);
        expect(clearRes.body).toEqual(
            expect.objectContaining({
                albumId: "album-1",
                trackCount: 2,
                signal: "clear",
                state: "neutral",
                score: 0,
            }),
        );
        expect(mockLikedTrackDeleteMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                trackId: { in: ["track-1", "track-2"] },
            },
        });
        expect(mockDislikedEntityDeleteMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                entityType: "track",
                entityId: { in: ["track-1", "track-2"] },
            },
        });
    });

    it("rejects album preference updates when an album has no local tracks", async () => {
        mockAlbumFindFirst.mockResolvedValue({ id: "album-empty" });
        mockTrackFindMany.mockResolvedValueOnce([]);

        const req = {
            params: { id: "album-empty" },
            user: { id: "user-1" },
            body: { signal: "thumbs_up" },
        } as any;
        const res = createRes();

        await setAlbumPreferenceHandler(req, res);

        expect(res.statusCode).toBe(422);
        expect(res.body).toEqual({
            error: "Album preferences require at least one local track",
        });
        expect(mockPrismaTransaction).not.toHaveBeenCalled();
    });

    it("handles audio-info lookup for missing track, missing file, and parsed metadata", async () => {
        mockTrackFindUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ filePath: "Artist\\track.flac" })
            .mockResolvedValueOnce({ filePath: "Artist\\track.flac" });

        const missingReq = {
            params: { id: "missing-track" },
            user: { id: "user-1" },
            query: {},
        } as any;
        const missingRes = createRes();
        await audioInfoHandler(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);
        expect(missingRes.body).toEqual({ error: "Track not found" });

        const missingFileSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValueOnce(false);
        const missingFileReq = {
            params: { id: "track-no-file" },
            user: { id: "user-1" },
            query: {},
        } as any;
        const missingFileRes = createRes();
        await audioInfoHandler(missingFileReq, missingFileRes);
        expect(missingFileRes.statusCode).toBe(404);
        expect(missingFileRes.body).toEqual({
            error: "File not found on disk",
        });
        missingFileSpy.mockRestore();

        const presentFileSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValue(true);
        const okReq = {
            params: { id: "track-ok" },
            user: { id: "user-1" },
            query: {},
        } as any;
        const okRes = createRes();
        await audioInfoHandler(okReq, okRes);
        expect(mockParseFile).toHaveBeenCalledWith("/music/Artist/track.flac", {
            duration: false,
            skipCovers: true,
        });
        expect(mockAudioStreamingCtor).not.toHaveBeenCalled();
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual({
            codec: "flac",
            bitrate: 960,
            sampleRate: 48000,
            bitDepth: 24,
            lossless: true,
            channels: 2,
        });
        presentFileSpy.mockRestore();
    });

    it("derives audio info from synchronized federated metadata", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({
            filePath: null,
            fileModified: new Date("2026-08-19T00:00:00.000Z"),
            fileSize: 30_000_000,
            duration: 240,
            mime: "FLAC",
            origin: "FEDERATED",
            peerId: "peer-1",
        });
        const existsSpy = jest.spyOn(fs, "existsSync");
        const res = createRes();

        await audioInfoHandler(
            {
                params: { id: "federated-track" },
                user: { id: "user-1" },
                query: {},
            } as any,
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            codec: "FLAC",
            bitrate: 1000,
            sampleRate: null,
            bitDepth: null,
            lossless: true,
            channels: null,
        });
        expect(existsSpy).not.toHaveBeenCalled();
        expect(mockParseFile).not.toHaveBeenCalled();
        expect(mockAudioStreamingCtor).not.toHaveBeenCalled();
        existsSpy.mockRestore();
    });

    it("returns a null codec when federated mime is missing", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({
            filePath: null,
            fileModified: new Date("2026-08-19T00:00:00.000Z"),
            fileSize: 30_000_000,
            duration: 240,
            mime: null,
            origin: "FEDERATED",
            peerId: "peer-1",
        });
        const res = createRes();

        await audioInfoHandler(
            {
                params: { id: "federated-track-missing-info" },
                user: { id: "user-1" },
                query: {},
            } as any,
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            codec: null,
            bitrate: 1000,
            sampleRate: null,
            bitDepth: null,
            lossless: false,
            channels: null,
        });
        expect(mockParseFile).not.toHaveBeenCalled();
        expect(mockAudioStreamingCtor).not.toHaveBeenCalled();
    });

    it("does not probe a transcode for federated playback audio info", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({
            filePath: null,
            fileModified: new Date("2026-08-19T00:00:00.000Z"),
            fileSize: 30_000_000,
            duration: 240,
            mime: "M4A",
            origin: "FEDERATED",
            peerId: "peer-1",
        });
        const res = createRes();

        await audioInfoHandler(
            {
                params: { id: "federated-playback-track" },
                user: { id: "user-1" },
                query: { playback: "true", quality: "low" },
            } as any,
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            codec: "AAC",
            bitrate: 1000,
            sampleRate: null,
            bitDepth: null,
            lossless: false,
            channels: null,
        });
        expect(mockUserSettingsFindUnique).not.toHaveBeenCalled();
        expect(mockStreamGetStreamFilePath).not.toHaveBeenCalled();
        expect(mockParseFile).not.toHaveBeenCalled();
        expect(mockAudioStreamingCtor).not.toHaveBeenCalled();
    });

    it("maps audio-info parsing errors to HTTP 500", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({
            filePath: "Artist\\track-corrupt.flac",
        });
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
        mockParseFile.mockRejectedValueOnce(new Error("metadata-corrupt"));

        const req = {
            params: { id: "track-corrupt" },
            user: { id: "user-1" },
            query: {},
        } as any;
        const res = createRes();

        await audioInfoHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to read audio metadata" });

        existsSpy.mockRestore();
    });

    it("returns 404 when audio info track exists but has no stored file path", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-no-file-path",
            filePath: null,
        });

        const filePathMissingReq = {
            params: { id: "track-no-file-path" },
            user: { id: "user-1" },
            query: {},
        } as any;
        const filePathMissingRes = createRes();

        await audioInfoHandler(filePathMissingReq, filePathMissingRes);

        expect(filePathMissingRes.statusCode).toBe(404);
        expect(filePathMissingRes.body).toEqual({ error: "Track not found" });
    });

    it("returns 403 when album deletion is disabled in settings", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: false,
        });

        const disabledRes = createRes();
        await deleteAlbumHandler(
            { params: { id: "album-locked" } } as any,
            disabledRes,
        );

        expect(disabledRes.statusCode).toBe(403);
        expect(disabledRes.body).toEqual({
            error: "Library deletion is disabled in admin settings",
        });
        expect(mockAlbumFindUnique).not.toHaveBeenCalled();
        expect(mockAlbumDelete).not.toHaveBeenCalled();
    });

    it("fails closed when deletion targets a CATALOG album", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockAlbumFindUnique.mockResolvedValueOnce({
            id: "album-catalog",
            rgMbid: "rg-catalog",
            title: "Catalog Skeleton",
            location: "CATALOG",
            artist: { name: "Catalog Artist" },
            tracks: [],
        });
        const res = createRes();

        await deleteAlbumHandler(
            { params: { id: "album-catalog" } } as any,
            res,
        );

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Album not found" });
        expect(mockAlbumDelete).not.toHaveBeenCalled();
    });

    it("returns 500 when album deletion persistence fails", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockAlbumFindUnique.mockResolvedValueOnce({
            id: "album-delete-fail",
            rgMbid: "rg-album-delete-fail",
            title: "Album Delete Fail",
            location: "LIBRARY",
            artist: { name: "Failing Artist" },
            tracks: [],
        });
        mockAlbumDelete.mockRejectedValueOnce(new Error("album-db-down"));
        const unlinkSpy = jest.spyOn(fs, "unlinkSync");

        const failureRes = createRes();
        await invokeWithErrorHandler(
            deleteAlbumHandler,
            { params: { id: "album-delete-fail" } } as any,
            failureRes,
        );

        expect(failureRes.statusCode).toBe(500);
        expect(unlinkSpy).not.toHaveBeenCalled();
        unlinkSpy.mockRestore();
    });

    it("applies delete-policy gates and not-found/success behavior for track, album, and artist deletion", async () => {
        mockGetSystemSettings
            .mockResolvedValueOnce({ libraryDeletionEnabled: false })
            .mockResolvedValueOnce({ libraryDeletionEnabled: true })
            .mockResolvedValueOnce({ libraryDeletionEnabled: true })
            .mockResolvedValueOnce({ libraryDeletionEnabled: false })
            .mockResolvedValueOnce({ libraryDeletionEnabled: true })
            .mockResolvedValueOnce({ libraryDeletionEnabled: true })
            .mockResolvedValueOnce({ libraryDeletionEnabled: false })
            .mockResolvedValueOnce({ libraryDeletionEnabled: true })
            .mockResolvedValueOnce({ libraryDeletionEnabled: true });

        const deleteTrackReq = { params: { id: "track-1" } } as any;
        const deleteTrackResDenied = createRes();
        await deleteTrackHandler(deleteTrackReq, deleteTrackResDenied);
        expect(deleteTrackResDenied.statusCode).toBe(403);

        mockTrackFindUnique.mockResolvedValueOnce(null);
        const deleteTrackResNotFound = createRes();
        await deleteTrackHandler(deleteTrackReq, deleteTrackResNotFound);
        expect(deleteTrackResNotFound.statusCode).toBe(404);
        expect(deleteTrackResNotFound.body).toEqual({
            error: "Track not found",
        });

        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-2",
            title: "Track Two",
            filePath: null,
            album: { artist: { id: "artist-2", name: "Artist Two" } },
        });
        const deleteTrackResOk = createRes();
        await deleteTrackHandler(
            { params: { id: "track-2" } } as any,
            deleteTrackResOk,
        );
        expect(mockTrackDelete).toHaveBeenCalledWith({
            where: { id: "track-2" },
            select: { id: true, albumId: true },
        });
        expect(deleteTrackResOk.statusCode).toBe(200);
        expect(deleteTrackResOk.body).toEqual({
            message: "Track deleted successfully",
        });

        const deleteAlbumReq = { params: { id: "album-1" } } as any;
        const deleteAlbumResDenied = createRes();
        await deleteAlbumHandler(deleteAlbumReq, deleteAlbumResDenied);
        expect(deleteAlbumResDenied.statusCode).toBe(403);

        mockAlbumFindUnique.mockResolvedValueOnce(null);
        const deleteAlbumResNotFound = createRes();
        await deleteAlbumHandler(deleteAlbumReq, deleteAlbumResNotFound);
        expect(deleteAlbumResNotFound.statusCode).toBe(404);
        expect(deleteAlbumResNotFound.body).toEqual({
            error: "Album not found",
        });

        mockAlbumFindUnique.mockResolvedValueOnce({
            id: "album-2",
            rgMbid: "rg-album-2",
            title: "Album Two",
            location: "LIBRARY",
            artist: { name: "Artist Two" },
            tracks: [],
        });
        const albumFsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);
        const deleteAlbumResOk = createRes();
        await deleteAlbumHandler(
            { params: { id: "album-2" } } as any,
            deleteAlbumResOk,
        );
        expect(mockAlbumDelete).toHaveBeenCalledWith({
            where: { id: "album-2" },
        });
        expect(mockOwnedAlbumDeleteMany).toHaveBeenCalledWith({
            where: { rgMbid: "rg-album-2" },
        });
        expect(deleteAlbumResOk.statusCode).toBe(200);
        expect(deleteAlbumResOk.body).toEqual({
            message: "Album deleted successfully",
            deletedFiles: 0,
        });
        albumFsSpy.mockRestore();

        const deleteArtistReq = { params: { id: "artist-1" } } as any;
        const deleteArtistResDenied = createRes();
        await deleteArtistHandler(deleteArtistReq, deleteArtistResDenied);
        expect(deleteArtistResDenied.statusCode).toBe(403);

        mockArtistFindUnique.mockResolvedValueOnce(null);
        const deleteArtistResNotFound = createRes();
        await deleteArtistHandler(deleteArtistReq, deleteArtistResNotFound);
        expect(deleteArtistResNotFound.statusCode).toBe(404);
        expect(deleteArtistResNotFound.body).toEqual({
            error: "Artist not found",
        });

        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-2",
            name: "Artist Two",
            mbid: "temp-artist-2",
            albums: [],
        });
        const artistFsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);
        const deleteArtistResOk = createRes();
        await deleteArtistHandler(
            { params: { id: "artist-2" } } as any,
            deleteArtistResOk,
        );
        expect(mockOwnedAlbumDeleteMany).toHaveBeenCalledWith({
            where: { artistId: "artist-2" },
        });
        expect(mockArtistDelete).toHaveBeenCalledWith({
            where: { id: "artist-2" },
        });
        expect(deleteArtistResOk.statusCode).toBe(200);
        expect(deleteArtistResOk.body).toEqual({
            message: "Artist deleted successfully",
            deletedFiles: 0,
            lidarrDeleted: false,
            lidarrError: null,
        });
        expect(mockBumpSearchCacheVersion).toHaveBeenCalledTimes(3);
        artistFsSpy.mockRestore();
    });

    it("deletes track file when it exists on disk before database delete", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-delete-1",
            title: "Delete Me",
            filePath: "Artist-One/Track.flac",
            albumId: "album-observed",
        });
        mockTrackDelete.mockResolvedValueOnce({
            id: "track-delete-1",
            albumId: "album-authoritative",
        });
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
        const unlinkSpy = jest
            .spyOn(fs, "unlinkSync")
            .mockImplementation(() => undefined);

        const res = createRes();
        await deleteTrackHandler(
            { params: { id: "track-delete-1" } } as any,
            res,
        );

        expect(unlinkSpy).toHaveBeenCalledWith("/music/Artist-One/Track.flac");
        expect(mockTrackDelete).toHaveBeenCalledWith({
            where: { id: "track-delete-1" },
            select: { id: true, albumId: true },
        });
        expect(mockPrismaExecuteRaw).toHaveBeenCalledWith(
            expect.any(Array),
            "album-authoritative",
        );
        // A concurrent reassignment makes the observed and authoritative
        // albums differ; both must be recomputed.
        expect(mockPrismaExecuteRaw).toHaveBeenCalledWith(
            expect.any(Array),
            "album-observed",
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ message: "Track deleted successfully" });

        existsSpy.mockRestore();
        unlinkSpy.mockRestore();
    });

    it("skips absolute and dot-segment track paths while deleting their database rows", async () => {
        mockGetSystemSettings.mockResolvedValue({
            libraryDeletionEnabled: true,
        });
        mockTrackFindUnique
            .mockResolvedValueOnce({
                id: "track-absolute",
                title: "Absolute Path",
                filePath: "/outside/track.flac",
            })
            .mockResolvedValueOnce({
                id: "track-windows-absolute",
                title: "Windows Absolute Path",
                filePath: "C:\\outside\\track.flac",
            })
            .mockResolvedValueOnce({
                id: "track-dot-segment",
                title: "Dot Segment Path",
                filePath: "Artist/../outside.flac",
            });
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
        const unlinkSpy = jest
            .spyOn(fs, "unlinkSync")
            .mockImplementation(() => undefined);

        await deleteTrackHandler(
            { params: { id: "track-absolute" } } as any,
            createRes(),
        );
        await deleteTrackHandler(
            { params: { id: "track-windows-absolute" } } as any,
            createRes(),
        );
        await deleteTrackHandler(
            { params: { id: "track-dot-segment" } } as any,
            createRes(),
        );

        expect(existsSpy).not.toHaveBeenCalled();
        expect(unlinkSpy).not.toHaveBeenCalled();
        expect(mockTrackDelete).toHaveBeenNthCalledWith(1, {
            where: { id: "track-absolute" },
            select: { id: true, albumId: true },
        });
        expect(mockTrackDelete).toHaveBeenNthCalledWith(2, {
            where: { id: "track-windows-absolute" },
            select: { id: true, albumId: true },
        });
        expect(mockTrackDelete).toHaveBeenNthCalledWith(3, {
            where: { id: "track-dot-segment" },
            select: { id: true, albumId: true },
        });

        existsSpy.mockRestore();
        unlinkSpy.mockRestore();
    });

    it("continues track deletion when file removal fails", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-delete-2",
            title: "Delete Me with Locked File",
            filePath: "Locked/Track.flac",
        });
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
        const unlinkSpy = jest
            .spyOn(fs, "unlinkSync")
            .mockImplementation(() => {
                throw new Error("locked");
            });

        const res = createRes();
        await deleteTrackHandler(
            { params: { id: "track-delete-2" } } as any,
            res,
        );

        expect(unlinkSpy).toHaveBeenCalledWith("/music/Locked/Track.flac");
        expect(mockTrackDelete).toHaveBeenCalledWith({
            where: { id: "track-delete-2" },
            select: { id: true, albumId: true },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ message: "Track deleted successfully" });

        existsSpy.mockRestore();
        unlinkSpy.mockRestore();
    });

    it("returns 500 when track deletion fails after permission checks", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-delete-3",
            title: "Delete Me",
            filePath: null,
        });
        mockTrackDelete.mockRejectedValueOnce(new Error("db delete failed"));

        const res = createRes();
        await invokeWithErrorHandler(
            deleteTrackHandler,
            { params: { id: "track-delete-3" } } as any,
            res,
        );

        expect(res.statusCode).toBe(500);
    });

    it("collects artist deletion folders from multiple file path formats", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-delete",
            name: "Delete Artist",
            mbid: null,
            albums: [
                {
                    tracks: [
                        { filePath: "Artist Folder/Album 1/track-one.flac" },
                        { filePath: "single-track.flac" },
                    ],
                },
            ],
        });

        const existingPaths = new Set([
            "/music/Artist Folder/Album 1/track-one.flac",
            "/music/Artist Folder",
            "/music/single-track.flac",
        ]);
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockImplementation((targetPath: fs.PathLike) => {
                return existingPaths.has(targetPath.toString());
            });
        const unlinkSpy = jest
            .spyOn(fs, "unlinkSync")
            .mockImplementation(() => undefined);
        const rmSpy = jest
            .spyOn(fs, "rmSync")
            .mockImplementation(() => undefined);

        const res = createRes();
        await deleteArtistHandler(
            { params: { id: "artist-delete" } } as any,
            res,
        );

        expect(unlinkSpy).toHaveBeenCalledWith(
            "/music/Artist Folder/Album 1/track-one.flac",
        );
        expect(unlinkSpy).toHaveBeenCalledWith("/music/single-track.flac");
        expect(rmSpy).toHaveBeenCalledWith("/music/Artist Folder", {
            recursive: true,
            force: true,
        });
        expect(rmSpy).toHaveBeenCalledWith("/music/single-track.flac", {
            recursive: true,
            force: true,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Artist deleted successfully",
            deletedFiles: 2,
            lidarrDeleted: false,
            lidarrError: null,
        });

        existsSpy.mockRestore();
        unlinkSpy.mockRestore();
        rmSpy.mockRestore();
    });

    it("locks an artist's albums in id order before deleting the artist", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-lock-order",
            name: "Lock Order Artist",
            mbid: "temp-lock-order",
            albums: [],
        });
        const operations: string[] = [];
        const lockAlbums = jest.fn(
            async (_query: { strings: readonly string[] }) => {
                operations.push("lock-albums");
                return [];
            },
        );
        const deleteArtist = jest.fn(async () => {
            operations.push("delete-artist");
            return { id: "artist-lock-order" };
        });
        mockPrismaTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                $queryRaw: lockAlbums,
                artist: { delete: deleteArtist },
            }),
        );
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);

        const res = createRes();
        await deleteArtistHandler(
            { params: { id: "artist-lock-order" } } as any,
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(operations).toEqual(["lock-albums", "delete-artist"]);
        const query = lockAlbums.mock.calls[0][0];
        expect(query.strings.join("")).toContain('WHERE "artistId" = ');
        expect(query.strings.join("")).toContain(
            'ORDER BY "id"\n            FOR UPDATE',
        );
        expect(deleteArtist).toHaveBeenCalledWith({
            where: { id: "artist-lock-order" },
        });

        existsSpy.mockRestore();
    });

    it("contains artist file and recursive folder deletion for malicious persisted paths", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-containment",
            name: "Safe Artist",
            mbid: null,
            albums: [
                {
                    tracks: [
                        { filePath: "../outside/track.flac" },
                        { filePath: "/absolute/track.flac" },
                        { filePath: "Artist/../Other/track.flac" },
                        {
                            filePath: "Safe Artist/Safe Album/safe-track.flac",
                        },
                    ],
                },
            ],
        });
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
        const unlinkSpy = jest
            .spyOn(fs, "unlinkSync")
            .mockImplementation(() => undefined);
        const rmSpy = jest
            .spyOn(fs, "rmSync")
            .mockImplementation(() => undefined);

        const res = createRes();
        await deleteArtistHandler(
            { params: { id: "artist-containment" } } as any,
            res,
        );

        expect(unlinkSpy).toHaveBeenCalledTimes(1);
        expect(unlinkSpy).toHaveBeenCalledWith(
            "/music/Safe Artist/Safe Album/safe-track.flac",
        );
        expect(rmSpy).toHaveBeenCalled();
        for (const [targetPath] of rmSpy.mock.calls) {
            expect(targetPath).not.toBe("/music");
            expect(targetPath).not.toBe("/");
            expect(targetPath.toString().startsWith("/music/")).toBe(true);
        }
        expect(res.body.deletedFiles).toBe(1);
        expect(mockArtistDelete).toHaveBeenCalledWith({
            where: { id: "artist-containment" },
        });

        existsSpy.mockRestore();
        unlinkSpy.mockRestore();
        rmSpy.mockRestore();
    });

    it("falls back to manual artist-folder cleanup when recursive delete fails", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-fallback",
            name: "Fallback Artist",
            mbid: null,
            albums: [
                {
                    tracks: [
                        { filePath: "Fallback Artist/Album/track-1.flac" },
                        { filePath: "Fallback Artist/Album/track-2.flac" },
                    ],
                },
            ],
        });

        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
        const unlinkSpy = jest
            .spyOn(fs, "unlinkSync")
            .mockImplementation((targetPath: fs.PathLike) => {
                if (targetPath.toString().endsWith("track-1.flac")) {
                    throw new Error("locked");
                }
            });
        const rmSyncSpy = jest
            .spyOn(fs, "rmSync")
            .mockImplementation((targetPath: fs.PathLike) => {
                if (targetPath.toString() === "/music/Fallback Artist") {
                    throw new Error("rm failed");
                }
            });
        const readdirSpy = jest
            .spyOn(fs, "readdirSync")
            .mockReturnValue(["child-dir", "child.flac"] as any);
        const statSpy = jest.spyOn(fs, "statSync").mockImplementation(
            (targetPath: fs.PathLike) =>
                ({
                    isDirectory: () =>
                        targetPath.toString().endsWith("child-dir"),
                }) as fs.Stats,
        );
        const rmdirSpy = jest.spyOn(fs, "rmdirSync").mockImplementation(() => {
            throw new Error("rmdir failed");
        });

        const res = createRes();
        await deleteArtistHandler(
            { params: { id: "artist-fallback" } } as any,
            res,
        );

        expect(unlinkSpy).toHaveBeenCalledWith(
            "/music/Fallback Artist/Album/track-1.flac",
        );
        expect(unlinkSpy).toHaveBeenCalledWith(
            "/music/Fallback Artist/child.flac",
        );
        expect(rmSyncSpy).toHaveBeenCalledWith("/music/Fallback Artist", {
            recursive: true,
            force: true,
        });
        expect(readdirSpy).toHaveBeenCalled();
        expect(statSpy).toHaveBeenCalled();
        expect(mockLoggerError).toHaveBeenCalledWith(
            expect.stringContaining(
                "Cleanup also failed for /music/Fallback Artist",
            ),
            "rmdir failed",
        );
        expect(res.body.deletedFiles).toBeGreaterThan(0);

        existsSpy.mockRestore();
        unlinkSpy.mockRestore();
        rmSyncSpy.mockRestore();
        readdirSpy.mockRestore();
        statSpy.mockRestore();
        rmdirSpy.mockRestore();
    });

    it("deletes additional common artist folders", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-common",
            name: "Common Artist",
            mbid: null,
            albums: [{ tracks: [{ filePath: "Common Folder/Track.flac" }] }],
        });
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockImplementation((targetPath: fs.PathLike) =>
                [
                    "/music/Common Folder/Track.flac",
                    "/music/Common Folder",
                    "/music/Common Artist",
                ].includes(targetPath.toString()),
            );
        const unlinkSpy = jest
            .spyOn(fs, "unlinkSync")
            .mockImplementation(() => undefined);
        const rmSyncSpy = jest
            .spyOn(fs, "rmSync")
            .mockImplementation(() => undefined);

        const res = createRes();
        await deleteArtistHandler(
            { params: { id: "artist-common" } } as any,
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(rmSyncSpy).toHaveBeenCalledWith("/music/Common Folder", {
            recursive: true,
            force: true,
        });
        expect(rmSyncSpy).toHaveBeenCalledWith("/music/Common Artist", {
            recursive: true,
            force: true,
        });
        expect(unlinkSpy).toHaveBeenCalled();
        existsSpy.mockRestore();
        rmSyncSpy.mockRestore();
        unlinkSpy.mockRestore();
    });

    it("handles Lidarr outcomes while still deleting artist", async () => {
        mockGetSystemSettings.mockResolvedValue({
            libraryDeletionEnabled: true,
        });
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);

        mockLidarrDeleteArtist.mockResolvedValueOnce({
            success: true,
            message: "deleted",
        });
        mockOwnedAlbumDeleteMany.mockRejectedValueOnce(
            new Error("owned-album cleanup failed"),
        );
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-lidarr-ok",
            name: "Lidarr Artist",
            mbid: "mbid-ok",
            albums: [],
        });
        let res = createRes();
        await deleteArtistHandler(
            { params: { id: "artist-lidarr-ok" } } as any,
            res,
        );
        expect(res.body.lidarrDeleted).toBe(true);
        expect(res.body.lidarrError).toBeNull();

        mockLidarrDeleteArtist.mockResolvedValueOnce({
            success: false,
            message: "not-found",
        });
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-lidarr-failure",
            name: "Lidarr Artist",
            mbid: "mbid-fail",
            albums: [],
        });
        res = createRes();
        await deleteArtistHandler(
            { params: { id: "artist-lidarr-failure" } } as any,
            res,
        );
        expect(res.body.lidarrDeleted).toBe(false);
        expect(res.body.lidarrError).toBe("not-found");

        mockLidarrDeleteArtist.mockRejectedValueOnce(
            new Error("lidarr service unavailable"),
        );
        mockArtistDelete.mockRejectedValueOnce(new Error("db unavailable"));
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-lidarr-bad",
            name: "Lidarr Artist",
            mbid: "mbid-bad",
            albums: [],
        });
        res = createRes();
        await deleteArtistHandler(
            { params: { id: "artist-lidarr-bad" } } as any,
            res,
        );
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to delete artist",
        });
        expect(JSON.stringify(res.body)).not.toContain("db unavailable");

        existsSpy.mockRestore();
    });

    it("deletes physical album files and cleans empty album folders", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockAlbumFindUnique.mockResolvedValueOnce({
            id: "album-del",
            rgMbid: "rg-album-del",
            title: "Deletion Album",
            location: "LIBRARY",
            artist: { name: "Delete Artist" },
            tracks: [{ filePath: "Delete Artist/Deletion Album/track.flac" }],
        });
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
        const unlinkSpy = jest
            .spyOn(fs, "unlinkSync")
            .mockImplementation(() => undefined);
        const readdirSpy = jest.spyOn(fs, "readdirSync").mockReturnValue([]);
        const rmdirSpy = jest
            .spyOn(fs, "rmdirSync")
            .mockImplementation(() => undefined);

        const req = { params: { id: "album-del" } } as any;
        const res = createRes();
        await deleteAlbumHandler(req, res);

        expect(mockAlbumDelete).toHaveBeenCalledWith({
            where: { id: "album-del" },
        });
        expect(mockOwnedAlbumDeleteMany).toHaveBeenCalledWith({
            where: { rgMbid: "rg-album-del" },
        });
        expect(mockAlbumDelete.mock.invocationCallOrder[0]).toBeLessThan(
            unlinkSpy.mock.invocationCallOrder[0],
        );
        expect(unlinkSpy).toHaveBeenCalledWith(
            "/music/Delete Artist/Deletion Album/track.flac",
        );
        expect(readdirSpy).toHaveBeenCalledWith(
            "/music/Delete Artist/Deletion Album",
        );
        expect(rmdirSpy).toHaveBeenCalledWith(
            "/music/Delete Artist/Deletion Album",
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Album deleted successfully",
            deletedFiles: 1,
        });

        existsSpy.mockRestore();
        unlinkSpy.mockRestore();
        readdirSpy.mockRestore();
        rmdirSpy.mockRestore();
    });

    it("skips unsafe album track paths and out-of-root album folders", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockAlbumFindUnique.mockResolvedValueOnce({
            id: "album-contained",
            rgMbid: "rg-album-contained",
            title: "..",
            location: "LIBRARY",
            artist: { name: ".." },
            tracks: [
                { filePath: "../outside.flac" },
                { filePath: "Safe Artist/Safe Album/safe.flac" },
            ],
        });
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
        const unlinkSpy = jest
            .spyOn(fs, "unlinkSync")
            .mockImplementation(() => undefined);
        const readdirSpy = jest.spyOn(fs, "readdirSync").mockReturnValue([]);
        const rmdirSpy = jest
            .spyOn(fs, "rmdirSync")
            .mockImplementation(() => undefined);

        const res = createRes();
        await deleteAlbumHandler(
            { params: { id: "album-contained" } } as any,
            res,
        );

        expect(unlinkSpy).toHaveBeenCalledTimes(1);
        expect(unlinkSpy).toHaveBeenCalledWith(
            "/music/Safe Artist/Safe Album/safe.flac",
        );
        expect(readdirSpy).not.toHaveBeenCalled();
        expect(rmdirSpy).not.toHaveBeenCalled();
        expect(mockAlbumDelete).toHaveBeenCalledWith({
            where: { id: "album-contained" },
        });
        expect(res.body.deletedFiles).toBe(1);

        existsSpy.mockRestore();
        unlinkSpy.mockRestore();
        readdirSpy.mockRestore();
        rmdirSpy.mockRestore();
    });

    it("handles cover-art URL validation, cache branches, and proxied fetch outcomes", async () => {
        const noInputReq = { params: {}, query: {}, headers: {} } as any;
        const noInputRes = createRes();
        await coverArtHandler(noInputReq, noInputRes);
        expect(noInputRes.statusCode).toBe(400);
        expect(noInputRes.body).toEqual({
            error: "No cover ID or URL provided",
        });

        mockNormalizeExternalImageUrl.mockReturnValueOnce(null);
        const invalidReq = {
            params: {},
            query: { url: "https://invalid.example/cover.jpg" },
            headers: {},
        } as any;
        const invalidRes = createRes();
        await coverArtHandler(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({ error: "Invalid cover art URL" });

        mockRedisGet.mockResolvedValueOnce(JSON.stringify({ notFound: true }));
        const cached404Req = {
            params: {},
            query: { url: "https://img.example/not-found.jpg" },
            headers: {},
        } as any;
        const cached404Res = createRes();
        await coverArtHandler(cached404Req, cached404Res);
        expect(cached404Res.statusCode).toBe(404);
        expect(cached404Res.body).toEqual({ error: "Cover art not found" });

        mockRedisGet.mockResolvedValueOnce(
            JSON.stringify({
                etag: "etag-cache",
                contentType: "image/jpeg",
                data: Buffer.from("cached-cover").toString("base64"),
            }),
        );
        const cached304Req = {
            params: {},
            query: { url: "https://img.example/cached.jpg" },
            headers: { "if-none-match": "etag-cache" },
        } as any;
        const cached304Res = createRes();
        await coverArtHandler(cached304Req, cached304Res);
        expect(cached304Res.statusCode).toBe(304);

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: false,
            status: "invalid_url",
            url: "https://invalid.example/cover.jpg",
        });
        const invalidFetchReq = {
            params: {},
            query: { url: "https://img.example/invalid-fetch.jpg" },
            headers: {},
        } as any;
        const invalidFetchRes = createRes();
        await coverArtHandler(invalidFetchReq, invalidFetchRes);
        expect(invalidFetchRes.statusCode).toBe(400);
        expect(invalidFetchRes.body).toEqual({
            error: "Invalid cover art URL",
        });

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: false,
            status: "not_found",
            url: "https://img.example/missing.jpg",
        });
        const notFoundReq = {
            params: {},
            query: { url: "https://img.example/missing.jpg" },
            headers: {},
        } as any;
        const notFoundRes = createRes();
        await coverArtHandler(notFoundReq, notFoundRes);
        expect(notFoundRes.statusCode).toBe(404);
        expect(notFoundRes.body).toEqual({ error: "Cover art not found" });
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            expect.stringContaining("cover-art:"),
            expect.any(Number),
            JSON.stringify({ notFound: true }),
        );

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: false,
            status: "error",
            url: "https://img.example/error.jpg",
            message: "upstream timeout",
        });
        const errorReq = {
            params: {},
            query: { url: "https://img.example/error.jpg" },
            headers: {},
        } as any;
        const errorRes = createRes();
        await coverArtHandler(errorReq, errorRes);
        expect(errorRes.statusCode).toBe(502);
        expect(errorRes.body).toEqual({ error: "Failed to fetch cover art" });

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: true,
            url: "https://img.example/etag.jpg",
            buffer: Buffer.from("fresh-cover"),
            etag: "etag-fresh",
            contentType: "image/jpeg",
        });
        const fresh304Req = {
            params: {},
            query: { url: "https://img.example/etag.jpg" },
            headers: { "if-none-match": "etag-fresh" },
        } as any;
        const fresh304Res = createRes();
        await coverArtHandler(fresh304Req, fresh304Res);
        expect(fresh304Res.statusCode).toBe(304);

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: true,
            url: "https://img.example/success.jpg",
            buffer: Buffer.from("fresh-cover-2"),
            etag: "etag-success",
            contentType: "image/jpeg",
        });
        const successReq = {
            params: {},
            query: { url: "https://img.example/success.jpg" },
            headers: {},
        } as any;
        const successRes = createRes();
        await coverArtHandler(successReq, successRes);
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual(Buffer.from("fresh-cover-2"));
    });

    it("fetches audiobook covers for query URLs with Origin handling", async () => {
        const { config } = jest.requireMock("../../config") as {
            config: Record<string, unknown>;
        };
        config.allowedOrigins = ["https://app.example"];
        const fetchSpy = jest
            .spyOn(global as any, "fetch")
            .mockResolvedValueOnce(
                new Response(Buffer.from("audiobook-cover"), {
                    status: 200,
                    headers: { "content-type": "image/jpeg" },
                }),
            );
        mockGetSystemSettings.mockResolvedValueOnce({
            audiobookshelfUrl: "https://ab.example",
            audiobookshelfApiKey: "token-123",
        });

        try {
            const queryAudiobookReq = {
                params: {},
                query: { url: "audiobook__items/release-42/cover" },
                headers: { origin: "https://app.example" },
            } as any;
            const queryAudiobookRes = createRes();

            await coverArtHandler(queryAudiobookReq, queryAudiobookRes);

            expect(queryAudiobookRes.statusCode).toBe(200);
            expect(queryAudiobookRes.body).toEqual(
                Buffer.from("audiobook-cover"),
            );
            expect(
                queryAudiobookRes.headers["Access-Control-Allow-Origin"],
            ).toBe("https://app.example");
            expect(queryAudiobookRes.headers["Cache-Control"]).toBe(
                "public, max-age=7776000, immutable",
            );
            expect(fetchSpy).toHaveBeenCalledWith(
                "https://ab.example/api/items/release-42/cover",
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: "Bearer token-123",
                        "User-Agent": expect.stringContaining("soundspan/"),
                    }),
                }),
            );
        } finally {
            delete config.allowedOrigins;
            fetchSpy.mockRestore();
        }
    });

    it("returns 404 when query audiobook cover fetch fails", async () => {
        const fetchSpy = jest
            .spyOn(global as any, "fetch")
            .mockResolvedValueOnce({
                ok: false,
                status: 404,
                statusText: "Not Found",
            } as any);
        mockGetSystemSettings.mockResolvedValueOnce({
            audiobookshelfUrl: "https://ab.example",
            audiobookshelfApiKey: "token-456",
        });

        const queryAudiobookReq = {
            params: {},
            query: { url: "audiobook__items/missing-release/cover" },
            headers: {},
        } as any;
        const queryAudiobookRes = createRes();

        await coverArtHandler(queryAudiobookReq, queryAudiobookRes);

        expect(queryAudiobookRes.statusCode).toBe(404);
        expect(queryAudiobookRes.body).toEqual({
            error: "Audiobook cover art not found",
        });
        expect(fetchSpy).toHaveBeenCalledWith(
            "https://ab.example/api/items/missing-release/cover",
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: "Bearer token-456",
                }),
            }),
        );

        fetchSpy.mockRestore();
    });

    it("handles album-cover validation, fallback, success, and errors", async () => {
        const invalidReq = { params: { mbid: "temp-123" } } as any;
        const invalidRes = createRes();
        await albumCoverHandler(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({ error: "Valid MBID required" });

        mockCoverArtGetCoverArt.mockResolvedValueOnce(null);
        const noCoverReq = { params: { mbid: "mbid-1" } } as any;
        const noCoverRes = createRes();
        await albumCoverHandler(noCoverReq, noCoverRes);
        expect(noCoverRes.statusCode).toBe(204);

        mockCoverArtGetCoverArt.mockResolvedValueOnce(
            "https://coverartarchive.org/cover.jpg",
        );
        const okReq = { params: { mbid: "mbid-2" } } as any;
        const okRes = createRes();
        await albumCoverHandler(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual({
            coverUrl: "https://coverartarchive.org/cover.jpg",
        });

        mockCoverArtGetCoverArt.mockRejectedValueOnce(new Error("cover boom"));
        const errReq = { params: { mbid: "mbid-3" } } as any;
        const errRes = createRes();
        await invokeWithErrorHandler(albumCoverHandler, errReq, errRes);
        expect(errRes.statusCode).toBe(500);
    });

    it("proxies a federated placeholder album before external fallbacks or cache access", async () => {
        mockProxyFederatedCover.mockResolvedValueOnce(true);
        mockAlbumFindUnique.mockResolvedValueOnce({
            id: "fed-album-1",
            title: "Federated Album",
            rgMbid: "federation:peer-1:cmVtb3RlLWFsYnVtLTE",
            coverUrl: null,
            location: "FEDERATED",
            peerId: "peer-1",
            remoteId: "remote-album-1",
            federationPeer: {
                id: "peer-1",
                baseUrl: "https://peer.example",
                outboundToken: "v2:encrypted-token",
                outboundStatus: "ACTIVE",
            },
            artist: { name: "Remote Artist" },
        });
        const req = {
            params: { id: "fed-album-1" },
            query: {},
            headers: {},
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(mockProxyFederatedCover).toHaveBeenCalledWith({
            req,
            res,
            peer: {
                id: "peer-1",
                baseUrl: "https://peer.example",
                outboundToken: "v2:encrypted-token",
                outboundStatus: "ACTIVE",
            },
            remoteId: "remote-album-1",
        });
        expect(mockCoverArtClearNotFoundCache).not.toHaveBeenCalled();
        expect(mockCoverArtGetCoverArt).not.toHaveBeenCalled();
        expect(mockDeezerGetAlbumCover).not.toHaveBeenCalled();
        expect(mockAlbumUpdate).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
    });

    it("redirects a persisted external federated cover without contacting the peer", async () => {
        mockAlbumFindUnique.mockResolvedValueOnce({
            id: "fed-external-cover",
            title: "Federated Persisted Cover",
            rgMbid: "11111111-1111-4111-8111-111111111111",
            coverUrl: "https://images.example/federated-cover.jpg",
            location: "FEDERATED",
            peerId: "peer-1",
            remoteId: "remote-album-external",
            federationPeer: {
                id: "peer-1",
                baseUrl: "https://peer.example",
                outboundToken: "v2:encrypted-token",
                outboundStatus: "ACTIVE",
            },
            artist: { name: "Remote Artist" },
        });
        const res = createRes();

        await coverArtHandler(
            {
                params: { id: "fed-external-cover" },
                query: {},
                headers: {},
            } as any,
            res,
        );

        expect(res.body).toEqual({
            redirect: "https://images.example/federated-cover.jpg",
        });
        expect(mockProxyFederatedCover).not.toHaveBeenCalled();
        expect(mockDeezerGetAlbumCover).not.toHaveBeenCalled();
    });

    it("proxies a federated album with a missing persisted native cover without local providers", async () => {
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);
        mockProxyFederatedCover.mockResolvedValueOnce(true);
        const req = {
            params: { id: "fed-missing-native" },
            query: {},
            headers: {},
        } as any;
        const res = createRes();
        mockAlbumFindUnique.mockResolvedValueOnce({
            id: "fed-missing-native",
            title: "Federated Missing Native",
            rgMbid: "22222222-2222-4222-8222-222222222222",
            coverUrl: "native:albums/fed-missing-native.jpg",
            location: "FEDERATED",
            peerId: "peer-1",
            remoteId: "remote-album-native",
            federationPeer: {
                id: "peer-1",
                baseUrl: "https://peer.example",
                outboundToken: "v2:encrypted-token",
                outboundStatus: "ACTIVE",
            },
            artist: { name: "Remote Artist" },
        });

        try {
            await coverArtHandler(req, res);

            expect(mockProxyFederatedCover).toHaveBeenCalledWith({
                req,
                res,
                peer: expect.objectContaining({ id: "peer-1" }),
                remoteId: "remote-album-native",
            });
            expect(mockCoverArtGetCoverArt).not.toHaveBeenCalled();
            expect(mockDeezerGetAlbumCover).not.toHaveBeenCalled();
        } finally {
            existsSpy.mockRestore();
        }
    });

    it("clears a missing federated native cover before the follow-up request terminates at the peer proxy", async () => {
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);
        mockProxyFederatedCover.mockResolvedValueOnce(true);
        const staleAlbum = {
            id: "fed-native-album",
            title: "Federated Native Album",
            rgMbid: "federation:peer-1:cmVtb3RlLWFsYnVtLTI",
            coverUrl: "native:albums/fed-native-album.jpg",
            location: "FEDERATED",
            peerId: "peer-1",
            remoteId: "remote-album-2",
            federationPeer: {
                id: "peer-1",
                baseUrl: "https://peer.example",
                outboundToken: "v2:encrypted-token",
                outboundStatus: "ACTIVE",
            },
            artist: { name: "Remote Artist" },
        };
        mockAlbumFindUnique
            .mockResolvedValueOnce(staleAlbum)
            .mockResolvedValueOnce({ ...staleAlbum, coverUrl: null });

        try {
            const nativeRes = createRes();
            await coverArtHandler(
                {
                    params: { id: "native:albums/fed-native-album.jpg" },
                    query: {},
                    headers: {},
                } as any,
                nativeRes,
            );

            expect(nativeRes.body).toEqual({
                redirect: "/api/library/cover-art/fed-native-album",
            });
            expect(mockAlbumUpdateMany).toHaveBeenCalledWith({
                where: {
                    id: "fed-native-album",
                    coverUrl: "native:albums/fed-native-album.jpg",
                },
                data: { coverUrl: null },
            });

            const followUpReq = {
                params: { id: "fed-native-album" },
                query: {},
                headers: {},
            } as any;
            const followUpRes = createRes();
            await coverArtHandler(followUpReq, followUpRes);

            expect(mockAlbumFindUnique).toHaveBeenCalledTimes(2);
            expect(mockProxyFederatedCover).toHaveBeenCalledTimes(1);
            expect(mockProxyFederatedCover).toHaveBeenCalledWith({
                req: followUpReq,
                res: followUpRes,
                peer: staleAlbum.federationPeer,
                remoteId: "remote-album-2",
            });
            expect(mockDeezerGetAlbumCover).not.toHaveBeenCalled();
        } finally {
            existsSpy.mockRestore();
        }
    });

    it("does not contact an offline peer for a missing federated cover", async () => {
        mockAlbumFindUnique.mockResolvedValueOnce({
            id: "fed-album-1",
            title: "Federated Album",
            rgMbid: "temp-federated",
            coverUrl: null,
            location: "FEDERATED",
            peerId: "peer-1",
            remoteId: "remote-album-1",
            federationPeer: {
                id: "peer-1",
                baseUrl: "https://peer.example",
                outboundToken: "v2:encrypted-token",
                outboundStatus: "OFFLINE",
            },
            artist: { name: "Remote Artist" },
        });
        const res = createRes();

        await coverArtHandler(
            {
                params: { id: "fed-album-1" },
                query: {},
                headers: {},
            } as any,
            res,
        );

        expect(mockProxyFederatedCover).not.toHaveBeenCalled();
        expect(mockDeezerGetAlbumCover).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(404);
    });

    it("serves local native cover IDs from disk and falls back to Deezer when missing", async () => {
        const missingCoverId = "library-runtime-deezer-miss";
        const presentCoverId = "library-runtime-present";
        const { config } = jest.requireMock("../../config") as {
            config: Record<string, unknown>;
        };
        config.allowedOrigins = ["https://app.example"];
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockImplementation(
                (candidatePath: fs.PathLike) =>
                    typeof candidatePath === "string" &&
                    candidatePath.includes(`${presentCoverId}.jpg`),
            );
        mockAlbumFindUnique.mockResolvedValueOnce({
            id: missingCoverId,
            title: "Missed Album",
            artist: {
                id: "artist-cover",
                name: "Cover Artist",
            },
        });
        mockDeezerGetAlbumCover.mockResolvedValueOnce(
            "https://images.example/cover.jpg",
        );
        mockDownloadAndStoreImage.mockResolvedValueOnce(
            `native:albums/${missingCoverId}.jpg`,
        );

        try {
            const missingReq = {
                params: { id: `native:${missingCoverId}.jpg` },
                query: {},
                headers: {},
            } as any;
            const missingRes = createRes();
            await coverArtHandler(missingReq, missingRes);
            expect(existsSpy).toHaveBeenCalled();
            expect(mockDeezerGetAlbumCover).toHaveBeenCalledWith(
                "Cover Artist",
                "Missed Album",
            );
            expect(mockDownloadAndStoreImage).toHaveBeenCalledWith(
                "https://images.example/cover.jpg",
                missingCoverId,
                "album",
            );
            expect(mockAlbumUpdate).toHaveBeenCalledWith({
                where: { id: missingCoverId },
                data: { coverUrl: `native:albums/${missingCoverId}.jpg` },
            });
            expect(missingRes.statusCode).toBe(200);
            expect(missingRes.body).toEqual({
                redirect: `/api/library/cover-art?url=native%3Aalbums%2F${missingCoverId}.jpg`,
            });
            const presentReq = {
                params: { id: `native:${presentCoverId}.jpg` },
                query: {},
                headers: { origin: "https://app.example" },
            } as any;
            const presentRes = createRes();
            await coverArtHandler(presentReq, presentRes);

            expect(presentRes.statusCode).toBe(200);
            expect(presentRes.body).toEqual({
                filePath: `${presentCoverId}.jpg`,
                options: {
                    dotfiles: "ignore",
                    root: "/tmp/covers",
                    headers: {
                        "Content-Type": "image/jpeg",
                        "Cache-Control": "public, max-age=7776000, immutable",
                        "Cross-Origin-Resource-Policy": "cross-origin",
                        "Access-Control-Allow-Origin": "https://app.example",
                        "Access-Control-Allow-Credentials": "true",
                    },
                },
            });
        } finally {
            delete config.allowedOrigins;
            existsSpy.mockRestore();
        }
    });

    it("recovers missing native cover IDs via Cover Art service when Deezer has no result", async () => {
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);
        const fallbackCoverId = "library-runtime-caa-fallback";
        const releaseGroupMbid = "33333333-3333-4333-8333-333333333333";
        mockAlbumFindUnique.mockResolvedValue({
            id: fallbackCoverId,
            title: "Fallback Album",
            rgMbid: releaseGroupMbid,
            artist: {
                id: "artist-fallback",
                name: "Fallback Artist",
            },
        });
        mockCoverArtGetCoverArt.mockResolvedValue(
            `https://coverartarchive.org/release-group/${releaseGroupMbid}/front.jpg`,
        );
        mockDeezerGetAlbumCover.mockResolvedValue(null);
        mockDownloadAndStoreImage.mockResolvedValue(
            `native:albums/${fallbackCoverId}.jpg`,
        );

        const req = {
            params: { id: `native:${fallbackCoverId}.jpg` },
            query: {},
            headers: {},
        } as any;
        mockAlbumUpdate.mockClear();
        const res = createRes();
        try {
            await coverArtHandler(req, res);

            expect(mockDownloadAndStoreImage).toHaveBeenCalled();
            expect(mockAlbumUpdate).toHaveBeenCalledWith({
                where: { id: fallbackCoverId },
                data: { coverUrl: `native:albums/${fallbackCoverId}.jpg` },
            });
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({
                redirect: `/api/library/cover-art?url=native%3Aalbums%2F${fallbackCoverId}.jpg`,
            });
        } finally {
            existsSpy.mockRestore();
        }
    });
});
