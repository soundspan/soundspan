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

describe("library scan and organize runtime coverage", () => {
    const scanHandler = getHandler("post", "/scan");
    const scanStatusAccessHandler = getHandler("get", "/scan/status/:jobId");
    const scanStatusHandler = getFinalHandler("get", "/scan/status/:jobId");
    const organizeHandler = getHandler("post", "/organize");

    beforeEach(() => {
        jest.clearAllMocks();
        (config.music as any).musicPath = "/music";
        (config.music as any).transcodeCachePath = "/tmp/soundspan-cache";
        (config.music as any).transcodeCacheMaxGb = 1;

        mockOrganizeSingles.mockResolvedValue(undefined);
        mockScanQueueAdd.mockResolvedValue({ id: "job-123" });
        mockScanQueueGetJob.mockResolvedValue(null);
        mockScanQueueGetJobs.mockResolvedValue([]);
        mockScanQueueClientSet.mockResolvedValue("OK");
        mockScanQueueClientEval.mockResolvedValue(1);
    });

    it("short-circuits scan when MUSIC_PATH is missing", async () => {
        (config.music as any).musicPath = "";

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await scanHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Music path not configured. Please set MUSIC_PATH environment variable.",
        });
        expect(mockOrganizeSingles).not.toHaveBeenCalled();
        expect(mockScanQueueAdd).not.toHaveBeenCalled();
    });

    it("continues scan when pre-scan organization fails", async () => {
        mockOrganizeSingles.mockRejectedValueOnce(
            new Error("slskd unavailable"),
        );

        const req = { user: { id: "user-22" } } as any;
        const res = createRes();

        await scanHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Library scan started",
            jobId: "job-123",
            musicPath: "/music",
        });
        expect(mockScanQueueAdd).toHaveBeenCalledWith(
            "scan",
            {
                userId: "user-22",
                musicPath: "/music",
            },
            {
                jobId: "library-global-maintenance",
            },
        );
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Download organization skipped before library scan",
            expect.objectContaining({ message: "slskd unavailable" }),
        );
    });

    it("uses system user id when scan requester is missing", async () => {
        const req = {} as any;
        const res = createRes();

        await scanHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockScanQueueAdd).toHaveBeenCalledWith(
            "scan",
            {
                userId: "system",
                musicPath: "/music",
            },
            {
                jobId: "library-global-maintenance",
            },
        );
    });

    it("coalesces concurrent scan requests before organization starts twice", async () => {
        let finishOrganization: (() => void) | undefined;
        let markOrganizationStarted: (() => void) | undefined;
        const organizationStarted = new Promise<void>((resolve) => {
            markOrganizationStarted = resolve;
        });
        mockOrganizeSingles.mockImplementationOnce(() => {
            markOrganizationStarted!();
            return new Promise<void>((resolve) => {
                finishOrganization = resolve;
            });
        });
        mockScanQueueClientSet
            .mockResolvedValueOnce("OK")
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce("OK");

        const firstRes = createRes();
        const secondRes = createRes();
        const firstRequest = scanHandler(
            { user: { id: "user-1" } } as any,
            firstRes,
        );
        const secondRequest = scanHandler(
            { user: { id: "user-1" } } as any,
            secondRes,
        );

        await Promise.all([secondRequest, organizationStarted]);

        expect(secondRes.statusCode).toBe(200);
        expect(secondRes.body).toEqual({
            message: "Library maintenance already running",
            status: "processing",
            jobId: "library-global-maintenance",
            musicPath: "/music",
        });
        expect(mockOrganizeSingles).toHaveBeenCalledTimes(1);
        expect(mockScanQueueAdd).not.toHaveBeenCalled();

        expect(finishOrganization).toBeDefined();
        finishOrganization!();
        await firstRequest;

        expect(firstRes.body).toEqual({
            message: "Library scan started",
            jobId: "job-123",
            musicPath: "/music",
        });
        expect(mockScanQueueAdd).toHaveBeenCalledTimes(1);
    });

    it("returns already running when a scan job is active without starting duplicate work", async () => {
        mockScanQueueGetJobs.mockResolvedValueOnce([{ id: "job-active" }]);

        const res = createRes();
        await scanHandler({ user: { id: "user-2" } } as any, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Library maintenance already running",
            status: "processing",
            jobId: "job-active",
            musicPath: "/music",
        });
        expect(mockOrganizeSingles).not.toHaveBeenCalled();
        expect(mockScanQueueAdd).not.toHaveBeenCalled();
        expect(mockScanQueueClientEval).toHaveBeenCalledTimes(1);
    });

    it("reuses the maintenance identity after preserving the prior result for status polling", async () => {
        const completedJob = {
            id: "library-global-maintenance",
            getState: jest.fn().mockResolvedValue("completed"),
            remove: jest.fn().mockResolvedValue(undefined),
        };
        mockScanQueueGetJob.mockResolvedValueOnce(completedJob);

        const res = createRes();
        await scanHandler({ user: { id: "user-5" } } as any, res);

        expect(completedJob.getState).toHaveBeenCalledTimes(2);
        expect(completedJob.remove).toHaveBeenCalledTimes(1);
        expect(mockScanQueueAdd).toHaveBeenCalledTimes(1);
        expect(completedJob.remove.mock.invocationCallOrder[0]).toBeLessThan(
            mockScanQueueAdd.mock.invocationCallOrder[0],
        );
    });

    it("leaves a live maintenance job retained and relies on stable-id add deduplication", async () => {
        const liveJob = {
            id: "library-global-maintenance",
            getState: jest.fn().mockResolvedValue("active"),
            remove: jest.fn().mockResolvedValue(undefined),
        };
        mockScanQueueGetJob.mockResolvedValueOnce(liveJob);

        const res = createRes();
        await scanHandler({ user: { id: "user-live" } } as any, res);

        expect(liveJob.getState).toHaveBeenCalledTimes(1);
        expect(liveJob.remove).not.toHaveBeenCalled();
        expect(mockScanQueueAdd).toHaveBeenCalledTimes(1);
    });

    it("surfaces retained terminal job removal failures without adding", async () => {
        const removeError = new Error("remove unavailable");
        const completedJob = {
            id: "library-global-maintenance",
            getState: jest.fn().mockResolvedValue("completed"),
            remove: jest.fn().mockRejectedValue(removeError),
        };
        mockScanQueueGetJob.mockResolvedValueOnce(completedJob);

        const res = createRes();
        await invokeWithErrorHandler(
            scanHandler,
            { user: { id: "user-remove-error" } } as any,
            res,
        );

        expect(res.statusCode).toBe(500);
        expect(completedJob.getState).toHaveBeenCalledTimes(2);
        expect(mockScanQueueAdd).not.toHaveBeenCalled();
    });

    it("rate limits a user who started maintenance during the cooldown", async () => {
        mockScanQueueClientSet
            .mockResolvedValueOnce("OK")
            .mockResolvedValueOnce(null);

        const res = createRes();
        await scanHandler({ user: { id: "user-2" } } as any, res);

        expect(res.statusCode).toBe(429);
        expect(res.body).toEqual({
            error: "Library maintenance was started recently",
        });
        expect(mockOrganizeSingles).not.toHaveBeenCalled();
        expect(mockScanQueueAdd).not.toHaveBeenCalled();
        expect(mockScanQueueClientEval).toHaveBeenCalledTimes(1);
    });

    it("returns scan trigger error when queue add fails", async () => {
        mockScanQueueAdd.mockRejectedValueOnce(new Error("queue unavailable"));

        const req = { user: { id: "user-3" } } as any;
        const res = createRes();

        await invokeWithErrorHandler(scanHandler, req, res);

        expect(res.statusCode).toBe(500);
    });

    it("returns 404 for unknown scan jobs", async () => {
        mockScanQueueGetJob.mockResolvedValueOnce(null);

        const req = { params: { jobId: "missing-job" } } as any;
        const res = createRes();

        await scanStatusHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Job not found" });
    });

    it("rejects non-admin scan status access before reading the queue", async () => {
        const req = {
            params: { jobId: "job-123" },
            user: { id: "user-1", role: "user" },
        } as any;
        const res = createRes();

        await scanStatusAccessHandler(req, res, jest.fn());

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: "Admin access required" });
        expect(mockScanQueueGetJob).not.toHaveBeenCalled();
    });

    it("maps Bull scan details to a sanitized response payload", async () => {
        const job = {
            getState: jest.fn().mockResolvedValue("completed"),
            progress: jest.fn(() => ({
                percent: 68,
                currentFile: "/music/private/Artist/track.flac",
            })),
            returnvalue: {
                tracksAdded: 241,
                tracksUpdated: 12,
                tracksRemoved: 3,
                errors: [
                    {
                        file: "/music/private/Artist/broken.flac",
                        error: "decoder crashed at /usr/lib/private/codec.so",
                    },
                    {
                        file: "C:\\Music\\private\\second.flac",
                        error: "scanner exception with host diagnostics",
                    },
                ],
                duration: 4321,
                musicPath: "/music/private",
            },
        };
        mockScanQueueGetJob.mockResolvedValueOnce(job);

        const req = { params: { jobId: "job-123" } } as any;
        const res = createRes();

        await scanStatusHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            status: "completed",
            progress: 68,
            result: {
                tracksAdded: 241,
                tracksUpdated: 12,
                tracksRemoved: 3,
                failedCount: 2,
                duration: 4321,
            },
        });
        expect(JSON.stringify(res.body)).not.toContain("/music/private");
        expect(JSON.stringify(res.body)).not.toContain("C:\\Music");
        expect(JSON.stringify(res.body)).not.toContain("decoder crashed");
        expect(job.getState).toHaveBeenCalledTimes(1);
        expect(job.progress).toHaveBeenCalledTimes(1);
    });

    it("returns 500 when scan status lookup throws", async () => {
        mockScanQueueGetJob.mockRejectedValueOnce(new Error("redis down"));

        const req = { params: { jobId: "job-99" } } as any;
        const res = createRes();

        await invokeWithErrorHandler(scanStatusHandler, req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get scan status" });
        expect(JSON.stringify(res.body)).not.toContain("redis down");
    });

    it("starts manual organization in background", async () => {
        const req = {} as any;
        const res = createRes();

        await organizeHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Organization started in background",
        });
        expect(mockOrganizeSingles).toHaveBeenCalledTimes(1);
    });

    it("does not start organization while a scan job is active", async () => {
        mockScanQueueGetJobs.mockResolvedValueOnce([{ id: "job-active" }]);

        const res = createRes();
        await organizeHandler({ user: { id: "user-4" } } as any, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Library maintenance already running",
            status: "processing",
        });
        expect(mockOrganizeSingles).not.toHaveBeenCalled();
        expect(mockScanQueueAdd).not.toHaveBeenCalled();
    });

    it("keeps organization endpoint successful when background promise rejects", async () => {
        const backgroundError = new Error("organizer worker failed");
        mockOrganizeSingles.mockReturnValueOnce(
            Promise.reject(backgroundError),
        );

        const req = {} as any;
        const res = createRes();

        await organizeHandler(req, res);
        await flushPromises();

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Organization started in background",
        });
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Manual organization failed",
            backgroundError,
        );
    });

    it("returns 500 when manual organization throws synchronously", async () => {
        mockOrganizeSingles.mockImplementationOnce(() => {
            throw new Error("sync crash");
        });

        const req = {} as any;
        const res = createRes();

        await invokeWithErrorHandler(organizeHandler, req, res);

        expect(res.statusCode).toBe(500);
    });
});

