import * as path from "path";
import type { ScanJobData } from "../scanProcessor";

describe("scanProcessor runtime behavior", () => {
    type ProgressEvent = {
        filesScanned: number;
        filesTotal: number;
    };

    type ScanResult = {
        tracksAdded: number;
        tracksUpdated: number;
        tracksRemoved: number;
        errors: Array<{ file: string; error: string }>;
        duration: number;
    };

    type LoadScanProcessorOptions = {
        scanResult?: ScanResult;
        scanError?: Error;
        progressEvents?: ProgressEvent[];
        activeJobs?: Array<{
            id: string;
            targetMbid?: string;
            type?: string;
            status?: string;
            lidarrRef?: string | null;
            discoveryBatchId?: string | null;
            metadata?: Record<string, unknown> | null;
        }>;
        candidateAlbums?: Array<{
            id?: string;
            title: string;
            artistName?: string;
            trackCount?: number;
            tracks?: Array<{ id: string }>;
            artist?: { name: string; enrichmentStatus?: string };
        }>;
        fuzzyMatchImpl?: (
            artistName: string,
            albumTitle: string,
            candidateArtistName: string,
            candidateAlbumTitle: string,
            threshold: number,
        ) => boolean;
        artistByMbid?: {
            mbid: string;
            name: string;
            enrichmentStatus: string;
        } | null;
        albumByRgMbid?: {
            id?: string;
            rgMbid: string;
            title: string;
            trackCount?: number;
            artist: { name: string; enrichmentStatus: string };
        } | null;
        tracksNeedingTags?: number;
    };

    afterEach(() => {
        jest.useRealTimers();
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadScanProcessor(options: LoadScanProcessorOptions = {}) {
        const logger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            child: jest.fn(),
        };
        logger.child.mockReturnValue(logger);

        const scanResult: ScanResult = options.scanResult ?? {
            tracksAdded: 0,
            tracksUpdated: 0,
            tracksRemoved: 0,
            errors: [],
            duration: 1,
        };
        const progressEvents = options.progressEvents ?? [];

        const config = {
            music: {
                transcodeCachePath: "/tmp/transcode-cache",
                musicPath: "/library/music",
            },
        };

        const downloadJobs = (options.activeJobs ?? []).map((job) => ({
            targetMbid: "",
            type: "album",
            status: "pending",
            lidarrRef: null,
            discoveryBatchId: null,
            metadata: null,
            ...job,
        }));
        const albumByRgMbid = options.albumByRgMbid
            ? { id: "album-by-rg-mbid", ...options.albumByRgMbid }
            : null;
        const candidateAlbums = (options.candidateAlbums ?? []).map(
            (album, index) => ({
                id: album.id ?? `candidate-${index}`,
                title: album.title,
                artistName: album.artistName ?? album.artist?.name ?? "",
                trackCount: album.trackCount ?? album.tracks?.length ?? 0,
            }),
        );

        function matchesDownloadJob(job: any, where: any): boolean {
            if (where?.status?.in && !where.status.in.includes(job.status)) {
                return false;
            }
            if (where?.targetMbid && job.targetMbid !== where.targetMbid) {
                return false;
            }
            if (where?.type && job.type !== where.type) return false;
            if (where?.lidarrRef && job.lidarrRef !== where.lidarrRef) {
                return false;
            }
            if (where?.id?.in && !where.id.in.includes(job.id)) return false;
            if (where?.metadata?.path?.[0]) {
                const metadata = job.metadata ?? {};
                if (
                    metadata[where.metadata.path[0]] !== where.metadata.equals
                ) {
                    return false;
                }
            }
            return true;
        }

        const prisma = {
            $queryRaw: jest.fn(async () =>
                candidateAlbums.map((album) => ({
                    id: album.id,
                    title: album.title,
                    artistName: album.artistName,
                })),
            ),
            downloadJob: {
                findMany: jest.fn(async (args: any) =>
                    downloadJobs.filter((job) =>
                        matchesDownloadJob(job, args?.where),
                    ),
                ),
                updateMany: jest.fn(async (args: any) => {
                    const matchedJobs = downloadJobs.filter((job) =>
                        matchesDownloadJob(job, args?.where),
                    );
                    for (const matchedJob of matchedJobs) {
                        Object.assign(matchedJob, args.data);
                    }
                    return { count: matchedJobs.length };
                }),
            },
            album: {
                findFirst: jest.fn(async () => albumByRgMbid),
            },
            artist: {
                findUnique: jest.fn(async () => options.artistByMbid ?? null),
            },
            track: {
                count: jest.fn(async () => options.tracksNeedingTags ?? 0),
                groupBy: jest.fn(async (args: any) => {
                    const counts = new Map(
                        candidateAlbums.map((album) => [
                            album.id,
                            album.trackCount,
                        ]),
                    );
                    if (albumByRgMbid) {
                        counts.set(
                            albumByRgMbid.id,
                            albumByRgMbid.trackCount ?? 0,
                        );
                    }
                    return (args?.where?.albumId?.in ?? []).flatMap(
                        (albumId: string) => {
                            const count = counts.get(albumId) ?? 0;
                            return count > 0
                                ? [{ albumId, _count: { _all: count } }]
                                : [];
                        },
                    );
                }),
            },
        };

        const matchAlbum = jest.fn(options.fuzzyMatchImpl ?? (() => false));
        const enrichSimilarArtist = jest.fn(async () => undefined);

        const discoverWeeklyService = {
            checkBatchCompletion: jest.fn(async () => undefined),
            buildFinalPlaylist: jest.fn(async () => undefined),
            reconcileDiscoveryTracks: jest.fn(async () => ({
                tracksAdded: 0,
                batchesChecked: 0,
            })),
        };

        const spotifyImportService = {
            buildPlaylistAfterScan: jest.fn(async () => undefined),
            reconcilePendingTracks: jest.fn(async () => ({
                tracksAdded: 0,
                playlistsUpdated: 0,
            })),
        };

        const notificationService = {
            notifySystem: jest.fn(async () => undefined),
        };

        const triggerEnrichmentNow = jest.fn(async () => ({
            artists: 0,
            tracks: 0,
            audioQueued: 0,
        }));

        const scannerInstances: Array<{
            progressCallback: (progress: ProgressEvent) => void;
            coverCachePath: string;
            scanLibrary: jest.Mock;
        }> = [];

        const MusicScannerService = jest
            .fn()
            .mockImplementation(
                (
                    progressCallback: (progress: ProgressEvent) => void,
                    coverCachePath: string,
                ) => {
                    const scanLibrary = jest.fn(async () => {
                        for (const event of progressEvents) {
                            progressCallback(event);
                        }

                        if (options.scanError) {
                            throw options.scanError;
                        }

                        return scanResult;
                    });

                    const instance = {
                        progressCallback,
                        coverCachePath,
                        scanLibrary,
                    };
                    scannerInstances.push(instance);
                    return instance;
                },
            );

        jest.doMock("../../../utils/logger", () => ({ logger }));
        jest.doMock("../../../services/musicScanner", () => ({
            MusicScannerService,
        }));
        jest.doMock("../../../config", () => ({ config }));
        jest.doMock("../../../utils/db", () => ({ prisma }));
        jest.doMock("../../../utils/fuzzyMatch", () => ({ matchAlbum }));
        jest.doMock("../../../services/discoverWeekly", () => ({
            discoverWeeklyService,
        }));
        jest.doMock("../../artistEnrichment", () => ({ enrichSimilarArtist }));
        jest.doMock("../../../services/spotifyImport", () => ({
            spotifyImportService,
        }));
        jest.doMock("../../../services/notificationService", () => ({
            notificationService,
        }));
        jest.doMock("../../unifiedEnrichment", () => ({
            triggerEnrichmentNow,
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../scanProcessor");

        return {
            module,
            logger,
            config,
            prisma,
            downloadJobs,
            scannerInstances,
            MusicScannerService,
            matchAlbum,
            discoverWeeklyService,
            enrichSimilarArtist,
            spotifyImportService,
            notificationService,
            triggerEnrichmentNow,
        };
    }

    function createJob(
        dataOverrides: Record<string, unknown> = {},
        progressImpl?: (value: number) => Promise<void>,
    ) {
        return {
            id: "job-1",
            data: {
                userId: "system",
                source: "scheduled",
                ...dataOverrides,
            },
            progress: jest.fn(
                progressImpl ??
                    (async (_value: number) => {
                        return undefined;
                    }),
            ),
        } as any;
    }

    async function flushPromises(): Promise<void> {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    it("accepts a null user for recovery scan jobs", () => {
        const data: ScanJobData = { userId: null };

        expect(data.userId).toBeNull();
    });

    it("reconcile path returns 0 when no active download jobs exist", async () => {
        const { module, prisma, matchAlbum, discoverWeeklyService } =
            loadScanProcessor({
                scanResult: {
                    tracksAdded: 3,
                    tracksUpdated: 1,
                    tracksRemoved: 0,
                    errors: [],
                    duration: 20,
                },
                activeJobs: [],
            });
        const job = createJob();

        await expect(module.processScan(job)).resolves.toEqual(
            expect.objectContaining({
                tracksAdded: 3,
            }),
        );

        expect(prisma.downloadJob.findMany).toHaveBeenCalledTimes(1);
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(matchAlbum).not.toHaveBeenCalled();
        expect(
            discoverWeeklyService.checkBatchCompletion,
        ).not.toHaveBeenCalled();

        const reconcileUpdateCalls =
            prisma.downloadJob.updateMany.mock.calls.filter(
                (call: any[]) => call[0]?.where?.id?.in,
            );
        expect(reconcileUpdateCalls).toHaveLength(0);
    });

    it("reconcile path returns 0 when active jobs lack match metadata", async () => {
        const { module, prisma, matchAlbum } = loadScanProcessor({
            scanResult: {
                tracksAdded: 1,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
                duration: 5,
            },
            activeJobs: [
                {
                    id: "dl-1",
                    metadata: { artistName: "Only Artist Name" },
                },
                {
                    id: "dl-2",
                    metadata: { albumTitle: "Only Album Title" },
                },
            ],
        });

        await module.processScan(createJob());

        expect(prisma.downloadJob.findMany).toHaveBeenCalledTimes(1);
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(matchAlbum).not.toHaveBeenCalled();
        expect(prisma.downloadJob.updateMany).not.toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: expect.anything(),
                }),
            }),
        );
    });

    it("reconcile path returns 0 when metadata exists but no exact or fuzzy match is found", async () => {
        const { module, prisma, matchAlbum, discoverWeeklyService } =
            loadScanProcessor({
                scanResult: {
                    tracksAdded: 2,
                    tracksUpdated: 0,
                    tracksRemoved: 0,
                    errors: [],
                    duration: 12,
                },
                activeJobs: [
                    {
                        id: "dl-1",
                        discoveryBatchId: "batch-no-match",
                        metadata: {
                            artistName: "Known Artist",
                            albumTitle: "Known Album",
                        },
                    },
                ],
                candidateAlbums: [
                    {
                        title: "Completely Different",
                        tracks: [{ id: "track-1" }],
                        artist: { name: "Other Artist" },
                    },
                ],
            });

        await module.processScan(createJob());

        expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
        expect(matchAlbum).toHaveBeenCalledWith(
            "Known Artist",
            "Known Album",
            "Other Artist",
            "Completely Different",
            0.75,
        );
        expect(
            discoverWeeklyService.checkBatchCompletion,
        ).not.toHaveBeenCalled();

        const reconcileUpdateCalls =
            prisma.downloadJob.updateMany.mock.calls.filter(
                (call: any[]) => call[0]?.where?.id?.in,
            );
        expect(reconcileUpdateCalls).toHaveLength(0);
    });

    it("reconcile path completes exact and fuzzy matches and checks unique discovery batches", async () => {
        const rig = loadScanProcessor({
            scanResult: {
                tracksAdded: 4,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
                duration: 30,
            },
            activeJobs: [
                {
                    id: "dl-exact-1",
                    discoveryBatchId: "batch-1",
                    metadata: {
                        artistName: "Exact Artist",
                        albumTitle: "Exact Album",
                    },
                },
                {
                    id: "dl-fuzzy",
                    discoveryBatchId: "batch-1",
                    metadata: {
                        artistName: "Artist Two",
                        albumTitle: "Fuzzy Album",
                    },
                },
                {
                    id: "dl-exact-2",
                    discoveryBatchId: "batch-2",
                    metadata: {
                        artistName: "Third Artist",
                        albumTitle: "Third Album",
                    },
                },
            ],
            candidateAlbums: [
                {
                    title: "Exact Album Deluxe",
                    tracks: [{ id: "track-a" }],
                    artist: { name: "Exact Artist" },
                },
                {
                    title: "Not Matching Title",
                    tracks: [{ id: "track-b" }],
                    artist: { name: "A2" },
                },
                {
                    title: "Third Album Remastered",
                    tracks: [{ id: "track-c" }],
                    artist: { name: "Third Artist feat. Guest" },
                },
            ],
            fuzzyMatchImpl: (
                artistName,
                albumTitle,
                candidateArtistName,
                candidateAlbumTitle,
                threshold,
            ) => {
                return (
                    artistName === "Artist Two" &&
                    albumTitle === "Fuzzy Album" &&
                    candidateArtistName === "A2" &&
                    candidateAlbumTitle === "Not Matching Title" &&
                    threshold === 0.75
                );
            },
        });
        const { module, prisma, logger, discoverWeeklyService } = rig;

        await module.processScan(createJob());

        const reconcileUpdateCalls =
            prisma.downloadJob.updateMany.mock.calls.filter(
                (call: any[]) => call[0]?.where?.id?.in,
            );
        expect(reconcileUpdateCalls).toHaveLength(1);
        expect(reconcileUpdateCalls[0][0]).toEqual(
            expect.objectContaining({
                where: {
                    id: { in: ["dl-exact-1", "dl-fuzzy", "dl-exact-2"] },
                },
                data: expect.objectContaining({
                    status: "completed",
                    error: null,
                }),
            }),
        );
        expect(discoverWeeklyService.checkBatchCompletion.mock.calls).toEqual([
            ["batch-1"],
            ["batch-2"],
        ]);
        expect(logger.debug).toHaveBeenCalledWith(
            "✓ Reconciled 3 download job(s) with scanned albums",
        );
        expect(logger.error).not.toHaveBeenCalledWith(
            "Failed to reconcile download jobs:",
            expect.anything(),
        );
    });

    it("bounds active jobs and candidate queries for a large queue", async () => {
        const activeJobs = Array.from({ length: 501 }, (_unused, index) => ({
            id: `dl-${index.toString().padStart(3, "0")}`,
            metadata: {
                artistName: `${index.toString().padStart(5, "0")} Artist`,
                albumTitle: `Album ${index}`,
            },
        }));
        const { module, prisma, logger } = loadScanProcessor({
            scanResult: {
                tracksAdded: 1,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
                duration: 1,
            },
            activeJobs,
        });

        await module.processScan(createJob());

        expect(prisma.downloadJob.findMany).toHaveBeenCalledWith({
            where: { status: { in: ["pending", "processing"] } },
            select: { id: true, metadata: true, discoveryBatchId: true },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: 501,
        });
        expect(prisma.$queryRaw).toHaveBeenCalledTimes(5);
        const queryRawCalls = prisma.$queryRaw.mock.calls as unknown as Array<
            [{ text: string; values: unknown[] }]
        >;
        const queryPatternCounts = queryRawCalls.map(
            ([query]: [{ values: unknown[] }]) =>
                (query.values[0] as string[]).length,
        );
        expect(queryPatternCounts).toEqual([100, 100, 100, 100, 100]);
        for (const [query] of queryRawCalls) {
            expect(query.text).toContain("ILIKE ANY($1::text[])");
            expect(query.text).not.toContain(" OR ");
            expect(query.values[1]).toBe(1001);
        }
        expect(logger.warn).toHaveBeenCalledWith(
            "Scan reconciliation active-job cap truncated work",
            expect.objectContaining({
                processedJobs: 500,
                deferredJobsAtLeast: 1,
            }),
        );
    });

    it("reports progress callback updates and logs callback progress failures", async () => {
        const { module, logger } = loadScanProcessor({
            progressEvents: [{ filesScanned: 3, filesTotal: 5 }],
            scanResult: {
                tracksAdded: 0,
                tracksUpdated: 2,
                tracksRemoved: 1,
                errors: [],
                duration: 9,
            },
        });

        const job = createJob({}, async (value: number) => {
            if (value === 60) {
                throw new Error("progress write failed");
            }
        });

        await module.processScan(job);
        await flushPromises();

        expect(job.progress).toHaveBeenCalledWith(0);
        expect(job.progress).toHaveBeenCalledWith(60);
        expect(job.progress).toHaveBeenCalledWith(100);
        expect(logger.error).toHaveBeenCalledWith(
            "Failed to update job progress:",
            expect.any(Error),
        );
    });

    it("returns successful scan results and skips reconcile when no tracks were added", async () => {
        const scanResult: ScanResult = {
            tracksAdded: 0,
            tracksUpdated: 7,
            tracksRemoved: 1,
            errors: [],
            duration: 44,
        };
        const {
            module,
            prisma,
            scannerInstances,
            MusicScannerService,
            config,
        } = loadScanProcessor({ scanResult });
        const job = createJob({
            musicPath: "/custom/library/music",
        });

        await expect(module.processScan(job)).resolves.toEqual(scanResult);

        expect(MusicScannerService).toHaveBeenCalledTimes(1);
        expect(scannerInstances[0].coverCachePath).toBe(
            path.join(config.music.transcodeCachePath, "../covers"),
        );
        expect(scannerInstances[0].scanLibrary).toHaveBeenCalledWith(
            "/custom/library/music",
        );
        expect(job.progress).toHaveBeenCalledWith(0);
        expect(job.progress).toHaveBeenCalledWith(100);
        expect(prisma.downloadJob.findMany).not.toHaveBeenCalled();
    });

    it("updates artist, album, and lidarr-ref jobs for lidarr-triggered scans", async () => {
        const rig = loadScanProcessor({
            scanResult: {
                tracksAdded: 1,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
                duration: 11,
            },
            artistByMbid: {
                mbid: "artist-mbid-1",
                name: "Pending Artist",
                enrichmentStatus: "pending",
            },
            albumByRgMbid: {
                id: "album-local-1",
                rgMbid: "album-mbid-1",
                title: "Imported Album",
                trackCount: 1,
                artist: {
                    name: "Album Artist",
                    enrichmentStatus: "pending",
                },
            },
            activeJobs: [
                {
                    id: "artist-job",
                    targetMbid: "artist-mbid-1",
                    type: "artist",
                },
                {
                    id: "album-job",
                    targetMbid: "album-mbid-1",
                    type: "album",
                },
                {
                    id: "lidarr-job",
                    targetMbid: "other-album-mbid",
                    type: "album",
                    lidarrRef: "lidarr-download-42",
                    metadata: { albumTitle: "Other Album" },
                },
            ],
        });
        const { module, prisma, downloadJobs, enrichSimilarArtist } = rig;
        const job = createJob({
            source: "lidarr-webhook",
            artistMbid: "artist-mbid-1",
            albumMbid: "album-mbid-1",
            downloadId: "lidarr-download-42",
        });

        await module.processScan(job);

        expect(prisma.downloadJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    targetMbid: "artist-mbid-1",
                    type: "artist",
                }),
                data: expect.objectContaining({
                    status: "completed",
                }),
            }),
        );
        expect(downloadJobs).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: "album-job",
                    status: "completed",
                }),
                expect.objectContaining({
                    id: "lidarr-job",
                    status: "completed",
                }),
            ]),
        );
        expect(prisma.downloadJob.findMany).toHaveBeenCalledWith({
            where: {
                targetMbid: "album-mbid-1",
                type: "album",
                status: { in: ["pending", "processing"] },
            },
            select: { id: true, metadata: true },
        });
        expect(prisma.downloadJob.findMany).toHaveBeenCalledWith({
            where: {
                lidarrRef: "lidarr-download-42",
                status: { in: ["pending", "processing"] },
            },
            select: { id: true, metadata: true },
        });
        expect(prisma.artist.findUnique).toHaveBeenCalledWith({
            where: { mbid: "artist-mbid-1" },
        });
        expect(prisma.album.findFirst).toHaveBeenCalledWith({
            where: { rgMbid: "album-mbid-1" },
            include: { artist: true },
        });
        expect(enrichSimilarArtist).toHaveBeenCalledTimes(2);
        expect(enrichSimilarArtist).toHaveBeenCalledWith(
            expect.objectContaining({
                name: "Pending Artist",
            }),
        );
        expect(enrichSimilarArtist).toHaveBeenCalledWith(
            expect.objectContaining({
                name: "Album Artist",
            }),
        );
    });

    const completenessPaths = [
        {
            name: "MBID",
            job: {
                id: "mbid-job",
                targetMbid: "album-mbid-1",
                metadata: {
                    albumTitle: "Different Title",
                    expectedTracks: 10,
                },
            },
            scanData: {},
        },
        {
            name: "title fallback",
            job: {
                id: "title-job",
                targetMbid: "different-mbid",
                metadata: {
                    albumTitle: "Imported Album",
                    expectedTracks: 10,
                },
            },
            scanData: {},
        },
        {
            name: "lidarrRef",
            job: {
                id: "lidarr-job",
                targetMbid: "different-mbid",
                lidarrRef: "lidarr-download-42",
                metadata: {
                    albumTitle: "Different Title",
                    expectedTracks: 10,
                },
            },
            scanData: { downloadId: "lidarr-download-42" },
        },
    ];

    it.each(completenessPaths)(
        "leaves a partial expected-track job active through the $name path",
        async ({ job: activeJob, scanData }) => {
            const { module, prisma, downloadJobs } = loadScanProcessor({
                activeJobs: [{ ...activeJob, status: "processing" }],
                albumByRgMbid: {
                    id: "album-local-1",
                    rgMbid: "album-mbid-1",
                    title: "Imported Album",
                    trackCount: 9,
                    artist: {
                        name: "Album Artist",
                        enrichmentStatus: "complete",
                    },
                },
            });

            await module.processScan(
                createJob({
                    source: "lidarr-webhook",
                    albumMbid: "album-mbid-1",
                    ...scanData,
                }),
            );

            expect(downloadJobs).toEqual([
                expect.objectContaining({
                    id: activeJob.id,
                    status: "processing",
                }),
            ]);
            expect(prisma.track.groupBy).toHaveBeenCalledWith({
                by: ["albumId"],
                where: {
                    albumId: { in: ["album-local-1"] },
                    origin: "LOCAL",
                    removedAt: null,
                    album: { location: { in: ["LIBRARY", "DISCOVER"] } },
                },
                _count: { _all: true },
            });
        },
    );

    it.each(completenessPaths)(
        "completes an expected-track job through the $name path when the album is complete",
        async ({ job: activeJob, scanData }) => {
            const { module, downloadJobs } = loadScanProcessor({
                activeJobs: [{ ...activeJob, status: "processing" }],
                albumByRgMbid: {
                    id: "album-local-1",
                    rgMbid: "album-mbid-1",
                    title: "Imported Album",
                    trackCount: 10,
                    artist: {
                        name: "Album Artist",
                        enrichmentStatus: "complete",
                    },
                },
            });

            await module.processScan(
                createJob({
                    source: "lidarr-webhook",
                    albumMbid: "album-mbid-1",
                    ...scanData,
                }),
            );

            expect(downloadJobs).toEqual([
                expect.objectContaining({
                    id: activeJob.id,
                    status: "completed",
                }),
            ]);
        },
    );

    it("falls back to album title matching when MBID-based album job updates match 0 rows", async () => {
        const { module, prisma, downloadJobs } = loadScanProcessor({
            scanResult: {
                tracksAdded: 1,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
                duration: 5,
            },
            activeJobs: [
                {
                    id: "title-match-job",
                    targetMbid: "different-mbid",
                    metadata: { albumTitle: "Imported Album" },
                },
            ],
            albumByRgMbid: {
                rgMbid: "album-mbid-1",
                title: "Imported Album",
                artist: {
                    name: "Album Artist",
                    enrichmentStatus: "pending",
                },
            },
        });
        const job = createJob({
            source: "lidarr-webhook",
            albumMbid: "album-mbid-1",
            userId: "system",
        });

        await module.processScan(job);

        expect(prisma.downloadJob.findMany).toHaveBeenCalledWith({
            where: {
                targetMbid: "album-mbid-1",
                type: "album",
                status: { in: ["pending", "processing"] },
            },
            select: { id: true, metadata: true },
        });
        expect(prisma.album.findFirst).toHaveBeenCalledWith({
            where: { rgMbid: "album-mbid-1" },
            include: { artist: true },
        });
        expect(prisma.downloadJob.findMany).toHaveBeenCalledWith({
            where: {
                type: "album",
                metadata: {
                    path: ["albumTitle"],
                    equals: "Imported Album",
                },
                status: { in: ["pending", "processing"] },
            },
            select: { id: true, metadata: true },
        });
        expect(downloadJobs).toEqual([
            expect.objectContaining({
                id: "title-match-job",
                status: "completed",
            }),
        ]);
    });

    it("logs when album title fallback still does not find pending downloads", async () => {
        const { module, logger } = loadScanProcessor({
            scanResult: {
                tracksAdded: 1,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
                duration: 5,
            },
            albumByRgMbid: {
                rgMbid: "album-mbid-1",
                title: "Imported Album",
                artist: {
                    name: "Album Artist",
                    enrichmentStatus: "pending",
                },
            },
        });
        const job = createJob({
            source: "lidarr-webhook",
            albumMbid: "album-mbid-1",
            userId: "system",
        });

        await module.processScan(job);

        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining(
                "No pending downloads found for: Album Artist - Imported Album",
            ),
        );
    });

    it("runs spotify import playlist completion checks for spotify-import scans", async () => {
        const { module, spotifyImportService } = loadScanProcessor({
            scanResult: {
                tracksAdded: 0,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
                duration: 8,
            },
        });
        const job = createJob({
            source: "spotify-import",
            spotifyImportJobId: "spotify-job-1",
        });

        await module.processScan(job);

        expect(
            spotifyImportService.buildPlaylistAfterScan,
        ).toHaveBeenCalledWith("spotify-job-1");
        expect(
            spotifyImportService.reconcilePendingTracks,
        ).not.toHaveBeenCalled();
    });

    it("logs discovery weekly playlist build completion and ignores recoverable errors", async () => {
        const { module, discoverWeeklyService } = loadScanProcessor({
            scanResult: {
                tracksAdded: 0,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
                duration: 8,
            },
        });
        const job = createJob({
            source: "discover-weekly-completion",
            discoveryBatchId: "batch-55",
        });

        await module.processScan(job);

        expect(discoverWeeklyService.buildFinalPlaylist).toHaveBeenCalledWith(
            "batch-55",
        );
        expect(discoverWeeklyService.buildFinalPlaylist).toHaveBeenCalledTimes(
            1,
        );
    });

    it("logs discovery weekly playlist build failures without failing the scan", async () => {
        const { module, logger, discoverWeeklyService } = loadScanProcessor();
        const job = createJob({
            source: "discover-weekly-completion",
            discoveryBatchId: "batch-66",
        });
        discoverWeeklyService.buildFinalPlaylist.mockRejectedValueOnce(
            new Error("dw-build-failed"),
        );

        await module.processScan(job);

        expect(logger.error).toHaveBeenCalledWith(
            " Failed to build Discovery playlist:",
            "dw-build-failed",
        );
    });

    it("logs spotify import playlist build failures without failing the scan", async () => {
        const { module, logger, spotifyImportService } = loadScanProcessor({
            scanResult: {
                tracksAdded: 0,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
                duration: 8,
            },
        });
        const job = createJob({
            source: "spotify-import",
            spotifyImportJobId: "spotify-job-1",
        });
        spotifyImportService.buildPlaylistAfterScan.mockRejectedValueOnce(
            new Error("spotify-build-failed"),
        );

        await module.processScan(job);

        expect(logger.error).toHaveBeenCalledWith(
            " Failed to build Spotify Import playlist:",
            "spotify-build-failed",
        );
    });

    it("sends manual scan notification when no source is present", async () => {
        const { module, notificationService } = loadScanProcessor({
            scanResult: {
                tracksAdded: 1,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
                duration: 12,
            },
        });
        const job = createJob({
            source: undefined,
            userId: "user-1",
        });

        await module.processScan(job);

        expect(notificationService.notifySystem).toHaveBeenCalledWith(
            "user-1",
            "Library Scan Complete",
            "Added 1 tracks, updated 0, removed 0",
        );
    });

    it("logs but does not fail when manual scan notification fails", async () => {
        const { module, logger, notificationService } = loadScanProcessor({
            scanResult: {
                tracksAdded: 0,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
                duration: 1,
            },
        });
        const job = createJob({
            source: undefined,
            userId: "user-1",
        });
        notificationService.notifySystem.mockRejectedValueOnce(
            new Error("notify-failed"),
        );

        await expect(module.processScan(job)).resolves.toEqual(
            expect.objectContaining({
                tracksAdded: 0,
            }),
        );
        expect(logger.error).toHaveBeenCalledWith(
            "Failed to send notification:",
            expect.any(Error),
        );
    });

    it("reconciles pending Spotify tracks and notifies user", async () => {
        const { module, spotifyImportService, logger, notificationService } =
            loadScanProcessor({
                scanResult: {
                    tracksAdded: 0,
                    tracksUpdated: 0,
                    tracksRemoved: 0,
                    errors: [],
                    duration: 6,
                },
            });
        const job = createJob({
            source: undefined,
            userId: "user-1",
        });
        spotifyImportService.reconcilePendingTracks.mockResolvedValueOnce({
            tracksAdded: 3,
            playlistsUpdated: 2,
        });

        await module.processScan(job);

        expect(
            spotifyImportService.reconcilePendingTracks,
        ).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith(
            "✓ Reconciled 3 pending tracks to 2 playlists",
        );
        expect(notificationService.notifySystem).toHaveBeenCalledWith(
            "user-1",
            "Playlist Tracks Matched",
            "3 previously unmatched tracks were added to your playlists",
        );
    });

    it("logs Spotify reconcile pending failures without failing scan", async () => {
        const { module, spotifyImportService, logger } = loadScanProcessor({
            scanResult: {
                tracksAdded: 0,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
                duration: 6,
            },
        });
        const job = createJob({
            source: undefined,
            userId: "user-1",
        });
        spotifyImportService.reconcilePendingTracks.mockRejectedValueOnce(
            new Error("reconcile-failed"),
        );

        await module.processScan(job);

        expect(logger.error).toHaveBeenCalledWith(
            "Failed to reconcile pending tracks:",
            expect.any(Error),
        );
    });

    it("logs discovery weekly track reconciliation and continues on success", async () => {
        const { module, discoverWeeklyService, logger } = loadScanProcessor({
            scanResult: {
                tracksAdded: 1,
                tracksUpdated: 1,
                tracksRemoved: 0,
                errors: [],
                duration: 20,
            },
        });
        discoverWeeklyService.reconcileDiscoveryTracks.mockResolvedValueOnce({
            tracksAdded: 4,
            batchesChecked: 2,
        });
        const job = createJob({
            source: undefined,
            userId: "user-1",
        });

        await module.processScan(job);

        expect(
            discoverWeeklyService.reconcileDiscoveryTracks,
        ).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith(
            "Discovery Weekly reconciliation: 4 tracks added across 2 batches",
        );
    });

    it("logs discovery weekly reconciliation failures and continues", async () => {
        const { module, discoverWeeklyService, logger } = loadScanProcessor({
            scanResult: {
                tracksAdded: 1,
                tracksUpdated: 1,
                tracksRemoved: 0,
                errors: [],
                duration: 20,
            },
        });
        const job = createJob({
            source: undefined,
            userId: "user-1",
        });
        discoverWeeklyService.reconcileDiscoveryTracks.mockRejectedValueOnce(
            new Error("reconcile-weekly-failed"),
        );

        await module.processScan(job);

        expect(logger.error).toHaveBeenCalledWith(
            "Discovery Weekly reconciliation failed:",
            expect.any(Error),
        );
    });

    it("triggers mood tag enrichment when new tracks need tags", async () => {
        const { module, prisma, logger, triggerEnrichmentNow } =
            loadScanProcessor({
                scanResult: {
                    tracksAdded: 5,
                    tracksUpdated: 0,
                    tracksRemoved: 0,
                    errors: [],
                    duration: 11,
                },
                tracksNeedingTags: 2,
            });
        triggerEnrichmentNow.mockResolvedValueOnce({
            artists: 0,
            tracks: 7,
            audioQueued: 0,
        });

        await module.processScan(createJob());
        await flushPromises();

        expect(prisma.track.count).toHaveBeenCalledWith({
            where: {
                OR: [
                    { lastfmTags: { isEmpty: true } },
                    { lastfmTags: { equals: null } },
                ],
            },
        });
        expect(logger.debug).toHaveBeenCalledWith(
            "Found 2 tracks needing mood tags, triggering enrichment...",
        );
        expect(logger.debug).toHaveBeenCalledWith(
            "Mood tag enrichment completed: 7 tracks enriched",
        );
    });

    it("skips immediate mood-tag enrichment when no tracks need tags", async () => {
        const { module, logger, prisma, triggerEnrichmentNow } =
            loadScanProcessor({
                scanResult: {
                    tracksAdded: 4,
                    tracksUpdated: 0,
                    tracksRemoved: 0,
                    errors: [],
                    duration: 9,
                },
                tracksNeedingTags: 0,
            });
        await module.processScan(createJob());

        expect(prisma.track.count).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith(
            "No tracks need immediate mood tag enrichment",
        );
        expect(triggerEnrichmentNow).not.toHaveBeenCalled();
    });

    it("logs mood-tag enrichment failures without failing scan", async () => {
        const { module, triggerEnrichmentNow, logger } = loadScanProcessor({
            scanResult: {
                tracksAdded: 2,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
                duration: 2,
            },
            tracksNeedingTags: 1,
        });
        triggerEnrichmentNow.mockRejectedValueOnce(new Error("trigger-failed"));

        await module.processScan(createJob());
        await flushPromises();

        expect(logger.error).toHaveBeenCalledWith(
            "Mood tag enrichment failed:",
            expect.any(Error),
        );
    });

    it("logs discovery job count errors in mood-tag reconciliation path", async () => {
        const { module, prisma, logger } = loadScanProcessor({
            scanResult: {
                tracksAdded: 2,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
                duration: 2,
            },
        });
        prisma.track.count.mockRejectedValueOnce(new Error("count-failed"));

        await module.processScan(createJob());

        expect(logger.error).toHaveBeenCalledWith(
            "Failed to check for mood tag enrichment:",
            expect.any(Error),
        );
    });

    it("logs artist enrichment trigger failures while continuing lidarr scan flow", async () => {
        const { module, prisma, logger } = loadScanProcessor({
            scanResult: {
                tracksAdded: 0,
                tracksUpdated: 0,
                tracksRemoved: 0,
                errors: [],
                duration: 2,
            },
            artistByMbid: {
                mbid: "artist-mbid-1",
                name: "Artist Trigger Fail",
                enrichmentStatus: "pending",
            },
            albumByRgMbid: null,
        });
        prisma.artist.findUnique.mockRejectedValueOnce(
            new Error("artist-lookup-failed"),
        );
        const job = createJob({
            source: "lidarr-webhook",
            artistMbid: "artist-mbid-1",
        });

        await module.processScan(job);

        expect(logger.error).toHaveBeenCalledWith(
            "  Failed to trigger enrichment:",
            expect.any(Error),
        );
    });

    it("logs and rethrows scanner failures", async () => {
        const scanError = new Error("scan exploded");
        const { module, logger } = loadScanProcessor({
            scanError,
        });
        const job = createJob();

        await expect(module.processScan(job)).rejects.toThrow("scan exploded");
        expect(job.progress).toHaveBeenCalledWith(0);
        expect(job.progress).not.toHaveBeenCalledWith(100);
        expect(logger.error).toHaveBeenCalledWith("Scan failed:", scanError);
    });
});
