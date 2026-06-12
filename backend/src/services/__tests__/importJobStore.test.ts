describe("import job store", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function setupImportJobStoreMocks() {
        const prisma = {
            importJob: {
                create: jest.fn(async ({ data }) => ({
                    id: "import-job-1",
                    createdAt: new Date("2026-03-14T18:30:00.000Z"),
                    updatedAt: new Date("2026-03-14T18:30:00.000Z"),
                    ...data,
                })),
                update: jest.fn(async ({ where, data }) => ({
                    id: where.id,
                    userId: "user-1",
                    sourceType: "spotify",
                    sourceId: "37i9dQZF1DX4JAvHpjipBk",
                    sourceUrl:
                        "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk",
                    normalizedSource: "spotify:37i9dQZF1DX4JAvHpjipBk",
                    playlistName: "Weekend Mix",
                    requestedPlaylistName: null,
                    status: "resolving",
                    progress: 45,
                    summary: null,
                    resolvedTracks: null,
                    createdPlaylistId: null,
                    error: null,
                    createdAt: new Date("2026-03-14T18:30:00.000Z"),
                    updatedAt: new Date("2026-03-14T18:31:00.000Z"),
                    ...data,
                })),
                findUnique: jest.fn(async () => null),
                findFirst: jest.fn(async () => null),
                findMany: jest.fn(async () => []),
            },
        };

        jest.doMock("../../utils/db", () => ({ prisma }));

        return { prisma };
    }

    it("normalizes source URLs and persists a created generic import job", async () => {
        const { prisma } = setupImportJobStoreMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");

        const job = await importJobStore.createJob({
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "37i9dQZF1DX4JAvHpjipBk",
            sourceUrl:
                "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk?si=abc123",
            playlistName: "Weekend Mix",
            requestedPlaylistName: "Roadtrip Weekend",
            status: "pending",
            progress: 0,
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });

        expect(prisma.importJob.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: "user-1",
                sourceType: "spotify",
                sourceId: "37i9dQZF1DX4JAvHpjipBk",
                sourceUrl:
                    "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk?si=abc123",
                normalizedSource: "spotify:37i9dQZF1DX4JAvHpjipBk",
                playlistName: "Weekend Mix",
                requestedPlaylistName: "Roadtrip Weekend",
                status: "pending",
                progress: 0,
                summary: {
                    total: 0,
                    local: 0,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
                createdPlaylistId: null,
                error: null,
            }),
        });
        expect(job.normalizedSource).toBe("spotify:37i9dQZF1DX4JAvHpjipBk");
    });

    it("updates lifecycle state, progress, summary, and result linkage", async () => {
        const { prisma } = setupImportJobStoreMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");

        const job = await importJobStore.updateJob("import-job-1", {
            status: "completed",
            progress: 100,
            summary: {
                total: 12,
                local: 6,
                youtube: 3,
                tidal: 2,
                unresolved: 1,
            },
            createdPlaylistId: "playlist-123",
        });

        expect(prisma.importJob.update).toHaveBeenCalledWith({
            where: { id: "import-job-1" },
            data: {
                status: "completed",
                progress: 100,
                summary: {
                    total: 12,
                    local: 6,
                    youtube: 3,
                    tidal: 2,
                    unresolved: 1,
                },
                createdPlaylistId: "playlist-123",
            },
        });
        expect(job.status).toBe("completed");
        expect(job.createdPlaylistId).toBe("playlist-123");
    });

    it("finds an existing active job for a normalized source and excludes terminal states", async () => {
        const { prisma } = setupImportJobStoreMocks();
        (prisma.importJob.findFirst as jest.Mock)
            .mockResolvedValueOnce({
                id: "job-active",
                userId: "user-1",
                sourceType: "spotify",
                sourceId: "37i9dQZF1DX4JAvHpjipBk",
                sourceUrl:
                    "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk",
                normalizedSource: "spotify:37i9dQZF1DX4JAvHpjipBk",
                playlistName: "Weekend Mix",
                requestedPlaylistName: null,
                status: "resolving",
                progress: 35,
                summary: null,
                resolvedTracks: null,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-03-14T18:30:00.000Z"),
                updatedAt: new Date("2026-03-14T18:31:00.000Z"),
            })
            .mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");

        const active = await importJobStore.findActiveJobForSource(
            "user-1",
            "spotify:37i9dQZF1DX4JAvHpjipBk"
        );
        const terminal = await importJobStore.findActiveJobForSource(
            "user-1",
            "spotify:completed-playlist"
        );

        expect(prisma.importJob.findFirst).toHaveBeenNthCalledWith(1, {
            where: {
                userId: "user-1",
                normalizedSource: "spotify:37i9dQZF1DX4JAvHpjipBk",
                status: {
                    in: ["pending", "resolving", "creating_playlist", "cancelling"],
                },
            },
            orderBy: {
                updatedAt: "desc",
            },
        });
        expect(active?.id).toBe("job-active");
        expect(terminal).toBeNull();
    });

    it("lists a user's jobs in newest-first order", async () => {
        const { prisma } = setupImportJobStoreMocks();
        (prisma.importJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-2",
                userId: "user-1",
                sourceType: "deezer",
                sourceId: "123",
                sourceUrl: "https://deezer.com/playlist/123",
                normalizedSource: "deezer:123",
                playlistName: "Second",
                requestedPlaylistName: null,
                status: "failed",
                progress: 10,
                summary: null,
                resolvedTracks: null,
                createdPlaylistId: null,
                error: "boom",
                createdAt: new Date("2026-03-14T18:40:00.000Z"),
                updatedAt: new Date("2026-03-14T18:41:00.000Z"),
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");

        const jobs = await importJobStore.listJobsForUser("user-1");

        expect(prisma.importJob.findMany).toHaveBeenCalledWith({
            where: { userId: "user-1" },
            orderBy: { updatedAt: "desc" },
            take: 25,
        });
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.normalizedSource).toBe("deezer:123");
    });
});
