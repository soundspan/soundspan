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

    it("returns recently listened artists, audiobooks, and deduplicated podcasts", async () => {
        mockPlayFindMany.mockResolvedValueOnce([
            {
                playedAt: new Date("2025-01-03T00:00:00.000Z"),
                track: {
                    album: {
                        artist: {
                            id: "artist-1",
                            mbid: "mbid-1",
                            name: "Artist One",
                            heroUrl: "hero-1.jpg",
                            userHeroUrl: null,
                        },
                    },
                },
            },
            {
                playedAt: new Date("2025-01-02T00:00:00.000Z"),
                track: {
                    album: {
                        artist: {
                            id: "artist-2",
                            mbid: "mbid-2",
                            name: "Artist Two",
                            heroUrl: "hero-2.jpg",
                            userHeroUrl: "user-hero-2.jpg",
                        },
                    },
                },
            },
        ]);
        mockAudiobookProgressFindMany.mockResolvedValueOnce([
            {
                audiobookshelfId: "book-1",
                title: "Book One",
                coverUrl: "covers/book-1.jpg",
                author: "Author One",
                currentTime: 120,
                duration: 240,
                lastPlayedAt: new Date("2025-01-05T00:00:00.000Z"),
            },
        ]);
        mockPodcastProgressFindMany.mockResolvedValueOnce([
            {
                episodeId: "ep-1",
                currentTime: 75,
                duration: 150,
                lastPlayedAt: new Date("2025-01-04T00:00:00.000Z"),
                episode: {
                    podcast: {
                        id: "pod-1",
                        title: "Podcast One",
                        author: "Host One",
                        imageUrl: "pod-1.jpg",
                    },
                },
            },
            {
                episodeId: "ep-2",
                currentTime: 10,
                duration: 100,
                lastPlayedAt: new Date("2024-12-30T00:00:00.000Z"),
                episode: {
                    podcast: {
                        id: "pod-1",
                        title: "Podcast One",
                        author: "Host One",
                        imageUrl: "pod-1.jpg",
                    },
                },
            },
        ]);
        mockOwnedAlbumGroupBy.mockResolvedValueOnce([
            { artistId: "artist-1", _count: { rgMbid: 7 } },
            { artistId: "artist-2", _count: { rgMbid: 2 } },
        ]);

        const req = {
            query: { limit: "3" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await recentlyListenedHandler(req, res);

        expect(mockPlayFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                take: 9,
                where: expect.objectContaining({ userId: "user-1" }),
            }),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.items).toEqual([
            expect.objectContaining({
                type: "audiobook",
                id: "book-1",
                coverArt: "audiobook__covers/book-1.jpg",
                progress: 50,
            }),
            expect.objectContaining({
                type: "podcast",
                id: "pod-1",
                episodeId: "ep-1",
                progress: 50,
            }),
            expect.objectContaining({
                type: "artist",
                id: "artist-1",
                coverArt: "hero-1.jpg",
                albumCount: 7,
            }),
        ]);
    });

    it("uses the default recently-listened limit for invalid input", async () => {
        const req = {
            query: { limit: "abc" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await recentlyListenedHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockPlayFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 30 }),
        );
        expect(mockAudiobookProgressFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 4 }),
        );
        expect(mockPodcastProgressFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 20 }),
        );
    });

    it("clamps the recently-listened limit before querying", async () => {
        const req = {
            query: { limit: "1000000" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await recentlyListenedHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockPlayFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 300 }),
        );
        expect(mockAudiobookProgressFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 34 }),
        );
        expect(mockPodcastProgressFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 200 }),
        );
    });

    it("returns 500 when recently listened aggregation fails", async () => {
        mockPlayFindMany.mockRejectedValueOnce(new Error("play query failed"));
        const req = {
            query: { limit: "5" },
            user: { id: "user-2" },
        } as any;
        const res = createRes();

        await invokeWithErrorHandler(recentlyListenedHandler, req, res);

        expect(res.statusCode).toBe(500);
    });

    it("returns recently added artists with dedupe and album counts", async () => {
        mockAlbumFindMany.mockResolvedValueOnce([
            {
                id: "album-1",
                title: "Album 1",
                artist: {
                    id: "artist-1",
                    mbid: "mbid-1",
                    name: "Artist One",
                    heroUrl: "hero-1.jpg",
                    userHeroUrl: null,
                },
            },
            {
                id: "album-2",
                title: "Album 2",
                artist: {
                    id: "artist-1",
                    mbid: "mbid-1",
                    name: "Artist One",
                    heroUrl: "hero-1.jpg",
                    userHeroUrl: null,
                },
            },
            {
                id: "album-3",
                title: "Album 3",
                artist: {
                    id: "artist-2",
                    mbid: "mbid-2",
                    name: "Artist Two",
                    heroUrl: "hero-2.jpg",
                    userHeroUrl: "user-hero-2.jpg",
                },
            },
        ]);
        mockAlbumGroupBy.mockResolvedValueOnce([
            { artistId: "artist-1", _count: { id: 3 } },
            { artistId: "artist-2", _count: { id: 1 } },
        ]);

        const req = { query: { limit: "2" } } as any;
        const res = createRes();

        await recentlyAddedHandler(req, res);

        expect(mockAlbumFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    location: "LIBRARY",
                }),
                take: 20,
            }),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.artists).toEqual([
            expect.objectContaining({
                id: "artist-1",
                coverArt: "hero-1.jpg",
                albumCount: 3,
            }),
            expect.objectContaining({
                id: "artist-2",
                coverArt: "user-hero-2.jpg",
                albumCount: 1,
            }),
        ]);
    });

    it("returns 500 when recently added query fails", async () => {
        mockAlbumFindMany.mockRejectedValueOnce(
            new Error("album query failed"),
        );
        const req = { query: { limit: "3" } } as any;
        const res = createRes();

        await invokeWithErrorHandler(recentlyAddedHandler, req, res);

        expect(res.statusCode).toBe(500);
    });

    it("uses transaction-backed artist list with image cache and cursor output", async () => {
        const txArtistFindMany = jest.fn().mockResolvedValue([
            {
                id: "artist-1",
                mbid: "mbid-1",
                name: "Artist One",
                heroUrl: "hero-1.jpg",
                userHeroUrl: null,
                libraryAlbumCount: 4,
                discoveryAlbumCount: 2,
                totalTrackCount: 44,
            },
            {
                id: "artist-2",
                mbid: "mbid-2",
                name: "Artist Two",
                heroUrl: "hero-2.jpg",
                userHeroUrl: null,
                libraryAlbumCount: 1,
                discoveryAlbumCount: 0,
                totalTrackCount: 11,
            },
        ]);
        const txArtistCount = jest.fn().mockResolvedValue(2);
        mockPrismaTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                artist: {
                    findMany: txArtistFindMany,
                    count: txArtistCount,
                },
            }),
        );
        mockGetArtistImagesBatch.mockResolvedValueOnce(
            new Map([["artist-1", "cached-artist-1.jpg"]]),
        );

        const req = {
            query: {
                query: "art",
                filter: "all",
                limit: "2",
                offset: "1",
                sortBy: "tracks",
            },
        } as any;
        const res = createRes();

        await artistsHandler(req, res);

        expect(mockPrismaTransaction).toHaveBeenCalled();
        expect(txArtistFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: [
                        { libraryAlbumCount: { gt: 0 } },
                        { discoveryAlbumCount: { gt: 0 } },
                        { remoteTrackCount: { gt: 0 } },
                        { peerId: { not: null } },
                    ],
                    name: { contains: "art", mode: "insensitive" },
                }),
                take: 2,
                skip: 1,
                orderBy: { totalTrackCount: "desc" },
            }),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            artists: [
                {
                    id: "artist-1",
                    mbid: "mbid-1",
                    name: "Artist One",
                    heroUrl: "cached-artist-1.jpg",
                    coverArt: "cached-artist-1.jpg",
                    albumCount: 6,
                    trackCount: 44,
                },
                {
                    id: "artist-2",
                    mbid: "mbid-2",
                    name: "Artist Two",
                    heroUrl: "hero-2.jpg",
                    coverArt: "hero-2.jpg",
                    albumCount: 1,
                    trackCount: 11,
                },
            ],
            total: 2,
            offset: 1,
            limit: 2,
            nextCursor: "artist-2",
        });
    });

    it("applies cursor pagination for discovery artist filtering", async () => {
        const txArtistFindMany = jest.fn().mockResolvedValue([
            {
                id: "artist-3",
                mbid: "mbid-3",
                name: "Discovery Artist",
                heroUrl: null,
                userHeroUrl: null,
                libraryAlbumCount: 0,
                discoveryAlbumCount: 3,
                totalTrackCount: 9,
            },
        ]);
        const txArtistCount = jest.fn().mockResolvedValue(1);
        mockPrismaTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                artist: {
                    findMany: txArtistFindMany,
                    count: txArtistCount,
                },
            }),
        );

        const req = {
            query: {
                filter: "discovery",
                query: "disco",
                cursor: "artist-1",
                limit: "5",
            },
        } as any;
        const res = createRes();

        await artistsHandler(req, res);

        expect(txArtistFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    discoveryAlbumCount: { gt: 0 },
                    libraryAlbumCount: 0,
                    name: { contains: "disco", mode: "insensitive" },
                }),
                cursor: { id: "artist-1" },
                skip: 1,
            }),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.nextCursor).toBe(null);
    });

    it("returns 500 for artist list transaction errors", async () => {
        mockPrismaTransaction.mockRejectedValueOnce(new Error("tx failed"));
        const req = { query: {} } as any;
        const res = createRes();

        await artistsHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to fetch artists",
        });
        expect(JSON.stringify(res.body)).not.toContain("tx failed");
    });

    it("hydrates artist detail with MBID resolution, discography, top tracks, and enriched similar artists", async () => {
        mockArtistFindFirst.mockResolvedValueOnce({
            id: "artist-1",
            name: "Artist One",
            mbid: "temp-artist-one",
            heroUrl: "hero-original.jpg",
            userHeroUrl: null,
            similarArtistsJson: [
                { name: "Similar One", mbid: "sim-1", match: 0.93 },
                { name: "Similar Two", mbid: null, match: 0.61 },
            ],
            ownedAlbums: [{ rgMbid: "rg-db-same" }],
            albums: [
                {
                    id: "album-db-1",
                    title: "Owned Album",
                    rgMbid: "rg-db-same",
                    location: "LIBRARY",
                    year: 2010,
                    coverUrl: "db-cover.jpg",
                    tracks: [
                        {
                            id: "track-1",
                            title: "Song One",
                            loudnessLufs: -16.7,
                            truePeakDb: -1.1,
                            album: {
                                id: "album-db-1",
                                title: "Owned Album",
                                coverUrl: "db-cover.jpg",
                                albumLoudnessLufs: -17.5,
                                albumTruePeakDb: -0.7,
                            },
                        },
                    ],
                },
                {
                    id: "album-catalog",
                    title: "Catalog Skeleton",
                    rgMbid: "rg-catalog",
                    location: "CATALOG",
                    year: 2013,
                    coverUrl: null,
                    tracks: [],
                },
            ],
        });
        mockMusicBrainzSearchArtist.mockResolvedValueOnce([
            { id: "artist-real-mbid" },
        ]);
        mockArtistFindUnique.mockResolvedValueOnce(null);
        mockArtistUpdate.mockResolvedValueOnce(undefined);
        mockMusicBrainzGetReleaseGroups.mockResolvedValueOnce([
            {
                id: "rg-db-same",
                title: "Owned Album",
                "first-release-date": "2010-01-01",
                "primary-type": "Album",
                "secondary-types": [],
            },
            {
                id: "rg-new-1",
                title: "New Album",
                "first-release-date": "2011-02-02",
                "primary-type": "Album",
                "secondary-types": [],
            },
            {
                id: "rg-live-1",
                title: "Live Album",
                "first-release-date": "2012-03-03",
                "primary-type": "Album",
                "secondary-types": ["Live"],
            },
        ]);
        mockPlayGroupBy.mockResolvedValueOnce([
            { trackId: "track-1", _count: { id: 6 } },
        ]);
        mockLastFmGetArtistTopTracks.mockResolvedValueOnce([
            {
                name: "Song One",
                playcount: "101",
                listeners: "45",
                duration: "200000",
                url: "https://last.fm/song-one",
                album: { "#text": "Owned Album" },
            },
            {
                name: "Song Two",
                playcount: "50",
                listeners: "20",
                duration: "180000",
                url: "https://last.fm/song-two",
                album: { "#text": "Remote Album" },
            },
        ]);
        mockArtistFindMany.mockResolvedValueOnce([
            {
                id: "artist-sim-1",
                name: "Similar One",
                normalizedName: "similar one",
                mbid: "sim-1",
                heroUrl: "similar-one.jpg",
                _count: { albums: 3 },
            },
        ]);
        mockResolveArtistImage.mockResolvedValueOnce({
            url: "similar-two.jpg",
            source: "deezer",
        });
        mockGetArtistImage.mockResolvedValueOnce("hero-fetched.jpg");
        mockRedisGet.mockImplementation(async (key: string) => {
            if (key === "discography:artist-real-mbid") {
                return null;
            }
            if (key === "caa:rg-new-1") {
                return "cached-new-cover.jpg";
            }
            if (key === "top-tracks:artist-1") {
                return null;
            }
            if (key === "similar-artists:artist-1") {
                return null;
            }
            if (key === "deezer-artist-image:Similar Two") {
                return null;
            }
            return null;
        });

        const req = {
            params: { id: "artist-1" },
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await artistByIdHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockMusicBrainzSearchArtist).toHaveBeenCalledWith(
            "Artist One",
            1,
        );
        expect(mockMusicBrainzGetReleaseGroups).toHaveBeenCalledWith(
            "artist-real-mbid",
            ["album", "ep"],
            100,
        );
        expect(mockPersistCatalogReleaseGroups).toHaveBeenCalledWith({
            artistId: "artist-1",
            releaseGroups: [
                expect.objectContaining({ id: "rg-db-same" }),
                expect.objectContaining({ id: "rg-new-1" }),
            ],
        });
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "discography:artist-real-mbid",
            24 * 60 * 60,
            expect.any(String),
        );
        expect(mockResolveArtistImage).toHaveBeenCalledWith({
            artistName: "Similar Two",
            mbid: null,
        });
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "top-tracks:artist-1",
            24 * 60 * 60,
            expect.any(String),
        );
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "artist-1",
                coverArt: "hero-fetched.jpg",
                discographyComplete: true,
                albums: expect.arrayContaining([
                    expect.objectContaining({
                        id: "album-db-1",
                        title: "Owned Album",
                        owned: true,
                        source: "database",
                    }),
                    expect.objectContaining({
                        id: "rg-new-1",
                        title: "New Album",
                        coverArt: "cached-new-cover.jpg",
                        owned: false,
                        source: "musicbrainz",
                    }),
                ]),
                topTracks: expect.arrayContaining([
                    expect.objectContaining({
                        id: "track-1",
                        title: "Song One",
                        userPlayCount: 6,
                        loudnessLufs: -16.7,
                        truePeakDb: -1.1,
                        album: expect.objectContaining({
                            albumLoudnessLufs: -17.5,
                            albumTruePeakDb: -0.7,
                        }),
                    }),
                ]),
                similarArtists: expect.arrayContaining([
                    expect.objectContaining({
                        id: "artist-sim-1",
                        name: "Similar One",
                        inLibrary: true,
                        coverArt: "similar-one.jpg",
                        ownedAlbumCount: 3,
                    }),
                    expect.objectContaining({
                        name: "Similar Two",
                        inLibrary: false,
                        coverArt: "similar-two.jpg",
                    }),
                ]),
            }),
        );
        expect(res.body.albums).not.toContainEqual(
            expect.objectContaining({ id: "album-catalog" }),
        );
    });

    it("falls back to local artist data when external lookups fail", async () => {
        const transientError = Object.assign(new Error("timeout"), {
            code: "ETIMEDOUT",
        });
        mockArtistFindFirst.mockResolvedValueOnce({
            id: "artist-err",
            name: "Artist Error",
            mbid: "mbid-error",
            heroUrl: null,
            userHeroUrl: "user-hero.jpg",
            similarArtistsJson: null,
            ownedAlbums: [{ rgMbid: "rg-owned" }],
            albums: [
                {
                    id: "album-owned",
                    title: "Owned Album",
                    rgMbid: "rg-owned",
                    location: "LIBRARY",
                    year: 2020,
                    coverUrl: "owned-cover.jpg",
                    tracks: [
                        {
                            id: "track-owned",
                            title: "Owned Song",
                            album: {
                                id: "album-owned",
                                title: "Owned Album",
                                coverUrl: "owned-cover.jpg",
                            },
                        },
                    ],
                },
            ],
        });
        mockMusicBrainzGetReleaseGroups.mockRejectedValueOnce(transientError);
        mockPlayGroupBy.mockResolvedValueOnce([
            { trackId: "track-owned", _count: { id: 2 } },
        ]);
        mockLastFmGetArtistTopTracks.mockRejectedValueOnce(
            new Error("lastfm top tracks unavailable"),
        );
        mockLastFmGetSimilarArtists.mockRejectedValueOnce(
            new Error("lastfm similar unavailable"),
        );
        mockGetArtistImage.mockResolvedValueOnce("hero-from-cache.jpg");
        mockRedisGet.mockImplementation(async (key: string) => {
            if (key === "discography:mbid-error") {
                return null;
            }
            if (key === "top-tracks:artist-err") {
                return null;
            }
            if (key === "similar-artists:artist-err") {
                return null;
            }
            return null;
        });

        const req = {
            params: { id: "artist-err" },
            query: {},
            user: { id: "user-5" },
        } as any;
        const res = createRes();

        await artistByIdHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "discography:mbid-error",
            120,
            "[]",
        );
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "artist-err",
                coverArt: "hero-from-cache.jpg",
                discographyComplete: false,
                albums: [
                    expect.objectContaining({
                        id: "album-owned",
                        source: "database",
                        owned: true,
                    }),
                ],
                topTracks: [
                    expect.objectContaining({
                        id: "track-owned",
                        userPlayCount: 2,
                    }),
                ],
                similarArtists: [],
            }),
        );
    });

    it("treats explicit false query values as false for artist-detail includes", async () => {
        mockArtistFindFirst.mockResolvedValueOnce({
            id: "artist-flags",
            name: "Artist Flags",
            mbid: "temp-flags",
            heroUrl: "hero-flags.jpg",
            userHeroUrl: "user-hero-flags.jpg",
            similarArtistsJson: [
                { name: "Should Ignore", mbid: "ignored", match: 0.7 },
            ],
            ownedAlbums: [{ rgMbid: "rg-flags" }],
            albums: [
                {
                    id: "album-flags",
                    title: "Flag Album",
                    rgMbid: "rg-flags",
                    location: "LIBRARY",
                    year: 2024,
                    coverUrl: "cover-flags.jpg",
                    tracks: [
                        {
                            id: "track-flags",
                            title: "Flagged Track",
                            album: {
                                id: "album-flags",
                                title: "Flag Album",
                                coverUrl: "cover-flags.jpg",
                            },
                        },
                    ],
                },
            ],
        });

        const req = {
            params: { id: "artist-flags" },
            query: {
                includeDiscography: "false",
                includeTopTracks: "off",
                includeSimilarArtists: "0",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await artistByIdHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockMusicBrainzSearchArtist).not.toHaveBeenCalled();
        expect(mockMusicBrainzGetReleaseGroups).not.toHaveBeenCalled();
        expect(mockPlayGroupBy).not.toHaveBeenCalled();
        expect(mockLastFmGetArtistTopTracks).not.toHaveBeenCalled();
        expect(mockLastFmGetSimilarArtists).not.toHaveBeenCalled();
        expect(mockGetArtistImage).not.toHaveBeenCalled();
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "artist-flags",
                discographyComplete: true,
                topTracks: [],
                similarArtists: [],
                coverArt: "user-hero-flags.jpg",
                albums: [
                    expect.objectContaining({
                        id: "album-flags",
                        source: "database",
                        owned: true,
                    }),
                ],
            }),
        );
    });

    it("treats unknown boolean-like artist query values as default values", async () => {
        mockArtistFindFirst.mockResolvedValueOnce({
            id: "artist-default-unknown",
            name: "Artist Unknown",
            mbid: "temp-unknown",
            heroUrl: "hero-unknown.jpg",
            userHeroUrl: null,
            similarArtistsJson: null,
            ownedAlbums: [{ rgMbid: "rg-unknown" }],
            albums: [],
        });
        mockMusicBrainzSearchArtist.mockResolvedValueOnce([
            { id: "artist-unknown-resolved" },
        ]);
        mockArtistFindUnique.mockResolvedValueOnce(null);
        mockMusicBrainzGetReleaseGroups.mockResolvedValueOnce([]);
        mockRedisGet.mockImplementation(async (key: string) => {
            if (key === "discography:artist-unknown-resolved") {
                return null;
            }
            if (key === "top-tracks:artist-default-unknown") {
                return null;
            }
            if (key === "similar-artists:artist-default-unknown") {
                return null;
            }
            return null;
        });

        const req = {
            params: { id: "artist-default-unknown" },
            query: {
                includeDiscography: "maybe",
                includeTopTracks: "maybe",
                includeSimilarArtists: "off",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await artistByIdHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockMusicBrainzSearchArtist).toHaveBeenCalledWith(
            "Artist Unknown",
            1,
        );
        expect(mockMusicBrainzGetReleaseGroups).toHaveBeenCalledWith(
            "artist-unknown-resolved",
            ["album", "ep"],
            100,
        );
        expect(mockPlayGroupBy).toHaveBeenCalled();
        expect(mockLastFmGetArtistTopTracks).toHaveBeenCalled();
    });

    it("uses Last.fm top tracks and similar artists on cache misses", async () => {
        mockArtistFindFirst.mockResolvedValueOnce({
            id: "artist-cacheless",
            name: "Cacheless Artist",
            mbid: "mbid-cacheless",
            heroUrl: "hero-cacheless.jpg",
            userHeroUrl: null,
            similarArtistsJson: null,
            ownedAlbums: [{ rgMbid: "rg-owned-cacheless" }],
            albums: [
                {
                    id: "album-cacheless",
                    title: "Owned Cache Album",
                    rgMbid: "rg-owned-cacheless",
                    location: "LIBRARY",
                    year: 2021,
                    coverUrl: "owned-cacheless.jpg",
                    tracks: [],
                },
            ],
        });
        mockRedisGet.mockImplementation(async (key: string) => {
            if (key === "discography:mbid-cacheless") {
                return null;
            }
            if (key === "top-tracks:artist-cacheless") {
                return null;
            }
            if (key === "similar-artists:artist-cacheless") {
                return null;
            }
            return null;
        });
        mockGetArtistImage.mockResolvedValueOnce("hero-from-cacheless-cache");
        mockLastFmGetArtistTopTracks.mockResolvedValueOnce([
            {
                name: "One-Track",
                playcount: "88",
                listeners: "100",
                duration: "240000",
                url: "https://last.fm/track/one-track",
                album: { "#text": "Single Album" },
            },
        ]);
        mockLastFmGetSimilarArtists.mockResolvedValueOnce([
            {
                name: "Similar Cacheless",
                mbid: "sim-cacheless",
                match: 0.91,
            },
        ]);
        mockResolveArtistImage.mockResolvedValueOnce({
            url: "https://images.example/similar-cacheless.jpg",
            source: "deezer",
        });

        const req = {
            params: { id: "artist-cacheless" },
            query: { includeDiscography: "false" },
            user: { id: "user-7" },
        } as any;
        const res = createRes();

        await artistByIdHandler(req, res);

        expect(mockMusicBrainzGetReleaseGroups).not.toHaveBeenCalled();
        expect(mockResolveArtistImage).toHaveBeenCalledWith({
            artistName: "Similar Cacheless",
            mbid: "sim-cacheless",
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "artist-cacheless",
                coverArt: "hero-from-cacheless-cache",
                discographyComplete: true,
                // The cover-resolver miss no longer aborts the Last.fm merge,
                // so the unowned top track survives with the page artist.
                topTracks: [
                    expect.objectContaining({
                        title: "One-Track",
                        playCount: 88,
                        artist: { name: "Cacheless Artist" },
                        album: expect.objectContaining({
                            title: "Single Album",
                        }),
                    }),
                ],
                similarArtists: [
                    expect.objectContaining({
                        id: "Similar Cacheless",
                        name: "Similar Cacheless",
                        inLibrary: false,
                    }),
                ],
            }),
        );
    });

    it("returns 404 when artist detail lookup misses", async () => {
        mockArtistFindFirst.mockResolvedValueOnce(null);
        const req = {
            params: { id: "missing-artist" },
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await artistByIdHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Artist not found" });
    });

    it("returns albums with ownership-aware filtering", async () => {
        mockOwnedAlbumFindMany.mockResolvedValueOnce([{ rgMbid: "rg-1" }]);
        mockAlbumFindMany.mockResolvedValueOnce([
            {
                id: "album-1",
                title: "Album One",
                artistId: "artist-1",
                rgMbid: "rg-1",
                location: "LIBRARY",
                coverUrl: "cover-1.jpg",
                artist: { id: "artist-1", mbid: "mbid-1", name: "Artist One" },
            },
            {
                id: "album-catalog",
                title: "Catalog Skeleton",
                artistId: "artist-1",
                rgMbid: "rg-catalog",
                location: "CATALOG",
                coverUrl: null,
                artist: { id: "artist-1", mbid: "mbid-1", name: "Artist One" },
            },
        ]);
        mockAlbumCount.mockResolvedValueOnce(1);

        const req = {
            query: {
                artistId: "artist-1",
                filter: "owned",
                limit: "5",
                offset: "2",
                sortBy: "recent",
            },
        } as any;
        const res = createRes();

        await albumsHandler(req, res);

        expect(mockOwnedAlbumFindMany).toHaveBeenCalledWith({
            select: { rgMbid: true },
        });
        expect(mockAlbumFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    AND: [
                        {
                            OR: [
                                {
                                    location: "LIBRARY",
                                    tracks: {
                                        some: {
                                            removedAt: null,
                                            album: {
                                                location: {
                                                    in: [
                                                        "LIBRARY",
                                                        "DISCOVER",
                                                        "REMOTE",
                                                        "FEDERATED",
                                                    ],
                                                },
                                            },
                                            OR: [
                                                { origin: "LOCAL" },
                                                {
                                                    origin: "FEDERATED",
                                                    OR: [
                                                        {
                                                            dedupOfTrackId:
                                                                null,
                                                        },
                                                        {
                                                            federationPeer: {
                                                                showDedupedCopies: true,
                                                            },
                                                        },
                                                        {
                                                            dedupOfTrack: {
                                                                removedAt: {
                                                                    not: null,
                                                                },
                                                            },
                                                        },
                                                    ],
                                                },
                                            ],
                                        },
                                    },
                                },
                                {
                                    rgMbid: { in: ["rg-1"] },
                                    location: {
                                        in: ["LIBRARY", "DISCOVER"],
                                    },
                                    tracks: {
                                        some: {
                                            removedAt: null,
                                            album: {
                                                location: {
                                                    in: [
                                                        "LIBRARY",
                                                        "DISCOVER",
                                                        "REMOTE",
                                                        "FEDERATED",
                                                    ],
                                                },
                                            },
                                            OR: [
                                                { origin: "LOCAL" },
                                                {
                                                    origin: "FEDERATED",
                                                    OR: [
                                                        {
                                                            dedupOfTrackId:
                                                                null,
                                                        },
                                                        {
                                                            federationPeer: {
                                                                showDedupedCopies: true,
                                                            },
                                                        },
                                                        {
                                                            dedupOfTrack: {
                                                                removedAt: {
                                                                    not: null,
                                                                },
                                                            },
                                                        },
                                                    ],
                                                },
                                            ],
                                        },
                                    },
                                },
                                {
                                    location: "FEDERATED",
                                    tracks: {
                                        some: {
                                            removedAt: null,
                                            album: {
                                                location: {
                                                    in: [
                                                        "LIBRARY",
                                                        "DISCOVER",
                                                        "REMOTE",
                                                        "FEDERATED",
                                                    ],
                                                },
                                            },
                                            OR: [
                                                { origin: "LOCAL" },
                                                {
                                                    origin: "FEDERATED",
                                                    OR: [
                                                        {
                                                            dedupOfTrackId:
                                                                null,
                                                        },
                                                        {
                                                            federationPeer: {
                                                                showDedupedCopies: true,
                                                            },
                                                        },
                                                        {
                                                            dedupOfTrack: {
                                                                removedAt: {
                                                                    not: null,
                                                                },
                                                            },
                                                        },
                                                    ],
                                                },
                                            ],
                                        },
                                    },
                                },
                            ],
                        },
                        { artistId: "artist-1" },
                    ],
                },
                skip: 2,
                take: 5,
                orderBy: { year: "desc" },
            }),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            albums: [
                expect.objectContaining({
                    id: "album-1",
                    coverArt: "cover-1.jpg",
                }),
            ],
            total: 1,
            offset: 2,
            limit: 5,
        });
        expect(res.body.albums).not.toContainEqual(
            expect.objectContaining({ id: "album-catalog" }),
        );
    });

    it("supports discovery filter with optional artist scoping", async () => {
        mockAlbumFindMany.mockResolvedValueOnce([
            {
                id: "album-discovery",
                title: "Discovered Album",
                artistId: "artist-discovery",
                rgMbid: "rg-discovery",
                location: "DISCOVER",
                coverUrl: "discovery-cover.jpg",
                artist: {
                    id: "artist-discovery",
                    mbid: "mbid-discovery",
                    name: "Discovery Artist",
                },
            },
        ]);
        mockAlbumCount.mockResolvedValueOnce(1);

        const req = {
            query: {
                artistId: "artist-discovery",
                filter: "discovery",
                limit: "1",
                sortBy: "name-desc",
            },
        } as any;
        const res = createRes();

        await albumsHandler(req, res);

        expect(mockAlbumFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    tracks: {
                        some: {
                            removedAt: null,
                            album: {
                                location: {
                                    in: [
                                        "LIBRARY",
                                        "DISCOVER",
                                        "REMOTE",
                                        "FEDERATED",
                                    ],
                                },
                            },
                            OR: [
                                { origin: "LOCAL" },
                                {
                                    origin: "FEDERATED",
                                    OR: [
                                        { dedupOfTrackId: null },
                                        {
                                            federationPeer: {
                                                showDedupedCopies: true,
                                            },
                                        },
                                        {
                                            dedupOfTrack: {
                                                removedAt: { not: null },
                                            },
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                    location: "DISCOVER",
                    artistId: "artist-discovery",
                },
                skip: 0,
                take: 1,
                orderBy: { title: "desc" },
            }),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            albums: [expect.objectContaining({ id: "album-discovery" })],
            total: 1,
            offset: 0,
            limit: 1,
        });
    });

    it("returns 500 when album listing fails", async () => {
        mockAlbumFindMany.mockRejectedValueOnce(new Error("album list failed"));
        const req = { query: {} } as any;
        const res = createRes();

        await albumsHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to fetch albums",
        });
        expect(JSON.stringify(res.body)).not.toContain("album list failed");
    });

    it("handles album lookup by id, includeTracks flag, and ownership", async () => {
        mockAlbumFindFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "album-2",
                artistId: "artist-2",
                rgMbid: "rg-2",
                coverUrl: "cover-2.jpg",
                artist: {
                    id: "artist-2",
                    mbid: "mbid-2",
                    name: "Artist Two",
                },
            })
            .mockResolvedValueOnce({
                id: "album-3",
                artistId: "artist-3",
                rgMbid: "rg-3",
                coverUrl: "cover-3.jpg",
                artist: {
                    id: "artist-3",
                    mbid: "mbid-3",
                    name: "Artist Three",
                },
                tracks: [{ id: "track-1", title: "Track One" }],
            });
        mockOwnedAlbumFindUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ artistId: "artist-3", rgMbid: "rg-3" });

        const missingReq = { params: { id: "missing" }, query: {} } as any;
        const missingRes = createRes();
        await albumByIdHandler(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);

        const noTracksReq = {
            params: { id: "album-2" },
            query: { includeTracks: "false" },
        } as any;
        const noTracksRes = createRes();
        await albumByIdHandler(noTracksReq, noTracksRes);
        expect(noTracksRes.statusCode).toBe(200);
        expect(noTracksRes.body).toEqual(
            expect.objectContaining({
                id: "album-2",
                tracks: [],
                owned: false,
                coverArt: "cover-2.jpg",
            }),
        );

        const withTracksReq = {
            params: { id: "album-3" },
            query: {},
        } as any;
        const withTracksRes = createRes();
        await albumByIdHandler(withTracksReq, withTracksRes);
        expect(withTracksRes.statusCode).toBe(200);
        expect(withTracksRes.body).toEqual(
            expect.objectContaining({
                id: "album-3",
                tracks: [{ id: "track-1", title: "Track One" }],
                owned: true,
            }),
        );
    });

    it("accepts includeTracks as string true and boolean true", async () => {
        mockAlbumFindFirst
            .mockResolvedValueOnce({
                id: "album-string-true",
                artistId: "artist-true",
                rgMbid: "rg-string-true",
                coverUrl: "cover-string.jpg",
                artist: {
                    id: "artist-true",
                    mbid: "mbid-true",
                    name: "Artist True",
                },
                tracks: [{ id: "track-true", title: "Track True" }],
            })
            .mockResolvedValueOnce({
                id: "album-bool-true",
                artistId: "artist-bool",
                rgMbid: "rg-bool-true",
                coverUrl: "cover-bool.jpg",
                artist: {
                    id: "artist-bool",
                    mbid: "mbid-bool",
                    name: "Artist Bool",
                },
                tracks: [{ id: "track-bool", title: "Track Bool" }],
            });
        mockOwnedAlbumFindUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                artistId: "artist-bool",
                rgMbid: "rg-bool-true",
            });

        const stringReq = {
            params: { id: "album-string-true" },
            query: { includeTracks: "true" },
        } as any;
        const stringRes = createRes();
        await albumByIdHandler(stringReq, stringRes);
        expect(stringRes.statusCode).toBe(200);
        expect(stringRes.body).toEqual(
            expect.objectContaining({
                id: "album-string-true",
                tracks: [{ id: "track-true", title: "Track True" }],
                owned: false,
            }),
        );

        const boolReq = {
            params: { id: "album-bool-true" },
            query: { includeTracks: true },
        } as any;
        const boolRes = createRes();
        await albumByIdHandler(boolReq, boolRes);
        expect(boolRes.statusCode).toBe(200);
        expect(boolRes.body).toEqual(
            expect.objectContaining({
                id: "album-bool-true",
                tracks: [{ id: "track-bool", title: "Track Bool" }],
                owned: true,
            }),
        );
    });

    it("returns tracks with album cover art and handles failures", async () => {
        mockTrackFindMany.mockResolvedValueOnce([
            {
                id: "track-10",
                title: "Track 10",
                albumId: "album-10",
                album: {
                    id: "album-10",
                    title: "Album 10",
                    coverUrl: "album-10.jpg",
                    artist: { id: "artist-10", name: "Artist 10" },
                },
            },
        ]);
        mockTrackCount.mockResolvedValueOnce(1);

        const req = {
            query: { albumId: "album-10", limit: "4", offset: "1" },
        } as any;
        const res = createRes();
        await tracksHandler(req, res);

        expect(mockTrackFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    albumId: "album-10",
                    removedAt: null,
                    ...visibleAlbumRelationWhere,
                    OR: [
                        { origin: "LOCAL" },
                        {
                            origin: "FEDERATED",
                            OR: [
                                { dedupOfTrackId: null },
                                {
                                    federationPeer: {
                                        showDedupedCopies: true,
                                    },
                                },
                                {
                                    dedupOfTrack: {
                                        removedAt: { not: null },
                                    },
                                },
                            ],
                        },
                    ],
                },
                skip: 1,
                take: 4,
                orderBy: [{ discNo: "asc" }, { trackNo: "asc" }],
            }),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            tracks: [
                expect.objectContaining({
                    id: "track-10",
                    album: expect.objectContaining({
                        coverArt: "album-10.jpg",
                    }),
                }),
            ],
            total: 1,
            offset: 1,
            limit: 4,
        });

        mockTrackFindMany.mockRejectedValueOnce(
            new Error("track lookup failed"),
        );
        const errReq = { query: {} } as any;
        const errRes = createRes();
        await invokeWithErrorHandler(tracksHandler, errReq, errRes);
        expect(errRes.statusCode).toBe(500);
    });

    it("requires authentication for liked playlist retrieval", async () => {
        const req = { query: { limit: "5" } } as any;
        const res = createRes();

        await likedPlaylistHandler(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({
            error: "Authentication required for liked playlist",
        });
        expect(mockLikedTrackFindMany).not.toHaveBeenCalled();
    });

    it("returns liked playlist tracks in deterministic order with cursor-safe pagination", async () => {
        const tiedLikedAt = new Date("2026-02-20T00:00:00.000Z");
        const olderLikedAt = new Date("2026-02-19T00:00:00.000Z");

        mockLikedTrackCount.mockResolvedValue(3);
        mockLikedTrackFindMany
            .mockResolvedValueOnce([
                { trackId: "liked-b", likedAt: tiedLikedAt },
                { trackId: "liked-a", likedAt: tiedLikedAt },
                { trackId: "liked-c", likedAt: olderLikedAt },
            ])
            .mockResolvedValueOnce([
                { trackId: "liked-c", likedAt: olderLikedAt },
            ]);
        mockTrackFindMany
            .mockResolvedValueOnce([
                createRadioTrack("liked-a"),
                createRadioTrack("liked-b"),
                createRadioTrack("liked-c"),
            ])
            .mockResolvedValueOnce([createRadioTrack("liked-c")]);

        const firstReq = {
            query: { limit: "2" },
            user: { id: "user-1" },
        } as any;
        const firstRes = createRes();
        await likedPlaylistHandler(firstReq, firstRes);

        expect(firstRes.statusCode).toBe(200);
        expect(mockLikedTrackFindMany).toHaveBeenNthCalledWith(1, {
            where: {
                userId: "user-1",
                track: { removedAt: null, ...visibleAlbumRelationWhere },
            },
            select: { trackId: true, likedAt: true },
            orderBy: [{ likedAt: "desc" }, { trackId: "asc" }],
            take: 6,
        });
        expect(firstRes.body.playlist).toEqual({
            id: "my-liked",
            name: "My Liked",
            description: "All your thumbs-up tracks",
        });
        expect(firstRes.body.tracks.map((track: any) => track.id)).toEqual([
            "liked-a",
            "liked-b",
        ]);
        expect(firstRes.body.pagination).toEqual({
            limit: 2,
            hasMore: true,
            nextCursor: {
                likedAt: tiedLikedAt.toISOString(),
                trackId: "liked-b",
            },
        });
        expect(firstRes.body.total).toBe(3);

        const secondReq = {
            query: {
                limit: "2",
                cursorLikedAt: firstRes.body.pagination.nextCursor.likedAt,
                cursorTrackId: firstRes.body.pagination.nextCursor.trackId,
            },
            user: { id: "user-1" },
        } as any;
        const secondRes = createRes();
        await likedPlaylistHandler(secondReq, secondRes);

        expect(secondRes.statusCode).toBe(200);
        expect(mockLikedTrackFindMany).toHaveBeenNthCalledWith(2, {
            where: {
                userId: "user-1",
                track: { removedAt: null, ...visibleAlbumRelationWhere },
                OR: [
                    { likedAt: { lt: tiedLikedAt } },
                    {
                        likedAt: tiedLikedAt,
                        trackId: { gt: "liked-b" },
                    },
                ],
            },
            select: { trackId: true, likedAt: true },
            orderBy: [{ likedAt: "desc" }, { trackId: "asc" }],
            take: 6,
        });
        expect(secondRes.body.tracks.map((track: any) => track.id)).toEqual([
            "liked-c",
        ]);
        expect(secondRes.body.pagination).toEqual({
            limit: 2,
            hasMore: false,
            nextCursor: null,
        });
    });

    it("returns empty liked playlist payload with stable pagination metadata", async () => {
        mockLikedTrackCount.mockResolvedValueOnce(0);
        mockLikedTrackFindMany.mockResolvedValueOnce([]);

        const req = {
            query: { limit: "25" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();
        await likedPlaylistHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            playlist: {
                id: "my-liked",
                name: "My Liked",
                description: "All your thumbs-up tracks",
            },
            tracks: [],
            total: 0,
            pagination: {
                limit: 25,
                hasMore: false,
                nextCursor: null,
            },
        });
        expect(mockTrackFindMany).not.toHaveBeenCalled();
    });

    it("returns remote liked tracks with streamSource and provider IDs", async () => {
        const ytLikedAt = new Date("2026-03-01T12:00:00.000Z");
        const tidalLikedAt = new Date("2026-03-01T11:00:00.000Z");
        const localLikedAt = new Date("2026-03-01T10:00:00.000Z");

        mockLikedTrackCount.mockResolvedValueOnce(1);
        mockRemoteLikedTrackCount.mockResolvedValueOnce(2);
        mockUserSettingsFindUnique.mockResolvedValueOnce({
            tidalOAuthJson: "tidal-token",
            ytMusicOAuthJson: "yt-token",
        });
        mockLikedTrackFindMany.mockResolvedValueOnce([
            { trackId: "local-1", likedAt: localLikedAt },
        ]);
        mockRemoteLikedTrackFindMany.mockResolvedValueOnce([
            {
                id: "lrt-yt",
                userId: "user-1",
                trackTidalId: null,
                trackYtMusicId: "yt-row-1",
                likedAt: ytLikedAt,
                trackTidal: null,
                trackYtMusic: {
                    id: "yt-row-1",
                    videoId: "dQw4w9WgXcQ",
                    title: "YouTube Song",
                    artist: "YT Artist",
                    album: "Single",
                    duration: 180,
                    thumbnailUrl: "https://lh3.googleusercontent.com/thumb",
                    createdAt: new Date("2026-03-01T09:00:00.000Z"),
                },
            },
            {
                id: "lrt-tidal",
                userId: "user-1",
                trackTidalId: "tt-row-1",
                trackYtMusicId: null,
                likedAt: tidalLikedAt,
                trackTidal: {
                    id: "tt-row-1",
                    tidalId: 123456789,
                    title: "Tidal Song",
                    artist: "Tidal Artist",
                    album: "Tidal Album",
                    duration: 240,
                    isrc: null,
                    quality: null,
                    explicit: null,
                    createdAt: new Date("2026-03-01T08:00:00.000Z"),
                },
                trackYtMusic: null,
            },
        ]);
        mockTrackFindMany.mockResolvedValueOnce([createRadioTrack("local-1")]);

        const req = {
            query: { limit: "10" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();
        await likedPlaylistHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.total).toBe(3);
        expect(res.body.tracks).toHaveLength(3);

        // Tracks should be ordered by likedAt descending
        const [ytTrack, tidalTrack, localTrack] = res.body.tracks;

        // YouTube remote track
        expect(ytTrack.id).toBe("yt:dQw4w9WgXcQ");
        expect(ytTrack.title).toBe("YouTube Song");
        expect(ytTrack.streamSource).toBe("youtube");
        expect(ytTrack.youtubeVideoId).toBe("dQw4w9WgXcQ");
        expect(ytTrack.tidalTrackId).toBeUndefined();
        expect(ytTrack.filePath).toBeNull();
        expect(ytTrack.artist.name).toBe("YT Artist");
        expect(ytTrack.album.title).toBe("Single");
        expect(ytTrack.source).toBe("youtube");

        // Tidal remote track
        expect(tidalTrack.id).toBe("tidal:123456789");
        expect(tidalTrack.title).toBe("Tidal Song");
        expect(tidalTrack.streamSource).toBe("tidal");
        expect(tidalTrack.tidalTrackId).toBe(123456789);
        expect(tidalTrack.youtubeVideoId).toBeUndefined();
        expect(tidalTrack.filePath).toBeNull();
        expect(tidalTrack.artist.name).toBe("Tidal Artist");
        expect(tidalTrack.album.title).toBe("Tidal Album");
        expect(tidalTrack.source).toBe("tidal");

        // Local track should NOT have streaming fields
        expect(localTrack.id).toBe("local-1");
        expect(localTrack.streamSource).toBeUndefined();
        expect(localTrack.youtubeVideoId).toBeUndefined();
        expect(localTrack.tidalTrackId).toBeUndefined();
        expect(localTrack.filePath).toBeDefined();
    });

    it("merge-sorts local and remote liked tracks by likedAt descending", async () => {
        // Tests the cursor stability concern: interleaved local+remote timestamps
        const t1 = new Date("2026-03-01T14:00:00.000Z"); // remote yt — newest
        const t2 = new Date("2026-03-01T13:00:00.000Z"); // local
        const t3 = new Date("2026-03-01T12:00:00.000Z"); // remote tidal
        const t4 = new Date("2026-03-01T11:00:00.000Z"); // local — oldest

        mockLikedTrackCount.mockResolvedValueOnce(2);
        mockRemoteLikedTrackCount.mockResolvedValueOnce(2);
        mockUserSettingsFindUnique.mockResolvedValueOnce({
            tidalOAuthJson: "tidal-token",
            ytMusicOAuthJson: "yt-token",
        });
        mockLikedTrackFindMany.mockResolvedValueOnce([
            { trackId: "local-a", likedAt: t2 },
            { trackId: "local-b", likedAt: t4 },
        ]);
        mockRemoteLikedTrackFindMany.mockResolvedValueOnce([
            {
                id: "lrt-yt",
                userId: "user-1",
                trackTidalId: null,
                trackYtMusicId: "yt-1",
                likedAt: t1,
                trackTidal: null,
                trackYtMusic: {
                    id: "yt-1",
                    videoId: "vid1",
                    title: "YT1",
                    artist: "A1",
                    album: "Single",
                    duration: 100,
                    thumbnailUrl: null,
                    createdAt: new Date("2026-03-01T10:00:00.000Z"),
                },
            },
            {
                id: "lrt-tidal",
                userId: "user-1",
                trackTidalId: "tt-1",
                trackYtMusicId: null,
                likedAt: t3,
                trackTidal: {
                    id: "tt-1",
                    tidalId: 987,
                    title: "Tidal1",
                    artist: "A2",
                    album: "Album2",
                    duration: 200,
                    isrc: null,
                    quality: null,
                    explicit: null,
                    createdAt: new Date("2026-03-01T10:00:00.000Z"),
                },
                trackYtMusic: null,
            },
        ]);
        mockTrackFindMany.mockResolvedValueOnce([
            createRadioTrack("local-a"),
            createRadioTrack("local-b"),
        ]);

        const req = {
            query: { limit: "10" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();
        await likedPlaylistHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.tracks.map((t: any) => t.id)).toEqual([
            "yt:vid1", // t1 — newest
            "local-a", // t2
            "tidal:987", // t3
            "local-b", // t4 — oldest
        ]);
        expect(res.body.total).toBe(4);
    });

    it("keeps pagination open when same-timestamp remote likes exceed the fetch window", async () => {
        const tiedLikedAt = new Date("2026-03-02T00:00:00.000Z");
        const remoteEntries = Array.from({ length: 8 }, (_value, index) => {
            const suffix = String(index + 1).padStart(2, "0");
            return {
                id: `lrt-${suffix}`,
                userId: "user-1",
                trackTidalId: null,
                trackYtMusicId: `yt-row-${suffix}`,
                likedAt: tiedLikedAt,
                trackTidal: null,
                trackYtMusic: {
                    id: `yt-row-${suffix}`,
                    videoId: `vid-${suffix}`,
                    title: `Remote ${suffix}`,
                    artist: `Artist ${suffix}`,
                    album: "Remote Album",
                    duration: 180,
                    thumbnailUrl: null,
                    createdAt: new Date("2026-03-02T00:00:00.000Z"),
                },
            };
        });

        mockLikedTrackCount.mockResolvedValue(0);
        mockRemoteLikedTrackCount.mockResolvedValue(8);
        mockUserSettingsFindUnique.mockResolvedValue({
            tidalOAuthJson: null,
            ytMusicOAuthJson: "yt-token",
        });
        mockLikedTrackFindMany.mockResolvedValue([]);
        mockRemoteLikedTrackFindMany.mockImplementation(
            ({ where, take }: any) => {
                let filtered = remoteEntries;
                if (where?.OR) {
                    const tiedCursorId = where.OR[1]?.id?.gt;
                    if (typeof tiedCursorId === "string") {
                        filtered = remoteEntries.filter(
                            (entry) => entry.id > tiedCursorId,
                        );
                    }
                }
                return filtered.slice(0, take);
            },
        );

        const seenTrackIds = new Set<string>();
        const seenCursorTrackIds = new Set<string>();
        let cursorLikedAt: string | undefined;
        let cursorTrackId: string | undefined;
        let pagesFetched = 0;

        while (pagesFetched < 10) {
            const req = {
                query: {
                    limit: "2",
                    ...(cursorLikedAt && cursorTrackId
                        ? { cursorLikedAt, cursorTrackId }
                        : {}),
                },
                user: { id: "user-1" },
            } as any;
            const res = createRes();
            await likedPlaylistHandler(req, res);
            expect(res.statusCode).toBe(200);
            expect(res.body.tracks).toHaveLength(2);
            for (const track of res.body.tracks as Array<{ id: string }>) {
                seenTrackIds.add(track.id);
            }

            pagesFetched += 1;
            if (!res.body.pagination.hasMore) {
                break;
            }

            expect(res.body.pagination.nextCursor).toBeTruthy();
            const nextTrackId = res.body.pagination.nextCursor
                .trackId as string;
            expect(seenCursorTrackIds.has(nextTrackId)).toBe(false);
            seenCursorTrackIds.add(nextTrackId);
            cursorLikedAt = res.body.pagination.nextCursor.likedAt;
            cursorTrackId = nextTrackId;
        }

        expect(pagesFetched).toBe(4);
        expect(seenTrackIds.size).toBe(8);
    });
});
