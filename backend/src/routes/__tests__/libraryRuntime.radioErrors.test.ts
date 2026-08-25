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
    mockLoadGenreRadioAggregates,
    mockLoadDecadeRadioAggregates,
    mockLoadVibeRadioCandidateIds,
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
        mockLoadGenreRadioAggregates.mockReset();
        mockLoadDecadeRadioAggregates.mockReset();
        mockLoadVibeRadioCandidateIds.mockReset();
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
        mockLoadGenreRadioAggregates.mockResolvedValue([]);
        mockLoadDecadeRadioAggregates.mockResolvedValue([]);
        mockLoadVibeRadioCandidateIds.mockResolvedValue([]);
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

    it("returns invalid cover ID format for malformed /cover-art path params", async () => {
        const invalidReq = { params: { id: "just-text" }, query: {} } as any;
        const invalidRes = createRes();

        await coverArtHandler(invalidReq, invalidRes);

        expect(invalidRes.statusCode).toBe(404);
        expect(invalidRes.body).toEqual({
            error: "Album not found",
        });
    });

    it("handles cover-art-colors cache/fetch branches and extraction failures", async () => {
        const missingReq = { query: {} } as any;
        const missingRes = createRes();
        await coverArtColorsHandler(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(400);
        expect(missingRes.body).toEqual({ error: "URL parameter required" });

        mockNormalizeExternalImageUrl.mockReturnValueOnce(null);
        const invalidReq = { query: { url: "https://bad.example" } } as any;
        const invalidRes = createRes();
        await coverArtColorsHandler(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({ error: "Invalid image URL" });

        const placeholderReq = {
            query: { url: "https://cdn/placeholder.jpg" },
        } as any;
        const placeholderRes = createRes();
        await coverArtColorsHandler(placeholderReq, placeholderRes);
        expect(placeholderRes.statusCode).toBe(200);
        expect(placeholderRes.body).toEqual(
            expect.objectContaining({
                vibrant: "#1db954",
                muted: "#535353",
            }),
        );

        mockRedisGet.mockResolvedValueOnce(
            JSON.stringify({
                vibrant: "#aaaaaa",
                darkVibrant: "#bbbbbb",
                lightVibrant: "#cccccc",
                muted: "#dddddd",
                darkMuted: "#eeeeee",
                lightMuted: "#ffffff",
            }),
        );
        const cacheHitReq = {
            query: { url: "https://img.example/cache.jpg" },
        } as any;
        const cacheHitRes = createRes();
        await coverArtColorsHandler(cacheHitReq, cacheHitRes);
        expect(cacheHitRes.statusCode).toBe(200);
        expect(cacheHitRes.body).toEqual(
            expect.objectContaining({ vibrant: "#aaaaaa" }),
        );

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: false,
            status: "not_found",
            url: "https://img.example/missing.jpg",
        });
        const notFoundReq = {
            query: { url: "https://img.example/missing.jpg" },
        } as any;
        const notFoundRes = createRes();
        await coverArtColorsHandler(notFoundReq, notFoundRes);
        expect(notFoundRes.statusCode).toBe(404);
        expect(notFoundRes.body).toEqual({ error: "Image not found" });

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: false,
            status: "error",
            url: "https://img.example/error.jpg",
            message: "fetch failed",
        });
        const fetchErrorReq = {
            query: { url: "https://img.example/error.jpg" },
        } as any;
        const fetchErrorRes = createRes();
        await coverArtColorsHandler(fetchErrorReq, fetchErrorRes);
        expect(fetchErrorRes.statusCode).toBe(504);
        expect(fetchErrorRes.body).toEqual({ error: "Image fetch failed" });

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: true,
            url: "https://img.example/ok.jpg",
            buffer: Buffer.from("img"),
        });
        mockExtractColorsFromImage.mockResolvedValueOnce({
            vibrant: "#100000",
            darkVibrant: "#200000",
            lightVibrant: "#300000",
            muted: "#400000",
            darkMuted: "#500000",
            lightMuted: "#600000",
        });
        const okReq = { query: { url: "https://img.example/ok.jpg" } } as any;
        const okRes = createRes();
        await coverArtColorsHandler(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual(
            expect.objectContaining({ vibrant: "#100000" }),
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            expect.stringContaining("colors:"),
            2592000,
            expect.any(String),
        );

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: true,
            url: "https://img.example/crash.jpg",
            buffer: Buffer.from("img"),
        });
        mockExtractColorsFromImage.mockRejectedValueOnce(
            new Error("extract failed"),
        );
        const errReq = {
            query: { url: "https://img.example/crash.jpg" },
        } as any;
        const errRes = createRes();
        await invokeWithErrorHandler(coverArtColorsHandler, errReq, errRes);
        expect(errRes.statusCode).toBe(500);
    });

    it("continues color extraction when cache read fails", async () => {
        mockNormalizeExternalImageUrl.mockReturnValueOnce(
            "https://img.example/cover.png",
        );
        mockRedisGet.mockRejectedValueOnce(new Error("redis read failure"));
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: true,
            url: "https://img.example/cover.png",
            buffer: Buffer.from("image-pixels"),
        });

        const req = { query: { url: "https://img.example/cover.png" } } as any;
        const res = createRes();

        await coverArtColorsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({ vibrant: "#111111" }),
        );
        expect(mockFetchExternalImage).toHaveBeenCalledWith(
            expect.objectContaining({ url: "https://img.example/cover.png" }),
        );
    });

    it("continues color extraction when cache write fails", async () => {
        mockNormalizeExternalImageUrl.mockReturnValueOnce(
            "https://img.example/cover2.png",
        );
        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: true,
            url: "https://img.example/cover2.png",
            buffer: Buffer.from("image-pixels-2"),
        });
        mockRedisSetEx.mockRejectedValueOnce(new Error("redis write failure"));

        const req = { query: { url: "https://img.example/cover2.png" } } as any;
        const res = createRes();

        await coverArtColorsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({ vibrant: "#111111" }),
        );
    });

    it("filters artist-name genres and converts bigint counts", async () => {
        mockLoadGenreRadioAggregates.mockResolvedValueOnce([
            { genre: "electronic", count: 24 },
        ]);

        const req = {} as any;
        const res = createRes();
        await genresHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            genres: [{ genre: "electronic", count: 24 }],
        });

        mockLoadGenreRadioAggregates.mockRejectedValueOnce(
            new Error("genre query failed"),
        );
        const errRes = createRes();
        await invokeWithErrorHandler(genresHandler, req, errRes);
        expect(errRes.statusCode).toBe(500);
    });

    it("returns decades based on effective year and minimum track threshold", async () => {
        mockLoadDecadeRadioAggregates.mockResolvedValueOnce([
            { decade: 1990, count: 17 },
        ]);

        const req = {} as any;
        const res = createRes();
        await decadesHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            decades: [{ decade: 1990, count: 17 }],
        });

        mockLoadDecadeRadioAggregates.mockRejectedValueOnce(
            new Error("decade query failed"),
        );
        const errRes = createRes();
        await invokeWithErrorHandler(decadesHandler, req, errRes);
        expect(errRes.statusCode).toBe(500);
    });

    it("validates radio type and handles discovery unplayed and least-played fallback flows", async () => {
        const missingTypeReq = { query: {}, user: { id: "user-1" } } as any;
        const missingTypeRes = createRes();
        await radioHandler(missingTypeReq, missingTypeRes);
        expect(missingTypeRes.statusCode).toBe(400);
        expect(missingTypeRes.body).toEqual({
            error: "Radio type is required",
        });

        mockPrismaQueryRaw.mockResolvedValueOnce([{ id: "u1" }, { id: "u2" }]);
        mockTrackFindMany
            .mockResolvedValueOnce([]) // GH #46 diversify: pool artist lookup
            .mockResolvedValueOnce([
                createRadioTrack("u1"),
                createRadioTrack("u2"),
            ]);

        const discoveryReq = {
            query: { type: "discovery", limit: "2" },
            user: { id: "user-1" },
        } as any;
        const discoveryRes = createRes();
        await radioHandler(discoveryReq, discoveryRes);
        expect(discoveryRes.statusCode).toBe(200);
        expect(discoveryRes.body.tracks).toHaveLength(2);
        expectBoundedRandomQuery(mockPrismaQueryRaw.mock.calls[0], 8);
        expectNoUnboundedIdPoolFetch();

        mockPrismaQueryRaw
            .mockResolvedValueOnce([{ id: "u3" }])
            .mockResolvedValueOnce([{ id: "lp1" }, { id: "lp2" }]);
        mockTrackFindMany
            .mockResolvedValueOnce([]) // GH #46 diversify: pool artist lookup
            .mockResolvedValueOnce([
                createRadioTrack("lp1"),
                createRadioTrack("lp2"),
            ]);

        const fallbackReq = {
            query: { type: "discovery", limit: "2" },
            user: { id: "user-1" },
        } as any;
        const fallbackRes = createRes();
        await radioHandler(fallbackReq, fallbackRes);
        expectBoundedRandomQuery(mockPrismaQueryRaw.mock.calls[1], 8);
        expect(fallbackRes.statusCode).toBe(200);
        expect(fallbackRes.body.tracks.map((track: any) => track.id)).toEqual([
            "lp1",
            "lp2",
        ]);
    });

    it("builds workout radio using audio, genre table, and album-genre fallback sources", async () => {
        mockPrismaQueryRaw
            .mockResolvedValueOnce([{ id: "w1" }])
            .mockResolvedValueOnce([{ id: "w3" }]);
        mockTrackFindMany
            .mockResolvedValueOnce([]) // GH #46 diversify: pool artist lookup
            .mockResolvedValueOnce([
                createRadioTrack("w1"),
                createRadioTrack("w2"),
                createRadioTrack("w3"),
            ]);
        mockGenreFindMany.mockResolvedValueOnce([
            {
                trackGenres: [{ trackId: "w2" }],
            },
        ]);

        const req = {
            query: { type: "workout", limit: "3" },
            user: { id: "user-22" },
        } as any;
        const res = createRes();
        await radioHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.tracks).toHaveLength(3);
        expect(res.body.tracks.map((track: any) => track.id)).toEqual([
            "w1",
            "w2",
            "w3",
        ]);
        expectBoundedRandomQuery(mockPrismaQueryRaw.mock.calls[0], 12);
        expectBoundedRandomQuery(mockPrismaQueryRaw.mock.calls[1], 6);
        expectNoUnboundedIdPoolFetch();
    });

    it("supports artist radio validation, empty artist libraries, and mixed artist+similar queues", async () => {
        const missingArtistReq = {
            query: { type: "artist" },
            user: { id: "user-1" },
        } as any;
        const missingArtistRes = createRes();
        await radioHandler(missingArtistReq, missingArtistRes);
        expect(missingArtistRes.statusCode).toBe(400);
        expect(missingArtistRes.body).toEqual({
            error: "Artist ID required for artist radio",
        });

        mockTrackFindMany.mockResolvedValueOnce([]);
        const emptyArtistReq = {
            query: { type: "artist", value: "artist-main", limit: "5" },
            user: { id: "user-1" },
        } as any;
        const emptyArtistRes = createRes();
        await radioHandler(emptyArtistReq, emptyArtistRes);
        expect(emptyArtistRes.statusCode).toBe(200);
        expect(emptyArtistRes.body).toEqual({ tracks: [] });

        mockTrackFindMany
            .mockResolvedValueOnce([
                {
                    id: "a1",
                    bpm: 120,
                    energy: 0.8,
                    valence: 0.6,
                    danceability: 0.7,
                },
                {
                    id: "a2",
                    bpm: 126,
                    energy: 0.75,
                    valence: 0.58,
                    danceability: 0.72,
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: "s1",
                    artistId: "artist-sim-1",
                    bpm: 122,
                    energy: 0.78,
                    valence: 0.59,
                    danceability: 0.71,
                    album: { artistId: "artist-sim-1" },
                },
                {
                    id: "s2",
                    artistId: "artist-sim-1",
                    bpm: null,
                    energy: null,
                    valence: null,
                    danceability: null,
                    album: { artistId: "artist-sim-1" },
                },
            ])
            .mockResolvedValueOnce([
                createRadioTrack("a1", {
                    album: {
                        id: "album-a1",
                        title: "Album A1",
                        coverUrl: "a1.jpg",
                        artist: { id: "artist-main", name: "Main Artist" },
                    },
                }),
                createRadioTrack("a2", {
                    album: {
                        id: "album-a2",
                        title: "Album A2",
                        coverUrl: "a2.jpg",
                        artist: { id: "artist-main", name: "Main Artist" },
                    },
                }),
                createRadioTrack("s1", {
                    album: {
                        id: "album-s1",
                        title: "Album S1",
                        coverUrl: "s1.jpg",
                        artist: {
                            id: "artist-sim-1",
                            name: "Similar Artist 1",
                        },
                    },
                }),
                createRadioTrack("s2", {
                    album: {
                        id: "album-s2",
                        title: "Album S2",
                        coverUrl: "s2.jpg",
                        artist: {
                            id: "artist-sim-1",
                            name: "Similar Artist 1",
                        },
                    },
                }),
            ]);
        mockOwnedAlbumFindMany.mockResolvedValueOnce([
            { artistId: "artist-main" },
            { artistId: "artist-sim-1" },
            { artistId: "artist-sim-2" },
        ]);
        mockSimilarArtistFindMany.mockResolvedValueOnce([
            { toArtistId: "artist-sim-1", weight: 0.95 },
        ]);
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-main",
            genres: [],
            userGenres: [],
        });

        const mixedReq = {
            query: { type: "artist", value: "artist-main", limit: "4" },
            user: { id: "user-1" },
        } as any;
        const mixedRes = createRes();
        await radioHandler(mixedReq, mixedRes);
        expect(mixedRes.statusCode).toBe(200);
        expect(mixedRes.body.tracks.map((track: any) => track.id)).toEqual([
            "a1",
            "s1",
            "a2",
            "s2",
        ]);
    });

    it("caps overrepresented similar artists in artist radio results", async () => {
        const similarArtistByTrackId: Record<string, string> = {
            "sim-dom-1": "artist-sim-dominant",
            "sim-dom-2": "artist-sim-dominant",
            "sim-dom-3": "artist-sim-dominant",
            "sim-dom-4": "artist-sim-dominant",
            "sim-dom-5": "artist-sim-dominant",
            "sim-dom-6": "artist-sim-dominant",
            "sim-b-1": "artist-sim-b",
            "sim-b-2": "artist-sim-b",
            "sim-c-1": "artist-sim-c",
            "sim-c-2": "artist-sim-c",
            "sim-d-1": "artist-sim-d",
            "sim-d-2": "artist-sim-d",
        };

        mockTrackFindMany.mockImplementation(async (args: any) => {
            if (
                args.where?.album?.artistId === "artist-main" &&
                !args.where?.album?.artistId?.in
            ) {
                return [
                    {
                        id: "main-1",
                        bpm: 120,
                        energy: 0.8,
                        valence: 0.62,
                        danceability: 0.7,
                    },
                    {
                        id: "main-2",
                        bpm: 121,
                        energy: 0.82,
                        valence: 0.6,
                        danceability: 0.72,
                    },
                    {
                        id: "main-3",
                        bpm: 119,
                        energy: 0.78,
                        valence: 0.58,
                        danceability: 0.69,
                    },
                    {
                        id: "main-4",
                        bpm: 122,
                        energy: 0.79,
                        valence: 0.61,
                        danceability: 0.71,
                    },
                ];
            }

            if (
                Array.isArray(args.where?.album?.artistId?.in) &&
                args.select?.album?.select?.artistId
            ) {
                return [
                    {
                        id: "sim-dom-1",
                        bpm: 120,
                        energy: 0.81,
                        valence: 0.61,
                        danceability: 0.7,
                        album: { artistId: "artist-sim-dominant" },
                    },
                    {
                        id: "sim-dom-2",
                        bpm: 121,
                        energy: 0.8,
                        valence: 0.6,
                        danceability: 0.69,
                        album: { artistId: "artist-sim-dominant" },
                    },
                    {
                        id: "sim-dom-3",
                        bpm: 119,
                        energy: 0.79,
                        valence: 0.58,
                        danceability: 0.68,
                        album: { artistId: "artist-sim-dominant" },
                    },
                    {
                        id: "sim-dom-4",
                        bpm: 122,
                        energy: 0.78,
                        valence: 0.57,
                        danceability: 0.67,
                        album: { artistId: "artist-sim-dominant" },
                    },
                    {
                        id: "sim-dom-5",
                        bpm: 123,
                        energy: 0.77,
                        valence: 0.56,
                        danceability: 0.66,
                        album: { artistId: "artist-sim-dominant" },
                    },
                    {
                        id: "sim-dom-6",
                        bpm: 118,
                        energy: 0.76,
                        valence: 0.55,
                        danceability: 0.65,
                        album: { artistId: "artist-sim-dominant" },
                    },
                    {
                        id: "sim-b-1",
                        bpm: 119,
                        energy: 0.68,
                        valence: 0.54,
                        danceability: 0.63,
                        album: { artistId: "artist-sim-b" },
                    },
                    {
                        id: "sim-b-2",
                        bpm: 117,
                        energy: 0.67,
                        valence: 0.52,
                        danceability: 0.62,
                        album: { artistId: "artist-sim-b" },
                    },
                    {
                        id: "sim-c-1",
                        bpm: 116,
                        energy: 0.66,
                        valence: 0.51,
                        danceability: 0.61,
                        album: { artistId: "artist-sim-c" },
                    },
                    {
                        id: "sim-c-2",
                        bpm: 124,
                        energy: 0.65,
                        valence: 0.5,
                        danceability: 0.6,
                        album: { artistId: "artist-sim-c" },
                    },
                    {
                        id: "sim-d-1",
                        bpm: 115,
                        energy: 0.64,
                        valence: 0.49,
                        danceability: 0.59,
                        album: { artistId: "artist-sim-d" },
                    },
                    {
                        id: "sim-d-2",
                        bpm: 125,
                        energy: 0.63,
                        valence: 0.48,
                        danceability: 0.58,
                        album: { artistId: "artist-sim-d" },
                    },
                ];
            }

            if (Array.isArray(args.where?.id?.in) && args.include?.album) {
                return (args.where.id.in as string[]).map((id: string) => {
                    if (id.startsWith("main-")) {
                        return createRadioTrack(id, {
                            album: {
                                id: `album-${id}`,
                                title: `Main Album ${id}`,
                                coverUrl: `${id}.jpg`,
                                artist: {
                                    id: "artist-main",
                                    name: "Main Artist",
                                },
                            },
                        });
                    }

                    const similarArtistId = similarArtistByTrackId[id];
                    return createRadioTrack(id, {
                        album: {
                            id: `album-${id}`,
                            title: `Similar Album ${id}`,
                            coverUrl: `${id}.jpg`,
                            artist: {
                                id: similarArtistId,
                                name: `Similar ${similarArtistId}`,
                            },
                        },
                    });
                });
            }

            return [];
        });

        mockOwnedAlbumFindMany.mockResolvedValueOnce([
            { artistId: "artist-main" },
            { artistId: "artist-sim-dominant" },
            { artistId: "artist-sim-b" },
            { artistId: "artist-sim-c" },
            { artistId: "artist-sim-d" },
        ]);
        mockSimilarArtistFindMany.mockResolvedValueOnce([
            { toArtistId: "artist-sim-dominant", weight: 0.98 },
            { toArtistId: "artist-sim-b", weight: 0.72 },
            { toArtistId: "artist-sim-c", weight: 0.7 },
            { toArtistId: "artist-sim-d", weight: 0.68 },
        ]);

        const req = {
            query: { type: "artist", value: "artist-main", limit: "10" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();
        await radioHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.tracks).toHaveLength(10);

        const similarTracks = res.body.tracks.filter(
            (track: any) => track.artist.id !== "artist-main",
        );
        const dominantArtistTracks = similarTracks.filter(
            (track: any) => track.artist.id === "artist-sim-dominant",
        );
        expect(dominantArtistTracks.length).toBeLessThanOrEqual(2);
    });

    it("builds vibe radio queues with similarity scoring and layered fallbacks", async () => {
        const sourceTrack = {
            id: "source-track",
            title: "Source Track",
            bpm: 120,
            energy: 0.82,
            valence: 0.68,
            arousal: 0.7,
            danceability: 0.74,
            keyScale: "major",
            instrumentalness: 0.2,
            moodHappy: 0.78,
            moodSad: 0.12,
            moodRelaxed: 0.21,
            moodAggressive: 0.35,
            moodParty: 0.72,
            moodAcoustic: 0.2,
            moodElectronic: 0.62,
            danceabilityMl: 0.77,
            analysisMode: "enhanced",
            analysisVersion: "2.1b6-enhanced-v3.5",
            moodTags: ["energetic"],
            lastfmTags: ["rock"],
            essentiaGenres: ["alternative"],
            album: {
                id: "album-source",
                title: "Source Album",
                artistId: "artist-source",
                genres: ["rock"],
                artist: { id: "artist-source", name: "Source Artist" },
            },
        };
        mockTrackFindUnique
            .mockResolvedValueOnce(sourceTrack)
            .mockResolvedValueOnce({
                ...sourceTrack,
                trackGenres: [{ genre: { name: "rock" } }],
            });

        mockTrackFindMany.mockImplementation(async (args: any) => {
            if (
                args.where?.analysisStatus === "completed" &&
                Array.isArray(args.where?.id?.in)
            ) {
                return [
                    {
                        id: "an-1",
                        bpm: 121,
                        energy: 0.81,
                        valence: 0.66,
                        arousal: 0.69,
                        danceability: 0.73,
                        keyScale: "major",
                        moodTags: ["energetic"],
                        lastfmTags: ["rock"],
                        essentiaGenres: ["alternative"],
                        instrumentalness: 0.18,
                        moodHappy: 0.75,
                        moodSad: 0.14,
                        moodRelaxed: 0.23,
                        moodAggressive: 0.32,
                        moodParty: 0.7,
                        moodAcoustic: 0.2,
                        moodElectronic: 0.65,
                        danceabilityMl: 0.75,
                        analysisMode: "enhanced",
                        analysisVersion: "2.1b6-enhanced-v3.5",
                    },
                    {
                        id: "an-2",
                        bpm: 118,
                        energy: 0.76,
                        valence: 0.74,
                        arousal: 0.75,
                        danceability: 0.72,
                        keyScale: "minor",
                        moodTags: [],
                        lastfmTags: [],
                        essentiaGenres: [],
                        instrumentalness: 0.3,
                        moodHappy: 0.82,
                        moodSad: 0.8,
                        moodRelaxed: 0.81,
                        moodAggressive: 0.84,
                        moodParty: 0.79,
                        moodAcoustic: 0.78,
                        moodElectronic: 0.83,
                        danceabilityMl: 0.73,
                        analysisMode: "enhanced",
                        analysisVersion: "2.1b6-enhanced-v3.5",
                    },
                ];
            }
            if (
                args.where?.album?.artistId === "artist-source" &&
                Array.isArray(args.where?.id?.notIn)
            ) {
                return [{ id: "same-a1" }];
            }
            if (Array.isArray(args.where?.album?.artistId?.in)) {
                return [{ id: "sim-b1" }];
            }
            if (Array.isArray(args.where?.id?.in) && args.include?.album) {
                return (args.where.id.in as string[]).map(
                    (id: string, index: number) =>
                        createRadioTrack(id, {
                            trackGenres:
                                index === 0
                                    ? [{ genre: { name: "rock" } }]
                                    : [],
                        }),
                );
            }
            return [];
        });
        mockOwnedAlbumFindMany.mockResolvedValueOnce([
            { artistId: "artist-source" },
            { artistId: "artist-sim-1" },
        ]);
        mockSimilarArtistFindMany.mockResolvedValueOnce([
            { toArtistId: "artist-sim-1", weight: 0.9 },
        ]);
        mockLoadVibeRadioCandidateIds.mockResolvedValueOnce(["an-1", "an-2"]);
        mockPrismaQueryRaw
            .mockResolvedValueOnce([{ id: "genre-c1" }])
            .mockResolvedValueOnce(
                Array.from({ length: 50 }, (_unused, index) => ({
                    id: `rnd-d${index + 1}`,
                })),
            );

        const missingSourceReq = {
            query: { type: "vibe" },
            user: { id: "user-1" },
        } as any;
        const missingSourceRes = createRes();
        await radioHandler(missingSourceReq, missingSourceRes);
        expect(missingSourceRes.statusCode).toBe(400);
        expect(missingSourceRes.body).toEqual({
            error: "Track ID required for vibe matching",
        });

        const vibeReq = {
            query: { type: "vibe", value: "source-track", limit: "55" },
            user: { id: "user-1" },
        } as any;
        const vibeRes = createRes();
        await radioHandler(vibeReq, vibeRes);

        expect(vibeRes.statusCode).toBe(200);
        expect(vibeRes.body.tracks).toHaveLength(55);
        expect(vibeRes.body.sourceFeatures).toEqual(
            expect.objectContaining({
                bpm: 120,
                energy: 0.82,
                analysisMode: "enhanced",
            }),
        );
        expect(vibeRes.body.tracks[0]).toEqual(
            expect.objectContaining({
                id: expect.any(String),
                audioFeatures: expect.objectContaining({
                    bpm: expect.any(Number),
                }),
            }),
        );
        const sameArtistQuery = mockTrackFindMany.mock.calls.find(
            ([args]) => args.where?.album?.artistId === "artist-source",
        )?.[0];
        const similarArtistTracksQuery = mockTrackFindMany.mock.calls.find(
            ([args]) => Array.isArray(args.where?.album?.artistId?.in),
        )?.[0];
        expect(sameArtistQuery).toEqual(
            expect.objectContaining({
                select: { id: true },
                orderBy: { id: "asc" },
                take: 400,
            }),
        );
        expect(mockOwnedAlbumFindMany).toHaveBeenCalledWith({
            select: { artistId: true },
            distinct: ["artistId"],
            orderBy: { artistId: "asc" },
            take: 400,
        });
        expect(mockSimilarArtistFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                select: { toArtistId: true },
                orderBy: [{ weight: "desc" }, { toArtistId: "asc" }],
                take: 10,
            }),
        );
        expect(similarArtistTracksQuery).toEqual(
            expect.objectContaining({
                select: { id: true },
                orderBy: { id: "asc" },
                take: 400,
            }),
        );
        expectBoundedRandomQuery(mockPrismaQueryRaw.mock.calls[0], 55);
        expectBoundedRandomQuery(mockPrismaQueryRaw.mock.calls[1], 50);
    });

    it("covers favorites, decade, genre, mood, and all radio branches", async () => {
        mockPrismaQueryRaw.mockResolvedValueOnce([
            { id: "fav-1", play_count: 15n },
        ]);
        mockTrackFindMany
            .mockResolvedValueOnce([]) // GH #46 diversify: pool artist lookup
            .mockResolvedValueOnce([createRadioTrack("fav-1")]);
        const favoritesReq = {
            query: { type: "favorites", limit: "1" },
            user: { id: "user-1" },
        } as any;
        const favoritesRes = createRes();
        await radioHandler(favoritesReq, favoritesRes);
        expect(favoritesRes.statusCode).toBe(200);
        expect(favoritesRes.body.tracks.map((track: any) => track.id)).toEqual([
            "fav-1",
        ]);

        mockPrismaQueryRaw.mockResolvedValueOnce([]);
        mockPrismaQueryRaw.mockResolvedValueOnce([{ id: "rand-fav-1" }]);
        mockTrackFindMany
            .mockResolvedValueOnce([]) // GH #46 diversify: pool artist lookup
            .mockResolvedValueOnce([createRadioTrack("rand-fav-1")]);
        const fallbackFavoritesReq = {
            query: { type: "favorites", limit: "1" },
            user: { id: "user-1" },
        } as any;
        const fallbackFavoritesRes = createRes();
        await radioHandler(fallbackFavoritesReq, fallbackFavoritesRes);
        expect(fallbackFavoritesRes.statusCode).toBe(200);
        expect(fallbackFavoritesRes.body.tracks[0].id).toBe("rand-fav-1");
        expectBoundedRandomQuery(mockPrismaQueryRaw.mock.calls[2], 4);

        mockPrismaQueryRaw.mockResolvedValueOnce([{ id: "dec-1" }]);
        mockTrackFindMany
            .mockResolvedValueOnce([]) // GH #46 diversify: pool artist lookup
            .mockResolvedValueOnce([createRadioTrack("dec-1")]);
        const decadeReq = {
            query: { type: "decade", value: "1990", limit: "1" },
            user: { id: "user-1" },
        } as any;
        const decadeRes = createRes();
        await radioHandler(decadeReq, decadeRes);
        expect(decadeRes.statusCode).toBe(200);
        expect(decadeRes.body.tracks[0].id).toBe("dec-1");
        expectBoundedRandomQuery(mockPrismaQueryRaw.mock.calls[3], 4);

        mockPrismaQueryRaw.mockResolvedValueOnce([{ id: "genre-1" }]);
        mockTrackFindMany
            .mockResolvedValueOnce([]) // GH #46 diversify: pool artist lookup
            .mockResolvedValueOnce([createRadioTrack("genre-1")]);
        const genreReq = {
            query: { type: "genre", value: "rock", limit: "1" },
            user: { id: "user-1" },
        } as any;
        const genreRes = createRes();
        await radioHandler(genreReq, genreRes);
        expect(genreRes.statusCode).toBe(200);
        expect(genreRes.body.tracks[0].id).toBe("genre-1");

        mockPrismaQueryRaw.mockResolvedValueOnce([{ id: "mood-1" }]);
        mockTrackFindMany
            .mockResolvedValueOnce([]) // GH #46 diversify: pool artist lookup
            .mockResolvedValueOnce([createRadioTrack("mood-1")]);
        const moodReq = {
            query: { type: "mood", value: "chill", limit: "1" },
            user: { id: "user-1" },
        } as any;
        const moodRes = createRes();
        await radioHandler(moodReq, moodRes);
        expect(moodRes.statusCode).toBe(200);
        expect(moodRes.body.tracks[0].id).toBe("mood-1");
        expectBoundedRandomQuery(mockPrismaQueryRaw.mock.calls[5], 4);

        mockPrismaQueryRaw.mockResolvedValueOnce([{ id: "mood-2" }]);
        mockTrackFindMany
            .mockResolvedValueOnce([]) // GH #46 diversify: pool artist lookup
            .mockResolvedValueOnce([createRadioTrack("mood-2")]);
        const defaultMoodReq = {
            query: { type: "mood", value: "obscure-tag", limit: "1" },
            user: { id: "user-1" },
        } as any;
        const defaultMoodRes = createRes();
        await radioHandler(defaultMoodReq, defaultMoodRes);
        expect(defaultMoodRes.statusCode).toBe(200);
        expect(defaultMoodRes.body.tracks[0].id).toBe("mood-2");

        const additionalMoodCases: Array<[string, string]> = [
            ["high-energy", "mood-high"],
            ["happy", "mood-happy"],
            ["melancholy", "mood-melancholy"],
            ["dance", "mood-dance"],
            ["acoustic", "mood-acoustic"],
            ["instrumental", "mood-instrumental"],
        ];
        for (const [moodValue, trackId] of additionalMoodCases) {
            mockPrismaQueryRaw.mockResolvedValueOnce([{ id: trackId }]);
            mockTrackFindMany
                .mockResolvedValueOnce([]) // GH #46 diversify: pool artist lookup
                .mockResolvedValueOnce([createRadioTrack(trackId)]);
            const req = {
                query: { type: "mood", value: moodValue, limit: "1" },
                user: { id: "user-1" },
            } as any;
            const res = createRes();
            await radioHandler(req, res);
            expect(res.statusCode).toBe(200);
            expect(res.body.tracks[0].id).toBe(trackId);
        }

        mockPrismaQueryRaw.mockResolvedValueOnce([]);
        const emptyAllReq = {
            query: { type: "all", limit: "5" },
            user: { id: "user-1" },
        } as any;
        const emptyAllRes = createRes();
        await radioHandler(emptyAllReq, emptyAllRes);
        expect(emptyAllRes.statusCode).toBe(200);
        expect(emptyAllRes.body).toEqual({ tracks: [] });
        expectBoundedRandomQuery(
            mockPrismaQueryRaw.mock.calls[
                mockPrismaQueryRaw.mock.calls.length - 1
            ],
            20,
        );
        expectNoUnboundedIdPoolFetch();
    });

    it.each([
        ["%", "%\\%%"],
        ["_", "%\\_%"],
        ["rock", "%rock%"],
    ])(
        "escapes genre LIKE input %s as a literal pattern",
        async (value, pattern) => {
            mockPrismaQueryRaw
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            const req = {
                query: { type: "genre", value, limit: "1" },
                user: { id: "user-1" },
            } as any;
            const res = createRes();
            await radioHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ tracks: [] });
            const likeValues = mockPrismaQueryRaw.mock.calls
                .flatMap((call) => call.slice(1))
                .filter((boundValue) => boundValue === pattern);
            expect(likeValues).toHaveLength(4);
        },
    );

    it("returns liked radio tracks using deterministic liked-order membership", async () => {
        mockLikedTrackFindMany.mockResolvedValueOnce([
            { trackId: "liked-2" },
            { trackId: "liked-1" },
        ]);
        mockTrackFindMany.mockResolvedValueOnce([
            createRadioTrack("liked-1", {
                loudnessLufs: -17.2,
                truePeakDb: -1.4,
                album: {
                    id: "album-liked-1",
                    title: "Album liked-1",
                    coverUrl: "cover-liked-1.jpg",
                    albumLoudnessLufs: -18.3,
                    albumTruePeakDb: -0.9,
                    artist: {
                        id: "artist-liked-1",
                        name: "Artist liked-1",
                    },
                },
            }),
            createRadioTrack("liked-2"),
        ]);

        const req = {
            query: { type: "liked", limit: "5000" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();
        await radioHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockLikedTrackFindMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                track: {
                    removedAt: null,
                    ...visibleAlbumRelationWhere,
                    AND: expect.any(Array),
                },
            },
            select: { trackId: true },
            orderBy: { likedAt: "desc" },
            take: 5000,
        });
        expect(res.body.tracks.map((track: any) => track.id)).toEqual([
            "liked-2",
            "liked-1",
        ]);
        expect(res.body.tracks[1]).toEqual(
            expect.objectContaining({
                loudnessLufs: -17.2,
                truePeakDb: -1.4,
                album: expect.objectContaining({
                    albumLoudnessLufs: -18.3,
                    albumTruePeakDb: -0.9,
                }),
            }),
        );
        expect(mockShuffleArray).not.toHaveBeenCalled();
    });

    it("uses genre-based artist fallback when lastfm similar artists are insufficient", async () => {
        mockGetMergedGenres.mockImplementation(
            (artist: any) => artist?.genres || [],
        );
        mockTrackFindMany.mockImplementation(async (args: any) => {
            if (
                args.where?.album?.artistId === "artist-main" &&
                !args.where?.album?.artistId?.in
            ) {
                return [
                    {
                        id: "main-1",
                        bpm: 120,
                        energy: 0.8,
                        valence: 0.65,
                        danceability: 0.72,
                    },
                    {
                        id: "main-2",
                        bpm: 124,
                        energy: 0.77,
                        valence: 0.6,
                        danceability: 0.7,
                    },
                ];
            }
            if (Array.isArray(args.where?.album?.artistId?.in)) {
                return [
                    {
                        id: "genre-sim-1",
                        artistId: "artist-genre-1",
                        bpm: 122,
                        energy: 0.74,
                        valence: 0.59,
                        danceability: 0.68,
                        album: { artistId: "artist-genre-1" },
                    },
                    {
                        id: "genre-sim-2",
                        artistId: "artist-genre-2",
                        bpm: 118,
                        energy: 0.65,
                        valence: 0.55,
                        danceability: 0.6,
                        album: { artistId: "artist-genre-2" },
                    },
                ];
            }
            if (Array.isArray(args.where?.id?.in) && args.include?.album) {
                return [
                    createRadioTrack("main-1", {
                        album: {
                            id: "album-main-1",
                            title: "Main 1",
                            coverUrl: "main-1.jpg",
                            artist: { id: "artist-main", name: "Main Artist" },
                        },
                    }),
                    createRadioTrack("main-2", {
                        album: {
                            id: "album-main-2",
                            title: "Main 2",
                            coverUrl: "main-2.jpg",
                            artist: { id: "artist-main", name: "Main Artist" },
                        },
                    }),
                    createRadioTrack("genre-sim-1", {
                        album: {
                            id: "album-genre-sim-1",
                            title: "Genre Sim",
                            coverUrl: "genre-sim-1.jpg",
                            artist: {
                                id: "artist-genre-1",
                                name: "Genre Similar",
                            },
                        },
                    }),
                    createRadioTrack("genre-sim-2", {
                        album: {
                            id: "album-genre-sim-2",
                            title: "Genre Sim 2",
                            coverUrl: "genre-sim-2.jpg",
                            artist: {
                                id: "artist-genre-2",
                                name: "Genre Similar 2",
                            },
                        },
                    }),
                ];
            }
            return [];
        });
        mockOwnedAlbumFindMany.mockResolvedValueOnce([
            { artistId: "artist-main" },
            { artistId: "artist-genre-1" },
            { artistId: "artist-genre-2" },
        ]);
        mockSimilarArtistFindMany.mockResolvedValueOnce([]);
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-main",
            genres: ["rock"],
            userGenres: [],
        });
        mockArtistFindMany.mockResolvedValueOnce([
            {
                id: "artist-genre-1",
                genres: ["alt rock", "rock"],
                userGenres: [],
            },
            { id: "artist-genre-2", genres: ["rock"], userGenres: [] },
        ]);

        const req = {
            query: { type: "artist", value: "artist-main", limit: "4" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();
        await radioHandler(req, res);

        expect(mockArtistFindMany).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body.tracks.map((track: any) => track.id)).toEqual([
            "main-1",
            "genre-sim-1",
            "genre-sim-2",
            "main-2",
        ]);
    });

    it("handles vibe not-found and top-level radio failures", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(null);
        const missingTrackReq = {
            query: { type: "vibe", value: "missing-track", limit: "3" },
            user: { id: "user-1" },
        } as any;
        const missingTrackRes = createRes();
        await radioHandler(missingTrackReq, missingTrackRes);
        expect(missingTrackRes.statusCode).toBe(404);
        expect(missingTrackRes.body).toEqual({ error: "Track not found" });

        mockPrismaQueryRaw.mockRejectedValueOnce(new Error("radio explosion"));
        const errorReq = {
            query: { type: "all", limit: "2" },
            user: { id: "user-1" },
        } as any;
        const errorRes = createRes();
        await invokeWithErrorHandler(radioHandler, errorReq, errorRes);
        expect(errorRes.statusCode).toBe(500);
    });
});