describe("library policy and backfill runtime coverage", () => {
    const deletePolicyHandler = getHandler("get", "/delete-policy");
    const artistCountsStatusHandler = getHandler(
        "get",
        "/artist-counts/status",
    );
    const artistCountsBackfillHandler = getHandler(
        "post",
        "/artist-counts/backfill",
    );
    const imageBackfillStatusHandler = getHandler(
        "get",
        "/image-backfill/status",
    );
    const imageBackfillStartHandler = getHandler(
        "post",
        "/image-backfill/start",
    );
    const backfillGenresHandler = getHandler("post", "/backfill-genres");

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetSystemSettings.mockResolvedValue({
            libraryDeletionEnabled: true,
        });
        mockIsBackfillNeeded.mockResolvedValue(true);
        mockGetBackfillProgress.mockResolvedValue({
            inProgress: false,
            processed: 0,
            total: 50,
        });
        mockIsBackfillInProgress.mockReturnValue(false);
        mockBackfillAllArtistCounts.mockResolvedValue(undefined);
        mockIsImageBackfillNeeded.mockResolvedValue({
            needsBackfill: true,
            totalArtists: 50,
        });
        mockGetImageBackfillProgress.mockReturnValue({
            inProgress: false,
            processed: 0,
            total: 50,
        });
        mockBackfillAllImages.mockResolvedValue(undefined);
        mockArtistFindMany.mockResolvedValue([]);
        mockArtistUpdateMany.mockResolvedValue({ count: 0 });
    });

    it("returns deny-all delete policy for non-admin users", async () => {
        const req = { user: { id: "user-1", role: "user" } } as any;
        const res = createRes();

        await deletePolicyHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            isAdmin: false,
            libraryDeletionEnabled: false,
            canDelete: false,
        });
        expect(mockGetSystemSettings).not.toHaveBeenCalled();
    });

    it("returns admin delete policy from system settings", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: false,
        });

        const req = { user: { id: "admin-1", role: "admin" } } as any;
        const res = createRes();
        await deletePolicyHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            isAdmin: true,
            libraryDeletionEnabled: false,
            canDelete: false,
        });
    });

    it("handles delete policy errors", async () => {
        mockGetSystemSettings.mockRejectedValueOnce(new Error("settings down"));

        const req = { user: { id: "admin-1", role: "admin" } } as any;
        const res = createRes();
        await invokeWithErrorHandler(deletePolicyHandler, req, res);

        expect(res.statusCode).toBe(500);
    });

    it("returns artist count status and handles status failures", async () => {
        const okRes = createRes();
        await artistCountsStatusHandler(
            { user: { id: "admin-1" } } as any,
            okRes,
        );

        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual({
            needsBackfill: true,
            inProgress: false,
            processed: 0,
            total: 50,
        });

        mockIsBackfillNeeded.mockRejectedValueOnce(new Error("status failed"));
        const errRes = createRes();
        await invokeWithErrorHandler(
            artistCountsStatusHandler,
            { user: { id: "admin-1" } } as any,
            errRes,
        );

        expect(errRes.statusCode).toBe(500);
    });

    it("handles artist count backfill in-progress, start, and trigger errors", async () => {
        mockIsBackfillInProgress.mockReturnValueOnce(true);
        const inProgressRes = createRes();
        await artistCountsBackfillHandler(
            { user: { id: "admin-1" } } as any,
            inProgressRes,
        );
        expect(inProgressRes.statusCode).toBe(200);
        expect(inProgressRes.body).toEqual({
            message: "Backfill already in progress",
            status: "processing",
        });

        mockIsBackfillInProgress.mockReturnValueOnce(false);
        const startRes = createRes();
        await artistCountsBackfillHandler(
            { user: { id: "admin-1" } } as any,
            startRes,
        );
        expect(startRes.statusCode).toBe(200);
        expect(startRes.body).toEqual({
            message: "Backfill started",
            status: "processing",
        });
        expect(mockBackfillAllArtistCounts).toHaveBeenCalledWith(
            expect.any(Function),
        );

        mockIsBackfillInProgress.mockImplementationOnce(() => {
            throw new Error("tracker unavailable");
        });
        const errRes = createRes();
        await invokeWithErrorHandler(
            artistCountsBackfillHandler,
            { user: { id: "admin-1" } } as any,
            errRes,
        );
        expect(errRes.statusCode).toBe(500);
    });

    it("logs artist-count progress on 100-item boundaries and still responds with started", async () => {
        mockIsBackfillInProgress.mockReturnValueOnce(false);
        mockBackfillAllArtistCounts.mockImplementationOnce(
            async (callback: any) => {
                callback(50, 100);
                callback(100, 100);
                callback(200, 200);
            },
        );

        const res = createRes();
        await artistCountsBackfillHandler(
            { user: { id: "admin-1" } } as any,
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Backfill started",
            status: "processing",
        });
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[ArtistCounts] Progress: 100/100",
        );
    });

    it("returns image backfill status and handles status errors", async () => {
        const okRes = createRes();
        await imageBackfillStatusHandler(
            { user: { id: "admin-1" } } as any,
            okRes,
        );
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual({
            needsBackfill: true,
            totalArtists: 50,
            inProgress: false,
            processed: 0,
            total: 50,
        });

        mockIsImageBackfillNeeded.mockRejectedValueOnce(
            new Error("image status failed"),
        );
        const errRes = createRes();
        await invokeWithErrorHandler(
            imageBackfillStatusHandler,
            { user: { id: "admin-1" } } as any,
            errRes,
        );
        expect(errRes.statusCode).toBe(500);
    });

    it("handles image backfill start in-progress, start, and trigger errors", async () => {
        mockGetImageBackfillProgress.mockReturnValueOnce({
            inProgress: true,
            processed: 7,
            total: 50,
        });
        const inProgressRes = createRes();
        await imageBackfillStartHandler(
            { user: { id: "admin-1" } } as any,
            inProgressRes,
        );
        expect(inProgressRes.statusCode).toBe(200);
        expect(inProgressRes.body).toEqual({
            message: "Image backfill already in progress",
            status: "processing",
            progress: {
                inProgress: true,
                processed: 7,
                total: 50,
            },
        });

        mockGetImageBackfillProgress.mockReturnValueOnce({
            inProgress: false,
            processed: 0,
            total: 50,
        });
        const startRes = createRes();
        await imageBackfillStartHandler(
            { user: { id: "admin-1" } } as any,
            startRes,
        );
        expect(startRes.statusCode).toBe(200);
        expect(startRes.body).toEqual({
            message: "Image backfill started",
            status: "processing",
        });
        expect(mockBackfillAllImages).toHaveBeenCalledTimes(1);

        mockGetImageBackfillProgress.mockImplementationOnce(() => {
            throw new Error("progress unavailable");
        });
        const errRes = createRes();
        await invokeWithErrorHandler(
            imageBackfillStartHandler,
            { user: { id: "admin-1" } } as any,
            errRes,
        );
        expect(errRes.statusCode).toBe(500);
    });

    it("keeps image backfill request responsive when background backfill fails", async () => {
        mockGetImageBackfillProgress.mockReturnValueOnce({
            inProgress: false,
            processed: 0,
            total: 50,
        });
        mockBackfillAllImages.mockRejectedValueOnce(new Error("boom"));

        const res = createRes();
        await imageBackfillStartHandler(
            { user: { id: "admin-1" } } as any,
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Image backfill started",
            status: "processing",
        });
        await flushPromises();
        expect(mockLoggerError).toHaveBeenCalledWith(
            "[ImageBackfill] Backfill failed:",
            expect.any(Error),
        );
    });

    it("handles genre backfill no-op, success, and failure branches", async () => {
        const emptyRes = createRes();
        await backfillGenresHandler(
            { user: { id: "admin-1" } } as any,
            emptyRes,
        );
        expect(emptyRes.statusCode).toBe(200);
        expect(emptyRes.body).toEqual({
            message: "No artists need genre backfill",
            count: 0,
        });

        mockArtistFindMany.mockResolvedValueOnce([
            { id: "artist-1", name: "Artist One", mbid: "mbid-1" },
            { id: "artist-2", name: "Artist Two", mbid: "mbid-2" },
        ]);
        mockArtistUpdateMany.mockResolvedValueOnce({ count: 2 });

        const successRes = createRes();
        await backfillGenresHandler(
            { user: { id: "admin-1" } } as any,
            successRes,
        );
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            message: "Reset 2 artists for genre enrichment",
            count: 2,
            artists: ["Artist One", "Artist Two"],
        });
        expect(mockArtistUpdateMany).toHaveBeenCalledWith({
            where: { id: { in: ["artist-1", "artist-2"] } },
            data: {
                enrichmentStatus: "pending",
                lastEnriched: null,
            },
        });

        mockArtistFindMany.mockRejectedValueOnce(
            new Error("artist query failed"),
        );
        const errRes = createRes();
        await invokeWithErrorHandler(
            backfillGenresHandler,
            { user: { id: "admin-1" } } as any,
            errRes,
        );
        expect(errRes.statusCode).toBe(500);
    });
});

