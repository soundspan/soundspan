import {
    lidarrService,
    createClientMock,
    primeServiceWithClient,
    LidarrHttpError,
    logger,
} from "../../__tests__/lidarrService.helpers";

describe("Lidarr reconciliation delegation", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });
    it("builds reconciliation snapshot and checks album/download state helpers", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockResolvedValueOnce({
                data: {
                    records: [
                        {
                            id: 4,
                            downloadId: "queue-1",
                            status: "downloading",
                            size: 100,
                            sizeleft: 20,
                            title: "Album",
                        },
                        {
                            id: 5,
                            downloadId: "queue-2",
                            status: "warning",
                            size: 100,
                            sizeleft: 70,
                            title: "Album 2",
                        },
                    ],
                },
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 31,
                        title: "My Album (Deluxe)",
                        foreignAlbumId: "album-mbid-31",
                        artist: { artistName: "My Artist" },
                        statistics: { percentOfTracks: 100 },
                    },
                    {
                        id: 32,
                        title: "No Files Album",
                        foreignAlbumId: "album-mbid-32",
                        artist: { artistName: "My Artist" },
                        statistics: { percentOfTracks: 0 },
                    },
                ],
            });

        const snapshot = await lidarrService.getReconciliationSnapshot();
        expect(snapshot.queue.size).toBe(2);
        expect(snapshot.albumsByMbid.size).toBe(1);

        expect(
            (lidarrService as any).isAlbumAvailableInSnapshot(
                snapshot,
                "album-mbid-31",
            ),
        ).toBe(true);
        expect(
            (lidarrService as any).isAlbumAvailableInSnapshot(
                snapshot,
                undefined,
                "My Artist",
                "My Album",
            ),
        ).toBe(true);

        expect(
            (lidarrService as any).isDownloadActiveInSnapshot(
                snapshot,
                "queue-1",
            ),
        ).toEqual({ active: true, progress: 80 });
        expect(
            (lidarrService as any).isDownloadActiveInSnapshot(
                snapshot,
                "queue-2",
            ),
        ).toEqual({ active: false, progress: 30 });
    });

    it("fails closed when album indexing fails during snapshot creation", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        const failure = new LidarrHttpError({
            status: 503,
            method: "GET",
            path: "/api/v1/album",
            attempts: 1,
            isTransient: true,
            data: { secret: "raw-response" },
        });

        client.get
            .mockResolvedValueOnce({
                data: {
                    records: [
                        {
                            id: 7,
                            downloadId: "queue-ok",
                            status: "downloading",
                            size: 200,
                            sizeleft: 40,
                            title: "Album",
                        },
                    ],
                },
            })
            .mockRejectedValueOnce(failure);

        await expect(lidarrService.getReconciliationSnapshot()).rejects.toThrow(
            "Lidarr GET /api/v1/album failed after 1 attempt(s)",
        );
        expect(logger.error).toHaveBeenCalledWith(
            "[LIDARR] Failed to create reconciliation snapshot:",
            {
                message: "Lidarr GET /api/v1/album failed after 1 attempt(s)",
                status: 503,
                path: "/api/v1/album",
            },
        );
    });
});