describe("library album cover and media route edge coverage", () => {
    const albumCoverHandler = getFinalHandler("get", "/album-cover/:mbid");
    const audioInfoHandler = getHandler("get", "/tracks/:id/audio-info", 1);
    const trackStreamHandler = getHandler("get", "/tracks/:id/stream");

    beforeEach(() => {
        jest.clearAllMocks();
        mockTrackFindUnique.mockReset();
        mockPlayFindFirst.mockReset();
        mockPlayCreate.mockReset();
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
        (config.music as any).musicPath = "/music";
        (config.music as any).transcodeCachePath = "/tmp/soundspan-cache";
        (config.music as any).transcodeCacheMaxGb = 1;

        mockTrackFindUnique.mockResolvedValue(createNativeTrack());
        mockPlayFindFirst.mockResolvedValue(null);
        mockPlayCreate.mockResolvedValue({});
        mockUserSettingsFindUnique.mockResolvedValue({
            playbackQuality: "medium",
        });
        mockStreamGetStreamFilePath.mockResolvedValue({
            filePath: "/tmp/stream.flac",
            mimeType: "audio/flac",
        });
        mockStreamWithRangeSupport.mockResolvedValue(undefined);
        mockStreamDestroy.mockImplementation(() => undefined);
    });

    it("returns 400 for temporary MBID album-cover requests", async () => {
        const req = { params: { mbid: "temp-album-1" } } as any;
        const res = createRes();

        await albumCoverHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Valid MBID required" });
        expect(mockCoverArtGetCoverArt).not.toHaveBeenCalled();
    });

    it("returns 204 when no album cover exists in archive", async () => {
        mockCoverArtGetCoverArt.mockResolvedValue(null);

        const req = { params: { mbid: "mbid-123" } } as any;
        const res = createRes();

        await albumCoverHandler(req, res);

        expect(res.statusCode).toBe(204);
        expect(mockCoverArtGetCoverArt).toHaveBeenCalledWith("mbid-123");
        expect(res.body).toBeUndefined();
    });

    it("maps album-cover lookup failures to 500", async () => {
        mockCoverArtGetCoverArt.mockRejectedValue(new Error("caa-down"));

        const req = { params: { mbid: "mbid-down" } } as any;
        const res = createRes();

        await invokeWithErrorHandler(albumCoverHandler, req, res);

        expect(res.statusCode).toBe(500);
    });

    it("returns 404 when audio info track is missing", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(null);

        const req = {
            params: { id: "missing-track" },
            user: { id: "user-1" },
            query: {},
        } as any;
        const res = createRes();

        await audioInfoHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Track not found" });
    });

    it("returns 404 for audio-info when file does not exist", async () => {
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);

        mockTrackFindUnique.mockResolvedValueOnce({
            filePath: "missing/track.flac",
        });

        const req = {
            params: { id: "ghost-track" },
            user: { id: "user-1" },
            query: {},
        } as any;
        const res = createRes();

        await audioInfoHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "File not found on disk" });

        existsSpy.mockRestore();
    });

    it("extracts audio metadata and maps fields correctly", async () => {
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);

        mockTrackFindUnique.mockResolvedValueOnce({
            filePath: "library/Track.flac",
        });
        mockParseFile.mockResolvedValueOnce({
            format: {
                codec: "FLAC",
                bitrate: 320000,
                sampleRate: 44100,
                bitsPerSample: 24,
                lossless: true,
                numberOfChannels: 2,
            },
        });

        const req = {
            params: { id: "real-track" },
            user: { id: "user-1" },
            query: {},
        } as any;
        const res = createRes();

        await audioInfoHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            codec: "FLAC",
            bitrate: 320,
            sampleRate: 44100,
            bitDepth: 24,
            lossless: true,
            channels: 2,
        });

        existsSpy.mockRestore();
    });

    it("reuses cached audio metadata for repeated requests to the same track identity", async () => {
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);

        mockTrackFindUnique.mockResolvedValue({
            filePath: "library/Cached-track.flac",
            fileModified: new Date("2026-01-01T00:00:00.000Z"),
        });
        mockParseFile.mockResolvedValue({
            format: {
                codec: "FLAC",
                bitrate: 768000,
                sampleRate: 96000,
                bitsPerSample: 24,
                lossless: true,
                numberOfChannels: 2,
            },
        });

        const req = {
            params: { id: "cache-hit-track" },
            user: { id: "user-1" },
            query: {},
        } as any;
        const firstRes = createRes();
        await audioInfoHandler(req, firstRes);

        const secondRes = createRes();
        await audioInfoHandler(req, secondRes);

        expect(firstRes.statusCode).toBe(200);
        expect(secondRes.statusCode).toBe(200);
        expect(secondRes.body).toEqual(firstRes.body);
        expect(mockParseFile).toHaveBeenCalledTimes(1);

        existsSpy.mockRestore();
    });

    it("returns stream 401 when authentication is missing", async () => {
        const req = { params: { id: "track-1" }, query: {} } as any;
        const res = createRes();

        await trackStreamHandler(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Unauthorized" });
    });

    it("returns 404 for missing tracks during stream", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(null);

        const req = {
            params: { id: "missing-track" },
            user: { id: "user-1" },
            query: {},
        } as any;
        const res = createRes();

        await trackStreamHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Track not found" });
    });

    it("returns 404 for stream requests without a file path", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-fileless",
            filePath: null,
            fileModified: new Date(),
            title: "Track without file",
        });

        const req = {
            params: { id: "track-fileless" },
            user: { id: "user-1" },
            query: {},
        } as any;
        const res = createRes();

        await trackStreamHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Track not available" });
    });

    it("streams native file and logs play activity when first playback", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-stream",
            title: "Streamed Track",
            filePath: "Artists/Track.flac",
            fileModified: new Date("2024-01-01T00:00:00.000Z"),
        });
        mockUserSettingsFindUnique.mockResolvedValueOnce(null);
        mockPlayFindFirst.mockResolvedValueOnce(null);
        mockPlayCreate.mockResolvedValueOnce({});
        mockStreamGetStreamFilePath.mockResolvedValueOnce({
            filePath: "/tmp/stream.flac",
            mimeType: "audio/flac",
        });
        mockStreamWithRangeSupport.mockResolvedValueOnce(undefined);

        const req = {
            params: { id: "track-stream" },
            user: { id: "user-1" },
            query: {},
        } as any;
        const res = createRes();

        await trackStreamHandler(req, res);

        expect(mockTrackFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    id: "track-stream",
                    removedAt: null,
                    ...visibleAlbumRelationWhere,
                },
            }),
        );
        expect(mockPlayFindFirst).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                trackId: "track-stream",
                playedAt: { gte: expect.any(Date) },
            },
            orderBy: { playedAt: "desc" },
        });
        expect(mockPlayCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: {
                    userId: "user-1",
                    trackId: "track-stream",
                },
            }),
        );
        expect(mockStreamGetStreamFilePath).toHaveBeenCalledWith(
            "track-stream",
            "medium",
            expect.any(Date),
            expect.stringContaining("Artists/Track.flac"),
        );
        expect(mockStreamWithRangeSupport).toHaveBeenCalledWith(
            req,
            res,
            "/tmp/stream.flac",
            "audio/flac",
        );
        expect(mockStreamDestroy).toHaveBeenCalled();
    });

    it("falls back to original quality when FFmpeg is unavailable", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-stream-fallback",
            title: "Fallback Track",
            filePath: "Fallback/Track.flac",
            fileModified: new Date("2024-01-02T00:00:00.000Z"),
        });
        mockUserSettingsFindUnique.mockResolvedValueOnce({
            playbackQuality: "high",
        });
        mockPlayFindFirst.mockResolvedValueOnce({});
        mockStreamGetStreamFilePath
            .mockRejectedValueOnce({ code: "FFMPEG_NOT_FOUND" })
            .mockResolvedValueOnce({
                filePath: "/tmp/stream-original.flac",
                mimeType: "audio/flac",
            });
        mockStreamWithRangeSupport.mockResolvedValueOnce(undefined);

        const req = {
            params: { id: "track-stream-fallback" },
            user: { id: "user-1" },
            query: { quality: "high" },
        } as any;
        const res = createRes();

        await trackStreamHandler(req, res);

        expect(mockStreamGetStreamFilePath).toHaveBeenNthCalledWith(
            1,
            "track-stream-fallback",
            "high",
            expect.any(Date),
            expect.stringContaining("Fallback/Track.flac"),
        );
        expect(mockStreamGetStreamFilePath).toHaveBeenNthCalledWith(
            2,
            "track-stream-fallback",
            "original",
            expect.any(Date),
            expect.stringContaining("Fallback/Track.flac"),
        );
        expect(mockStreamWithRangeSupport).toHaveBeenCalledWith(
            req,
            res,
            "/tmp/stream-original.flac",
            "audio/flac",
        );
        expect(mockStreamDestroy).toHaveBeenCalled();
    });

    it("returns 500 when stream file preparation fails for non-recoverable errors", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-stream-error",
            title: "Broken Track",
            filePath: "Broken/Track.flac",
            fileModified: new Date("2024-01-03T00:00:00.000Z"),
        });
        mockUserSettingsFindUnique.mockResolvedValueOnce({
            playbackQuality: "low",
        });
        mockPlayFindFirst.mockResolvedValueOnce(null);
        mockPlayCreate.mockResolvedValueOnce({});
        mockStreamGetStreamFilePath.mockRejectedValueOnce(
            new Error("stream setup failed"),
        );

        const req = {
            params: { id: "track-stream-error" },
            user: { id: "user-1" },
            query: {},
        } as any;
        const res = createRes();

        await trackStreamHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to stream track" });
    });
});