describe("library stream runtime coverage", () => {
    const streamHandler = getHandler("get", "/tracks/:id/stream");

    beforeEach(() => {
        jest.clearAllMocks();
        (config.music as any).musicPath = "/music";
        (config.music as any).transcodeCachePath = "/tmp/soundspan-cache";
        (config.music as any).transcodeCacheMaxGb = 1;

        mockTrackFindUnique.mockResolvedValue(createNativeTrack());
        mockPlayFindFirst.mockResolvedValue(null);
        mockPlayCreate.mockResolvedValue({ id: "play-1" });
        mockUserSettingsFindUnique.mockResolvedValue({
            playbackQuality: "high",
        });
        mockStreamGetStreamFilePath.mockResolvedValue({
            filePath: "/tmp/soundspan-cache/track-high.mp3",
            mimeType: "audio/mpeg",
        });
        mockStreamWithRangeSupport.mockResolvedValue(undefined);
        mockStreamDestroy.mockImplementation(() => undefined);
        mockProxyFederatedTrackStream.mockResolvedValue(undefined);
        mockProxyFederatedCover.mockResolvedValue(true);
        mockLoadPeerPlaybackFallback.mockResolvedValue([]);
        mockServeMappedProviderStream.mockResolvedValue({ status: "served" });
        mockGetYtMusicUserIdOrPublic.mockResolvedValue("user-1");
        mockFederationPeerFindUnique.mockResolvedValue({
            id: "peer-1",
            name: "Peer One",
            baseUrl: "https://peer.example",
            outboundToken: "v2:encrypted-token",
            outboundStatus: "ACTIVE",
        });
    });

    it("returns 401 when stream request has no authenticated user", async () => {
        const req = {
            params: { id: "track-1" },
            query: {},
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Unauthorized" });
        expect(mockTrackFindUnique).not.toHaveBeenCalled();
    });

    it("returns 404 when requested track does not exist", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(null);

        const req = {
            params: { id: "missing-track" },
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Track not found" });
        expect(mockPlayCreate).not.toHaveBeenCalled();
    });

    it("returns 404 instead of streaming a removed track", async () => {
        mockTrackFindUnique.mockImplementationOnce(
            async ({ where }: { where: { removedAt?: null } }) =>
                where.removedAt === null ? null : createNativeTrack(),
        );
        const res = createRes();

        await streamHandler(
            {
                params: { id: "removed-track" },
                query: {},
                user: { id: "user-1" },
            } as any,
            res,
        );

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Track not found" });
        expect(mockPlayCreate).not.toHaveBeenCalled();
    });

    it("returns 404 when track has no native file path", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(
            createNativeTrack({ filePath: null, fileModified: null }),
        );

        const req = {
            params: { id: "track-1" },
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Track not available" });
        expect(mockAudioStreamingCtor).not.toHaveBeenCalled();
    });

    it("returns 404 when the DB file path traverses outside the music root", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(
            createNativeTrack({ filePath: "../../../etc/passwd" }),
        );

        const req = {
            params: { id: "track-1" },
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Track not available" });
        expect(mockAudioStreamingCtor).not.toHaveBeenCalled();
        expect(mockStreamWithRangeSupport).not.toHaveBeenCalled();
    });

    it("returns 404 when the DB file path is an absolute path outside the root", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(
            createNativeTrack({ filePath: "/etc/shadow" }),
        );

        const req = {
            params: { id: "track-1" },
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Track not available" });
        expect(mockAudioStreamingCtor).not.toHaveBeenCalled();
        expect(mockStreamWithRangeSupport).not.toHaveBeenCalled();
    });

    it("creates a play record only when no recent play exists", async () => {
        const req = {
            params: { id: "track-1" },
            query: { quality: "high" },
            user: { id: "user-9" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(mockPlayFindFirst).toHaveBeenCalledWith({
            where: {
                userId: "user-9",
                trackId: "track-1",
                playedAt: {
                    gte: expect.any(Date),
                },
            },
            orderBy: { playedAt: "desc" },
        });
        expect(mockPlayCreate).toHaveBeenCalledWith({
            data: { userId: "user-9", trackId: "track-1" },
        });
        expect(mockUserSettingsFindUnique).not.toHaveBeenCalled();
        expect(mockAudioStreamingCtor).toHaveBeenCalledWith(
            "/music",
            "/tmp/soundspan-cache",
            1,
        );
        expect(mockStreamGetStreamFilePath).toHaveBeenCalledWith(
            "track-1",
            "high",
            new Date("2024-01-01T00:00:00.000Z"),
            "/music/Artist/Album/track.flac",
        );
        expect(mockStreamWithRangeSupport).toHaveBeenCalledWith(
            req,
            res,
            "/tmp/soundspan-cache/track-high.mp3",
            "audio/mpeg",
        );
        expect(mockAudioStreamingCtor).toHaveBeenCalledTimes(1);
        expect(mockStreamDestroy).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(200);
    });

    it("uses user playback settings when quality query is not provided", async () => {
        mockUserSettingsFindUnique.mockResolvedValueOnce({
            playbackQuality: "low",
        });

        const req = {
            params: { id: "track-1" },
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(mockUserSettingsFindUnique).toHaveBeenCalledWith({
            where: { userId: "user-1" },
        });
        expect(mockStreamGetStreamFilePath).toHaveBeenCalledWith(
            "track-1",
            "low",
            new Date("2024-01-01T00:00:00.000Z"),
            "/music/Artist/Album/track.flac",
        );
    });

    it("does not create duplicate play entries when a recent play exists", async () => {
        mockPlayFindFirst.mockResolvedValueOnce({ id: "existing-play" });

        const req = {
            params: { id: "track-1" },
            query: { quality: "high" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(mockPlayCreate).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
    });

    it("falls back to original quality when ffmpeg is unavailable", async () => {
        mockStreamGetStreamFilePath
            .mockRejectedValueOnce({
                code: "FFMPEG_NOT_FOUND",
                message: "ffmpeg binary not found",
            })
            .mockResolvedValueOnce({
                filePath: "/tmp/soundspan-cache/track-original.flac",
                mimeType: "audio/flac",
            });

        const req = {
            params: { id: "track-1" },
            query: { quality: "medium" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(mockAudioStreamingCtor).toHaveBeenCalledTimes(1);
        expect(mockStreamGetStreamFilePath).toHaveBeenNthCalledWith(
            1,
            "track-1",
            "medium",
            new Date("2024-01-01T00:00:00.000Z"),
            "/music/Artist/Album/track.flac",
        );
        expect(mockStreamGetStreamFilePath).toHaveBeenNthCalledWith(
            2,
            "track-1",
            "original",
            new Date("2024-01-01T00:00:00.000Z"),
            "/music/Artist/Album/track.flac",
        );
        expect(mockStreamWithRangeSupport).toHaveBeenCalledWith(
            req,
            res,
            "/tmp/soundspan-cache/track-original.flac",
            "audio/flac",
        );
        expect(mockStreamDestroy).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(200);
    });

    it("returns 500 when native streaming fails without a recoverable fallback", async () => {
        mockStreamGetStreamFilePath.mockRejectedValueOnce(
            new Error("transcoder failed"),
        );

        const req = {
            params: { id: "track-1" },
            query: { quality: "high" },
            user: { id: "user-2" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to stream track" });
        expect(mockAudioStreamingCtor).toHaveBeenCalledTimes(1);
        expect(mockStreamWithRangeSupport).not.toHaveBeenCalled();
        expect(mockStreamDestroy).toHaveBeenCalledTimes(1);
    });

    it("returns 500 when an upstream lookup throws before streaming starts", async () => {
        mockTrackFindUnique.mockRejectedValueOnce(new Error("db unavailable"));

        const req = {
            params: { id: "track-1" },
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to stream track" });
    });

    it("proxies federated tracks and preserves local-user play logging", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(
            createNativeTrack({
                id: "fed-track-1",
                origin: "FEDERATED",
                peerId: "peer-1",
                remoteId: "remote-track-1",
                filePath: null,
            }),
        );
        const req = {
            params: { id: "fed-track-1" },
            query: { quality: "original" },
            headers: { range: "bytes=0-99" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(mockPlayCreate).toHaveBeenCalledWith({
            data: { userId: "user-1", trackId: "fed-track-1" },
        });
        expect(mockProxyFederatedTrackStream).toHaveBeenCalledWith({
            req,
            res,
            peer: {
                id: "peer-1",
                name: "Peer One",
                baseUrl: "https://peer.example",
                outboundToken: "v2:encrypted-token",
                outboundStatus: "ACTIVE",
            },
            remoteId: "remote-track-1",
            trackId: "fed-track-1",
            sourceModified: new Date("2024-01-01T00:00:00.000Z"),
            sourceMime: undefined,
            quality: "original",
        });
        expect(mockAudioStreamingCtor).not.toHaveBeenCalled();
    });

    it.each(["OFFLINE", "REVOKED"])(
        "returns typed 503 when the owning peer is %s",
        async (status) => {
            mockTrackFindUnique.mockResolvedValueOnce(
                createNativeTrack({
                    id: "fed-track-1",
                    origin: "FEDERATED",
                    peerId: "peer-1",
                    remoteId: "remote-track-1",
                    filePath: null,
                }),
            );
            mockFederationPeerFindUnique.mockResolvedValueOnce({
                id: "peer-1",
                name: "Peer One",
                baseUrl: "https://peer.example",
                outboundToken: "v2:encrypted-token",
                status,
            });
            const res = createRes();

            await streamHandler(
                {
                    params: { id: "fed-track-1" },
                    query: {},
                    headers: {},
                    user: { id: "user-1" },
                } as any,
                res,
            );

            expect(res.statusCode).toBe(503);
            expect(res.body).toEqual({
                error: "Federation peer is offline",
                code: "PEER_OFFLINE",
            });
            expect(mockPlayCreate).not.toHaveBeenCalled();
            expect(mockProxyFederatedTrackStream).not.toHaveBeenCalled();
        },
    );

    it("streams the local dedup twin when the owning peer is offline", async () => {
        mockTrackFindUnique
            .mockResolvedValueOnce(
                createNativeTrack({
                    id: "fed-track-1",
                    origin: "FEDERATED",
                    peerId: "peer-1",
                    remoteId: "remote-track-1",
                    filePath: null,
                }),
            )
            .mockResolvedValueOnce(createNativeTrack({ id: "local-twin-1" }));
        mockFederationPeerFindUnique.mockResolvedValueOnce(null);
        mockLoadPeerPlaybackFallback.mockResolvedValueOnce([
            { source: "library", trackId: "local-twin-1" },
        ]);
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValueOnce(true);
        const res = createRes();

        await streamHandler(
            {
                params: { id: "fed-track-1" },
                query: { quality: "original" },
                headers: {},
                user: { id: "user-1" },
            } as any,
            res,
        );

        expect(mockLoadPeerPlaybackFallback).toHaveBeenCalledWith(
            "fed-track-1",
        );
        expect(mockStreamWithRangeSupport).toHaveBeenCalled();
        existsSpy.mockRestore();
    });

    it("serves an existing TIDAL mapping when an offline peer has no local twin", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(
            createNativeTrack({
                id: "fed-track-1",
                origin: "FEDERATED",
                peerId: "peer-1",
                remoteId: "remote-track-1",
                filePath: null,
            }),
        );
        mockFederationPeerFindUnique.mockResolvedValueOnce(null);
        mockLoadPeerPlaybackFallback.mockResolvedValueOnce([
            { source: "tidal", tidalTrackId: 42 },
        ]);
        const req = {
            params: { id: "fed-track-1" },
            query: {},
            headers: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(mockServeMappedProviderStream).toHaveBeenCalledWith({
            req,
            res,
            userId: "user-1",
            youtubeUserId: undefined,
            quality: "high",
            trackId: "fed-track-1",
            fallback: { source: "tidal", tidalTrackId: 42 },
        });
        expect(mockAudioStreamingCtor).not.toHaveBeenCalled();
    });

    it("advances from a pre-header TIDAL failure to YouTube", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(
            createNativeTrack({
                id: "fed-track-1",
                origin: "FEDERATED",
                peerId: "peer-1",
                remoteId: "remote-track-1",
                filePath: null,
            }),
        );
        mockFederationPeerFindUnique.mockResolvedValueOnce(null);
        mockLoadPeerPlaybackFallback.mockResolvedValueOnce([
            { source: "tidal", tidalTrackId: 42 },
            { source: "ytmusic", youtubeVideoId: "video-1" },
        ]);
        mockServeMappedProviderStream
            .mockResolvedValueOnce({
                status: "failed",
                error: new Error("TIDAL unavailable"),
                responseState: {
                    headersSent: false,
                    destroyed: false,
                    writableEnded: false,
                },
            })
            .mockResolvedValueOnce({ status: "served" });
        const req = {
            params: { id: "fed-track-1" },
            query: {},
            headers: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(mockServeMappedProviderStream).toHaveBeenCalledTimes(2);
        expect(mockServeMappedProviderStream).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                youtubeUserId: "user-1",
                quality: "high",
                fallback: {
                    source: "ytmusic",
                    youtubeVideoId: "video-1",
                },
            }),
        );
        expect(res.status).not.toHaveBeenCalledWith(503);
    });

    it("returns PEER_OFFLINE after every fallback rung fails", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(
            createNativeTrack({
                id: "fed-track-1",
                origin: "FEDERATED",
                peerId: "peer-1",
                remoteId: "remote-track-1",
                filePath: null,
            }),
        );
        mockFederationPeerFindUnique.mockResolvedValueOnce(null);
        mockLoadPeerPlaybackFallback.mockResolvedValueOnce([
            { source: "tidal", tidalTrackId: 42 },
            { source: "ytmusic", youtubeVideoId: "video-1" },
        ]);
        mockServeMappedProviderStream.mockResolvedValue({
            status: "failed",
            error: new Error("provider unavailable"),
            responseState: {
                headersSent: false,
                destroyed: false,
                writableEnded: false,
            },
        });
        const res = createRes();

        await streamHandler(
            {
                params: { id: "fed-track-1" },
                query: {},
                headers: {},
                user: { id: "user-1" },
            } as any,
            res,
        );

        expect(mockServeMappedProviderStream).toHaveBeenCalledTimes(2);
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({
            error: "Federation peer is offline",
            code: "PEER_OFFLINE",
        });
    });

    it("does not advance after a mapped fallback commits headers", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(
            createNativeTrack({
                id: "fed-track-1",
                origin: "FEDERATED",
                peerId: "peer-1",
                remoteId: "remote-track-1",
                filePath: null,
            }),
        );
        mockFederationPeerFindUnique.mockResolvedValueOnce(null);
        mockLoadPeerPlaybackFallback.mockResolvedValueOnce([
            { source: "tidal", tidalTrackId: 42 },
            { source: "ytmusic", youtubeVideoId: "video-1" },
        ]);
        const res = createRes();
        res.headersSent = true;
        res.writableEnded = false;
        mockServeMappedProviderStream.mockResolvedValueOnce({
            status: "failed",
            error: new Error("stream reset"),
            responseState: {
                headersSent: true,
                destroyed: false,
                writableEnded: false,
            },
        });

        await streamHandler(
            {
                params: { id: "fed-track-1" },
                query: {},
                headers: {},
                user: { id: "user-1" },
            } as any,
            res,
        );

        expect(mockServeMappedProviderStream).toHaveBeenCalledTimes(1);
        expect(res.end).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalledWith(503);
    });

    it.each([
        [false, false, true],
        [true, false, true],
    ])(
        "stops after a mapped body failure with headersSent=%s writableEnded=%s destroyed=%s",
        async (headersSent, writableEnded, destroyed) => {
            mockTrackFindUnique.mockResolvedValueOnce(
                createNativeTrack({
                    id: "fed-track-1",
                    origin: "FEDERATED",
                    peerId: "peer-1",
                    remoteId: "remote-track-1",
                    filePath: null,
                }),
            );
            mockFederationPeerFindUnique.mockResolvedValueOnce(null);
            mockLoadPeerPlaybackFallback.mockResolvedValueOnce([
                { source: "tidal", tidalTrackId: 42 },
                { source: "ytmusic", youtubeVideoId: "video-1" },
            ]);
            mockServeMappedProviderStream.mockResolvedValueOnce({
                status: "failed",
                responseState: { headersSent, writableEnded, destroyed },
                error: new Error("body failed"),
            });
            const res = createRes();

            await streamHandler(
                {
                    params: { id: "fed-track-1" },
                    query: {},
                    headers: {},
                    user: { id: "user-1" },
                } as any,
                res,
            );

            expect(mockServeMappedProviderStream).toHaveBeenCalledTimes(1);
            expect(res.status).not.toHaveBeenCalledWith(503);
            expect(res.json).not.toHaveBeenCalled();
            expect(res.end).not.toHaveBeenCalled();
        },
    );

    it("terminates a post-headers proxy failure without a second response", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(
            createNativeTrack({
                id: "fed-track-1",
                origin: "FEDERATED",
                peerId: "peer-1",
                remoteId: "remote-track-1",
                filePath: null,
            }),
        );
        const res = createRes();
        res.headersSent = true;
        res.writableEnded = false;
        mockProxyFederatedTrackStream.mockRejectedValueOnce(
            new Error("upstream reset after headers"),
        );

        await streamHandler(
            {
                params: { id: "fed-track-1" },
                query: {},
                headers: {},
                user: { id: "user-1" },
            } as any,
            res,
        );

        expect(res.end).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalledWith(503);
    });
});
