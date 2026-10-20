import {
    lidarrService,
    createClientMock,
    primeServiceWithClient,
    LidarrHttpError,
    logger,
} from "../../__tests__/lidarrService.helpers";
import type { ReconciliationScope } from "../../download/reconciliationScope";
import { getReconciliationSnapshot } from "../lidarrReconciliation";
import type { LidarrHttpClient } from "../lidarrHttpClient";

const EMPTY_SCOPE: ReconciliationScope = {
    needsQueue: false,
    albumTargets: [],
};

function directClient(get: jest.Mock): LidarrHttpClient {
    return { get } as unknown as LidarrHttpClient;
}

function album(
    foreignAlbumId: string,
    percentOfTracks: number,
    artistName = "My Artist",
    title = "My Album",
) {
    return {
        id: 31,
        title,
        foreignAlbumId,
        artist: { artistName },
        statistics: { percentOfTracks },
    };
}

function albumRequestCalls(get: jest.Mock): unknown[][] {
    return get.mock.calls.filter(([path]) => path === "/api/v1/album");
}

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

        const snapshot = await lidarrService.getReconciliationSnapshot({
            needsQueue: true,
            albumTargets: [{ mbids: ["album-mbid-31"] }],
        });
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

        await expect(
            lidarrService.getReconciliationSnapshot({
                needsQueue: true,
                albumTargets: [{ mbids: ["album-mbid-31"] }],
            }),
        ).rejects.toThrow("Lidarr GET /api/v1/album failed after 1 attempt(s)");
        expect(logger.error).toHaveBeenCalledWith(
            "[LIDARR] Failed to create reconciliation snapshot:",
            {
                message: "Lidarr GET /api/v1/album failed after 1 attempt(s)",
                status: 503,
                path: "/api/v1/album",
            },
        );
    });

    it("makes no Lidarr requests for an empty scope", async () => {
        const get = jest.fn();

        const snapshot = await getReconciliationSnapshot(
            directClient(get),
            true,
            EMPTY_SCOPE,
        );

        expect(get).not.toHaveBeenCalled();
        expect(snapshot.queue.size).toBe(0);
        expect(snapshot.albumsByMbid.size).toBe(0);
    });

    it("fetches only the queue for a queue-only scope", async () => {
        const get = jest.fn(async () => ({ data: { records: [] } }));

        await getReconciliationSnapshot(directClient(get), true, {
            needsQueue: true,
            albumTargets: [],
        });

        expect(get).toHaveBeenCalledTimes(1);
        expect(get).toHaveBeenCalledWith("/api/v1/queue", {
            params: {
                page: 1,
                pageSize: 1000,
                includeUnknownArtistItems: true,
            },
            signal: expect.any(AbortSignal),
        });
        expect(logger.debug).toHaveBeenCalledWith(
            "[LIDARR] Snapshot fetched: 0 queue items, 0 albums with files, 1 Lidarr requests",
        );
    });

    it("indexes found MBID albums with files and ignores empty albums", async () => {
        const get = jest
            .fn()
            .mockResolvedValueOnce({
                data: [album("found-mbid", 100), album("empty-mbid", 0)],
            })
            .mockResolvedValueOnce({ data: [] });

        const snapshot = await getReconciliationSnapshot(
            directClient(get),
            true,
            {
                needsQueue: false,
                albumTargets: [
                    { mbids: ["found-mbid"] },
                    { mbids: ["unknown-mbid"] },
                ],
            },
        );

        expect(snapshot.albumsByMbid.has("found-mbid")).toBe(true);
        expect(snapshot.albumsByMbid.has("empty-mbid")).toBe(false);
        expect(snapshot.albumsByMbid.has("unknown-mbid")).toBe(false);
    });

    it("caps MBID album lookups at 200 in target order", async () => {
        const get = jest.fn(async () => ({ data: [] }));
        const mbids = Array.from(
            { length: 201 },
            (_, index) => `mbid-${index}`,
        );

        await getReconciliationSnapshot(directClient(get), true, {
            needsQueue: false,
            albumTargets: mbids.map((mbid) => ({ mbids: [mbid] })),
        });

        const calls = albumRequestCalls(get);
        expect(calls).toHaveLength(200);
        expect(calls[0]?.[1]).toEqual(
            expect.objectContaining({ params: { foreignAlbumId: "mbid-0" } }),
        );
        expect(calls[199]?.[1]).toEqual(
            expect.objectContaining({
                params: { foreignAlbumId: "mbid-199" },
            }),
        );
        expect(get).not.toHaveBeenCalledWith(
            "/api/v1/album",
            expect.objectContaining({
                params: { foreignAlbumId: "mbid-200" },
            }),
        );
        expect(logger.debug).toHaveBeenCalledWith(
            "[LIDARR] Reconciliation MBID lookup cap dropped 1 target(s)",
        );
    });

    it("matches title-fallback artists by normalized name", async () => {
        const get = jest
            .fn()
            .mockResolvedValueOnce({
                data: [
                    null,
                    {
                        id: "invalid",
                        artistName: "Beyonce",
                        statistics: { albumCount: 1 },
                    },
                    {
                        id: 7,
                        artistName: "Beyoncé",
                        statistics: { albumCount: 1 },
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [album("fallback-mbid", 100, "Beyoncé", "Lemonade")],
            });

        const snapshot = await getReconciliationSnapshot(
            directClient(get),
            true,
            {
                needsQueue: false,
                albumTargets: [{ mbids: [], artistName: "BEYONCE" }],
            },
        );

        expect(get).toHaveBeenNthCalledWith(1, "/api/v1/artist", {
            signal: expect.any(AbortSignal),
        });
        expect(get).toHaveBeenNthCalledWith(
            2,
            "/api/v1/album",
            expect.objectContaining({ params: { artistId: 7 } }),
        );
        expect(snapshot.albumsByTitle.has("beyonce|lemonade")).toBe(true);
    });

    it("caps fallback artists at ten and skips catalogs over 1000 albums", async () => {
        const artists = Array.from({ length: 12 }, (_, index) => ({
            id: index + 1,
            artistName: `Artist ${index + 1}`,
            statistics: { albumCount: index === 0 ? 1001 : 1 },
        }));
        const get = jest.fn(async (path: string) => ({
            data: path === "/api/v1/artist" ? artists : [],
        }));

        await getReconciliationSnapshot(directClient(get), true, {
            needsQueue: false,
            albumTargets: artists.map(({ artistName }) => ({
                mbids: [],
                artistName,
            })),
        });

        const artistAlbumCalls = albumRequestCalls(get);
        expect(artistAlbumCalls).toHaveLength(9);
        expect(artistAlbumCalls.map((call) => call[1])).toEqual(
            Array.from({ length: 9 }, (_, index) =>
                expect.objectContaining({ params: { artistId: index + 2 } }),
            ),
        );
        expect(get).not.toHaveBeenCalledWith(
            "/api/v1/album",
            expect.objectContaining({ params: { artistId: 11 } }),
        );
        expect(logger.debug).toHaveBeenCalledWith(
            "[LIDARR] Reconciliation skipped 1 oversized artist catalog(s)",
        );
    });

    it("skips the artist list when every target resolves by MBID", async () => {
        const get = jest.fn(async () => ({
            data: [album("resolved-mbid", 100)],
        }));

        await getReconciliationSnapshot(directClient(get), true, {
            needsQueue: false,
            albumTargets: [
                { mbids: ["resolved-mbid"], artistName: "My Artist" },
            ],
        });

        expect(get).toHaveBeenCalledTimes(1);
        expect(get).not.toHaveBeenCalledWith(
            "/api/v1/artist",
            expect.anything(),
        );
    });

    it("rejects malformed MBID lookup bodies", async () => {
        const get = jest.fn(async () => ({ data: { records: [] } }));

        await expect(
            getReconciliationSnapshot(directClient(get), true, {
                needsQueue: false,
                albumTargets: [{ mbids: ["malformed"] }],
            }),
        ).rejects.toThrow("Lidarr album lookup was not an array");
    });

    it("rejects failed lookups and logs the snapshot failure", async () => {
        const failure = new Error("lookup failed");
        const get = jest.fn(async () => Promise.reject(failure));

        await expect(
            getReconciliationSnapshot(directClient(get), true, {
                needsQueue: false,
                albumTargets: [{ mbids: ["failed-mbid"] }],
            }),
        ).rejects.toThrow("lookup failed");
        expect(logger.error).toHaveBeenCalledWith(
            "[LIDARR] Failed to create reconciliation snapshot:",
            expect.objectContaining({ message: "lookup failed" }),
        );
    });

    it("never requests the unparameterized full album library", async () => {
        const get = jest.fn(async (path: string) => {
            if (path === "/api/v1/artist") {
                return {
                    data: [
                        {
                            id: 9,
                            artistName: "Fallback Artist",
                            statistics: { albumCount: 1 },
                        },
                    ],
                };
            }
            return { data: [] };
        });

        await getReconciliationSnapshot(directClient(get), true, {
            needsQueue: false,
            albumTargets: [
                { mbids: ["missing"], artistName: "Fallback Artist" },
            ],
        });

        for (const [, config] of albumRequestCalls(get)) {
            expect(config).toEqual(
                expect.objectContaining({ params: expect.any(Object) }),
            );
        }
    });
});