describe("library unexpected-failure tails return 500 via the shared error path", () => {
    // Catch-tail behavior pins for the routes that had no 500-path coverage
    // before the F1 asyncHandler migration: an unexpected service/database
    // rejection must surface as a 500 response (not a hang, not a leak of a
    // different status). Written pre-migration and kept identical across it.
    const artistByIdHandler = getHandler("get", "/artists/:id");
    const albumByIdHandler = getHandler("get", "/albums/:id");
    const likedPlaylistHandler = getHandler("get", "/liked");
    const trackPreferenceHandler = getHandler("get", "/tracks/:id/preference");
    const setTrackPreferenceHandler = getHandler(
        "post",
        "/tracks/:id/preference",
    );
    const setAlbumPreferenceHandler = getHandler(
        "post",
        "/albums/:id/preference",
    );

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("returns 500 when the artist lookup rejects", async () => {
        mockArtistFindFirst.mockRejectedValueOnce(new Error("db down"));

        const req = { params: { id: "artist-1" }, query: {} } as any;
        const res = createRes();
        await invokeWithErrorHandler(artistByIdHandler, req, res);

        expect(res.statusCode).toBe(500);
    });

    it("returns 500 when the album lookup rejects", async () => {
        mockAlbumFindFirst.mockRejectedValueOnce(new Error("db down"));

        const req = { params: { id: "album-1" }, query: {} } as any;
        const res = createRes();
        await invokeWithErrorHandler(albumByIdHandler, req, res);

        expect(res.statusCode).toBe(500);
    });

    it("returns 500 when the liked-playlist aggregation rejects", async () => {
        mockLikedTrackCount.mockRejectedValueOnce(new Error("db down"));

        const req = { user: { id: "user-1" }, query: {} } as any;
        const res = createRes();
        await invokeWithErrorHandler(likedPlaylistHandler, req, res);

        expect(res.statusCode).toBe(500);
    });

    it("returns 500 when the track-preference lookup rejects", async () => {
        mockTrackFindUnique.mockRejectedValueOnce(new Error("db down"));

        const req = {
            user: { id: "user-1" },
            params: { id: "track-1" },
        } as any;
        const res = createRes();
        await invokeWithErrorHandler(trackPreferenceHandler, req, res);

        expect(res.statusCode).toBe(500);
    });

    it("returns 500 when setting a track preference rejects", async () => {
        mockTrackFindUnique.mockRejectedValueOnce(new Error("db down"));

        const req = {
            user: { id: "user-1" },
            params: { id: "track-1" },
            body: { signal: "thumbs_up" },
        } as any;
        const res = createRes();
        await invokeWithErrorHandler(setTrackPreferenceHandler, req, res);

        expect(res.statusCode).toBe(500);
    });

    it("returns 500 when setting an album preference rejects", async () => {
        mockAlbumFindFirst.mockRejectedValueOnce(new Error("db down"));

        const req = {
            user: { id: "user-1" },
            params: { id: "album-1" },
            body: { signal: "thumbs_up" },
        } as any;
        const res = createRes();
        await invokeWithErrorHandler(setAlbumPreferenceHandler, req, res);

        expect(res.statusCode).toBe(500);
    });
});
