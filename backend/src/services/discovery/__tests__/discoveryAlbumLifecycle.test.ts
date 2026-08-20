import {
    DiscoveryAlbumLifecycle,
    DiscoveryAlbumInfo,
    LidarrSettings,
} from "../discoveryAlbumLifecycle";
import { prisma } from "../../../utils/db";
import axios from "axios";
import { updateArtistCounts } from "../../artistCountsService";

jest.mock("../../../utils/db", () => ({
    prisma: {
        album: {
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
            deleteMany: jest.fn(),
        },
        ownedAlbum: {
            upsert: jest.fn(),
            updateMany: jest.fn(),
        },
        discoveryAlbum: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
        },
        track: {
            deleteMany: jest.fn(),
        },
        discoveryTrack: {
            deleteMany: jest.fn(),
        },
        unavailableAlbum: {
            deleteMany: jest.fn(),
        },
        $queryRaw: jest.fn(),
        $transaction: jest.fn(),
    },
}));

jest.mock("../../../config", () => ({
    config: {
        lidarr: undefined,
        workers: { providerTrackRetentionDays: 30 },
    },
}));
jest.mock("../../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));
jest.mock("axios", () => {
    const request = jest.fn();
    const create = jest.fn(() => ({ request }));
    return {
        __esModule: true,
        default: { create, request },
        create,
    };
});
jest.mock("../../artistCountsService", () => ({
    updateArtistCounts: jest.fn(),
}));

const mockAxios = axios as jest.Mocked<typeof axios> & { request: jest.Mock };
const mockRequest = mockAxios.request;
const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockUpdateArtistCounts = updateArtistCounts as jest.Mock;

describe("DiscoveryAlbumLifecycle", () => {
    let lifecycle: DiscoveryAlbumLifecycle;
    let lockedDiscoveryId: string;

    beforeEach(() => {
        jest.clearAllMocks();
        lockedDiscoveryId = "discovery-album-1";
        (mockPrisma.$queryRaw as jest.Mock).mockImplementation(
            async (query: {
                strings: readonly string[];
                values: unknown[];
            }) => {
                const sql = query.strings.join("");
                if (!sql.includes("DiscoveryAlbum"))
                    return [{ id: query.values[0] }];
                lockedDiscoveryId = String(query.values[0]);
                return [
                    {
                        id: lockedDiscoveryId,
                        catalogAlbumId: null,
                        status: sql.includes('OR "catalogAlbumId"')
                            ? "ACTIVE"
                            : "LIKED",
                    },
                ];
            },
        );
        (mockPrisma.discoveryAlbum.findUnique as jest.Mock).mockResolvedValue({
            catalogAlbumId: null,
        });
        (mockPrisma.album.findUnique as jest.Mock).mockImplementation(
            async () => {
                const fallbackResult = (
                    mockPrisma.album.findFirst as jest.Mock
                ).mock.results.at(-1);
                return fallbackResult ? await fallbackResult.value : null;
            },
        );
        (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({
            count: 1,
        });
        (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockImplementation(
            async (args: { where?: { catalogAlbumId?: string } }) =>
                args.where?.catalogAlbumId
                    ? [{ id: lockedDiscoveryId, status: "ACTIVE" }]
                    : [],
        );
        (mockPrisma.ownedAlbum.updateMany as jest.Mock).mockResolvedValue({
            count: 0,
        });
        (mockPrisma.$transaction as jest.Mock).mockImplementation(
            async (callback: (transaction: typeof prisma) => unknown) =>
                callback(prisma),
        );
        lifecycle = new DiscoveryAlbumLifecycle();
    });

    describe("moveLikedAlbumToLibrary", () => {
        const mockAlbum: DiscoveryAlbumInfo = {
            id: "discovery-album-1",
            rgMbid: "rg-mbid-123",
            artistName: "Test Artist",
            albumTitle: "Test Album",
            lidarrAlbumId: 456,
        };

        it("should update album location to LIBRARY", async () => {
            const dbAlbum = {
                id: "album-db-1",
                artistId: "artist-1",
                rgMbid: "rg-mbid-123",
            };

            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(
                dbAlbum,
            );
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue(
                {},
            );
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            await lifecycle.moveLikedAlbumToLibrary(mockAlbum);

            expect(mockPrisma.album.update).toHaveBeenCalledWith({
                where: { id: "album-db-1" },
                data: { location: "LIBRARY" },
            });
        });

        it("should create OwnedAlbum record", async () => {
            const dbAlbum = {
                id: "album-db-1",
                artistId: "artist-1",
                rgMbid: "rg-mbid-123",
            };

            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(
                dbAlbum,
            );
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue(
                {},
            );
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            await lifecycle.moveLikedAlbumToLibrary(mockAlbum);

            expect(mockPrisma.ownedAlbum.upsert).toHaveBeenCalledWith({
                where: {
                    artistId_rgMbid: {
                        artistId: "artist-1",
                        rgMbid: "rg-mbid-123",
                    },
                },
                create: {
                    artistId: "artist-1",
                    rgMbid: "rg-mbid-123",
                    source: "discovery_liked",
                },
                update: {},
            });
        });

        it("should update artist counts after move", async () => {
            const dbAlbum = {
                id: "album-db-1",
                artistId: "artist-1",
                rgMbid: "rg-mbid-123",
            };

            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(
                dbAlbum,
            );
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue(
                {},
            );
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            await lifecycle.moveLikedAlbumToLibrary(mockAlbum);

            expect(mockUpdateArtistCounts).toHaveBeenCalledWith("artist-1");
        });

        it("should mark discovery album as MOVED", async () => {
            const dbAlbum = {
                id: "album-db-1",
                artistId: "artist-1",
                rgMbid: "rg-mbid-123",
            };

            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(
                dbAlbum,
            );
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue(
                {},
            );
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            await lifecycle.moveLikedAlbumToLibrary(mockAlbum);

            expect(mockPrisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
                where: { id: "discovery-album-1", status: "LIKED" },
                data: { status: "MOVED" },
            });
        });

        it("should still mark as MOVED even if album not found in DB", async () => {
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue(
                {},
            );

            await lifecycle.moveLikedAlbumToLibrary(mockAlbum);

            expect(mockPrisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
                where: { id: "discovery-album-1", status: "LIKED" },
                data: { status: "MOVED" },
            });
            expect(mockPrisma.album.update).not.toHaveBeenCalled();
        });

        it("should throw error when operation fails", async () => {
            (mockPrisma.album.findFirst as jest.Mock).mockRejectedValue(
                new Error("DB Error"),
            );

            await expect(
                lifecycle.moveLikedAlbumToLibrary(mockAlbum),
            ).rejects.toThrow("DB Error");
        });
    });

    describe("deleteRejectedAlbum", () => {
        const mockAlbum: DiscoveryAlbumInfo = {
            id: "discovery-album-1",
            rgMbid: "rg-mbid-123",
            artistName: "Test Artist",
            albumTitle: "Test Album",
            lidarrAlbumId: 456,
        };

        const mockSettings: LidarrSettings = {
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr:8686",
            lidarrApiKey: "test-api-key",
        };

        it("should delete from Lidarr when enabled", async () => {
            mockRequest.mockResolvedValue({ data: {}, status: 200 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({
                id: "album-db-1",
                rgMbid: "rg-mbid-123",
            });
            (mockPrisma.album.deleteMany as jest.Mock).mockResolvedValue({
                count: 1,
            });
            (
                mockPrisma.discoveryTrack.deleteMany as jest.Mock
            ).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue(
                {},
            );

            await lifecycle.deleteRejectedAlbum(mockAlbum, mockSettings);

            expect(mockRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: "DELETE",
                    url: "/api/v1/album/456",
                    params: { deleteFiles: true },
                }),
            );
            expect(mockAxios.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    baseURL: "http://lidarr:8686",
                    headers: { "X-Api-Key": "test-api-key" },
                }),
            );
            expect(
                (mockPrisma.album.deleteMany as jest.Mock).mock
                    .invocationCallOrder[0],
            ).toBeLessThan(mockRequest.mock.invocationCallOrder[0]);
        });

        it("should skip Lidarr deletion when disabled", async () => {
            const disabledSettings: LidarrSettings = { lidarrEnabled: false };
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (
                mockPrisma.discoveryTrack.deleteMany as jest.Mock
            ).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue(
                {},
            );

            await lifecycle.deleteRejectedAlbum(mockAlbum, disabledSettings);

            expect(mockRequest).not.toHaveBeenCalled();
        });

        it("should skip Lidarr deletion when album has no lidarrAlbumId", async () => {
            const albumWithoutLidarr: DiscoveryAlbumInfo = {
                ...mockAlbum,
                lidarrAlbumId: null,
            };
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (
                mockPrisma.discoveryTrack.deleteMany as jest.Mock
            ).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue(
                {},
            );

            await lifecycle.deleteRejectedAlbum(
                albumWithoutLidarr,
                mockSettings,
            );

            expect(mockRequest).not.toHaveBeenCalled();
        });

        it("should ignore Lidarr 404 errors", async () => {
            const error = { response: { status: 404 }, message: "Not Found" };
            mockRequest.mockRejectedValue(error);
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({
                id: "album-db-1",
                rgMbid: "rg-mbid-123",
            });
            (mockPrisma.album.deleteMany as jest.Mock).mockResolvedValue({
                count: 1,
            });
            (
                mockPrisma.discoveryTrack.deleteMany as jest.Mock
            ).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue(
                {},
            );

            await expect(
                lifecycle.deleteRejectedAlbum(mockAlbum, mockSettings),
            ).resolves.not.toThrow();
        });

        it("should delete the guarded album transactionally and cascade its tracks", async () => {
            const dbAlbum = {
                id: "album-db-1",
                rgMbid: "rg-mbid-123",
            };
            mockRequest.mockResolvedValue({ data: {}, status: 200 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(
                dbAlbum,
            );
            (mockPrisma.album.deleteMany as jest.Mock).mockResolvedValue({
                count: 1,
            });
            (
                mockPrisma.discoveryTrack.deleteMany as jest.Mock
            ).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue(
                {},
            );

            await lifecycle.deleteRejectedAlbum(mockAlbum, mockSettings);

            expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
            expect(mockPrisma.track.deleteMany).not.toHaveBeenCalled();
            expect(mockPrisma.album.deleteMany).toHaveBeenCalledWith({
                where: expect.objectContaining({
                    id: "album-db-1",
                    hasUserOverrides: false,
                    discoveryRecords: { none: { status: "LIKED" } },
                    ownedBy: { none: {} },
                }),
            });
        });

        it("preserves files, links, and state when the guarded delete loses a like race", async () => {
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({
                id: "album-db-1",
                rgMbid: "rg-mbid-123",
            });
            (mockPrisma.album.deleteMany as jest.Mock).mockResolvedValue({
                count: 0,
            });
            await lifecycle.deleteRejectedAlbum(mockAlbum, mockSettings);

            expect(mockRequest).not.toHaveBeenCalled();
            expect(mockPrisma.discoveryTrack.deleteMany).not.toHaveBeenCalled();
            expect(
                mockPrisma.discoveryAlbum.updateMany,
            ).not.toHaveBeenCalledWith({
                where: {
                    id: { in: ["discovery-album-1"] },
                    status: "DELETED",
                },
                data: { status: "ACTIVE" },
            });
        });

        it("runs no effects when a LIKED row wins the cleanup claim", async () => {
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({
                id: "album-db-1",
                rgMbid: "rg-mbid-123",
            });
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock)
                .mockResolvedValueOnce({ count: 1 })
                .mockResolvedValueOnce({ count: 0 });

            await expect(
                lifecycle.deleteRejectedAlbum(mockAlbum, mockSettings),
            ).resolves.toBe(false);

            expect(mockPrisma.album.deleteMany).not.toHaveBeenCalled();
            expect(mockRequest).not.toHaveBeenCalled();
            expect(mockPrisma.discoveryTrack.deleteMany).not.toHaveBeenCalled();
        });

        it("finishes discovery links and status when a retry finds the catalog album absent", async () => {
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
                {
                    id: "discovery-album-1",
                    catalogAlbumId: null,
                    status: "ACTIVE",
                },
            ]);
            (
                mockPrisma.discoveryTrack.deleteMany as jest.Mock
            ).mockResolvedValue({ count: 1 });
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue(
                {},
            );

            await expect(
                lifecycle.deleteRejectedAlbum(mockAlbum, {
                    lidarrEnabled: false,
                }),
            ).resolves.toBe(true);

            expect(mockPrisma.discoveryTrack.deleteMany).toHaveBeenCalledWith({
                where: { discoveryAlbumId: "discovery-album-1" },
            });
            expect(mockPrisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
                where: {
                    id: { in: ["discovery-album-1"] },
                    status: { in: ["ACTIVE", "DELETED"] },
                },
                data: { status: "DELETED" },
            });
        });

        it("should delete discovery track records", async () => {
            mockRequest.mockResolvedValue({ data: {}, status: 200 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({
                id: "album-db-1",
                rgMbid: "rg-mbid-123",
            });
            (mockPrisma.album.deleteMany as jest.Mock).mockResolvedValue({
                count: 1,
            });
            (
                mockPrisma.discoveryTrack.deleteMany as jest.Mock
            ).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue(
                {},
            );

            await lifecycle.deleteRejectedAlbum(mockAlbum, mockSettings);

            expect(mockPrisma.discoveryTrack.deleteMany).toHaveBeenCalledWith({
                where: { discoveryAlbumId: "discovery-album-1" },
            });
        });

        it("should mark discovery album as DELETED", async () => {
            mockRequest.mockResolvedValue({ data: {}, status: 200 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({
                id: "album-db-1",
                rgMbid: "rg-mbid-123",
            });
            (mockPrisma.album.deleteMany as jest.Mock).mockResolvedValue({
                count: 1,
            });
            (
                mockPrisma.discoveryTrack.deleteMany as jest.Mock
            ).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue(
                {},
            );

            await lifecycle.deleteRejectedAlbum(mockAlbum, mockSettings);

            expect(mockPrisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
                where: {
                    id: { in: ["discovery-album-1"] },
                    status: { in: ["ACTIVE", "DELETED"] },
                },
                data: { status: "DELETED" },
            });
        });

        it("should throw error when database operation fails", async () => {
            mockRequest.mockResolvedValue({ data: {}, status: 200 });
            (mockPrisma.album.findFirst as jest.Mock).mockRejectedValue(
                new Error("DB Error"),
            );

            await expect(
                lifecycle.deleteRejectedAlbum(mockAlbum, mockSettings),
            ).rejects.toThrow("DB Error");
        });
    });

    describe("processBeforeGeneration", () => {
        const userId = "user-123";
        const mockSettings: LidarrSettings = {
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr:8686",
            lidarrApiKey: "test-api-key",
        };

        it("should return early when no discovery albums exist", async () => {
            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue(
                [],
            );

            const result = await lifecycle.processBeforeGeneration(
                userId,
                mockSettings,
            );

            expect(result).toEqual({ moved: 0, deleted: 0 });
            expect(mockPrisma.album.findFirst).not.toHaveBeenCalled();
        });

        it("should process liked albums and mark them as moved", async () => {
            const discoveryAlbums = [
                {
                    id: "da-1",
                    rgMbid: "rg-1",
                    artistName: "Artist 1",
                    albumTitle: "Album 1",
                    status: "LIKED",
                    lidarrAlbumId: 100,
                },
            ];
            const dbAlbum = {
                id: "album-1",
                artistId: "artist-1",
                rgMbid: "rg-1",
            };

            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue(
                discoveryAlbums,
            );
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(
                dbAlbum,
            );
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue(
                {},
            );
            (
                mockPrisma.unavailableAlbum.deleteMany as jest.Mock
            ).mockResolvedValue({});
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            const result = await lifecycle.processBeforeGeneration(
                userId,
                mockSettings,
            );

            expect(result.moved).toBe(1);
            expect(mockPrisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
                where: { id: "da-1", status: "LIKED" },
                data: { status: "MOVED" },
            });
        });

        it("should process active albums and delete them", async () => {
            const discoveryAlbums = [
                {
                    id: "da-1",
                    rgMbid: "rg-1",
                    artistName: "Artist 1",
                    albumTitle: "Album 1",
                    status: "ACTIVE",
                    lidarrAlbumId: 100,
                },
            ];

            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue(
                discoveryAlbums,
            );
            mockRequest.mockResolvedValue({ data: {}, status: 200 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({
                id: "album-1",
                rgMbid: "rg-1",
            });
            (mockPrisma.album.deleteMany as jest.Mock).mockResolvedValue({
                count: 1,
            });
            (
                mockPrisma.discoveryTrack.deleteMany as jest.Mock
            ).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue(
                {},
            );
            (
                mockPrisma.unavailableAlbum.deleteMany as jest.Mock
            ).mockResolvedValue({});

            const result = await lifecycle.processBeforeGeneration(
                userId,
                mockSettings,
            );

            expect(result.deleted).toBe(1);
            expect(mockPrisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
                where: {
                    id: { in: ["da-1"] },
                    status: { in: ["ACTIVE", "DELETED"] },
                },
                data: { status: "DELETED" },
            });
        });

        it("should clean up unavailable albums for user", async () => {
            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue(
                [],
            );
            (
                mockPrisma.unavailableAlbum.deleteMany as jest.Mock
            ).mockResolvedValue({});

            await lifecycle.processBeforeGeneration(userId, mockSettings);

            expect(mockPrisma.unavailableAlbum.deleteMany).toHaveBeenCalledWith(
                {
                    where: { userId },
                },
            );
        });

        it("should continue processing even when individual album fails", async () => {
            const discoveryAlbums = [
                {
                    id: "da-1",
                    rgMbid: "rg-1",
                    artistName: "Artist 1",
                    albumTitle: "Album 1",
                    status: "LIKED",
                    lidarrAlbumId: 100,
                },
                {
                    id: "da-2",
                    rgMbid: "rg-2",
                    artistName: "Artist 2",
                    albumTitle: "Album 2",
                    status: "LIKED",
                    lidarrAlbumId: 101,
                },
            ];
            const dbAlbum = {
                id: "album-2",
                artistId: "artist-2",
                rgMbid: "rg-2",
            };

            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue(
                discoveryAlbums,
            );
            (mockPrisma.album.findFirst as jest.Mock)
                .mockRejectedValueOnce(new Error("DB Error"))
                .mockResolvedValueOnce(dbAlbum);
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue(
                {},
            );
            (
                mockPrisma.unavailableAlbum.deleteMany as jest.Mock
            ).mockResolvedValue({});
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            const result = await lifecycle.processBeforeGeneration(
                userId,
                mockSettings,
            );

            expect(result.moved).toBe(1);
        });
    });
});
