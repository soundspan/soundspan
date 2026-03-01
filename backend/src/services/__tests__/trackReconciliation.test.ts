const mockPrisma = {
    trackMapping: {
        findMany: jest.fn(),
        update: jest.fn(),
    },
    track: {
        findMany: jest.fn(),
    },
};

const mockLogger: Record<string, jest.Mock> = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);

jest.mock("../../utils/db", () => ({ prisma: mockPrisma }));
jest.mock("../../utils/logger", () => ({ logger: mockLogger }));

import { trackReconciliationService } from "../trackReconciliation";

describe("TrackReconciliationService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Default: empty local library
        mockPrisma.track.findMany.mockResolvedValue([]);
    });

    describe("reconcile", () => {
        it("returns early when no unlinked mappings exist", async () => {
            mockPrisma.trackMapping.findMany.mockResolvedValue([]);

            const result = await trackReconciliationService.reconcile();

            expect(result).toEqual({ processed: 0, linked: 0, skipped: 0 });
            expect(mockPrisma.trackMapping.update).not.toHaveBeenCalled();
        });

        it("returns early when no local library tracks exist", async () => {
            mockPrisma.trackMapping.findMany.mockResolvedValue([
                {
                    id: "m1",
                    trackId: null,
                    trackTidal: { title: "Song", artist: "Artist", album: "Album", duration: 200, isrc: null },
                    trackYtMusic: null,
                },
            ]);
            mockPrisma.track.findMany.mockResolvedValue([]);

            const result = await trackReconciliationService.reconcile();

            expect(result).toEqual({ processed: 1, linked: 0, skipped: 1 });
            expect(mockPrisma.trackMapping.update).not.toHaveBeenCalled();
        });

        it("links mapping via Tidal metadata match", async () => {
            mockPrisma.trackMapping.findMany.mockResolvedValue([
                {
                    id: "m1",
                    trackId: null,
                    trackTidal: {
                        title: "Song",
                        artist: "Artist",
                        album: "Album",
                        duration: 200,
                        isrc: null,
                    },
                    trackYtMusic: null,
                },
            ]);
            mockPrisma.track.findMany.mockResolvedValue([
                {
                    id: "t1",
                    title: "Song",
                    duration: 200,
                    filePath: "/music/song.flac",
                    album: { title: "Album", artist: { name: "Artist" } },
                },
            ]);

            const result = await trackReconciliationService.reconcile();

            expect(result.linked).toBe(1);
            expect(mockPrisma.trackMapping.update).toHaveBeenCalledWith({
                where: { id: "m1" },
                data: expect.objectContaining({
                    trackId: "t1",
                }),
            });
        });

        it("links mapping via metadata match when no ISRC", async () => {
            mockPrisma.trackMapping.findMany.mockResolvedValue([
                {
                    id: "m2",
                    trackId: null,
                    trackTidal: null,
                    trackYtMusic: {
                        title: "My Song",
                        artist: "Some Artist",
                        album: "The Album",
                        duration: 180,
                    },
                },
            ]);
            mockPrisma.track.findMany.mockResolvedValue([
                {
                    id: "t2",
                    title: "My Song",
                    duration: 180,
                    filePath: "/music/my-song.flac",
                    album: { title: "The Album", artist: { name: "Some Artist" } },
                },
            ]);

            const result = await trackReconciliationService.reconcile();

            expect(result.linked).toBe(1);
            expect(mockPrisma.trackMapping.update).toHaveBeenCalledWith({
                where: { id: "m2" },
                data: expect.objectContaining({
                    trackId: "t2",
                }),
            });
        });

        it("skips mappings with no matching local track", async () => {
            mockPrisma.trackMapping.findMany.mockResolvedValue([
                {
                    id: "m3",
                    trackId: null,
                    trackTidal: null,
                    trackYtMusic: {
                        title: "Obscure Track",
                        artist: "Unknown Artist",
                        album: "Rare Album",
                        duration: 300,
                    },
                },
            ]);
            mockPrisma.track.findMany.mockResolvedValue([
                {
                    id: "t3",
                    title: "Completely Different Song",
                    duration: 120,
                    filePath: "/music/diff.flac",
                    album: { title: "Other Album", artist: { name: "Other Artist" } },
                },
            ]);

            const result = await trackReconciliationService.reconcile();

            expect(result.linked).toBe(0);
            expect(result.skipped).toBe(1);
            expect(mockPrisma.trackMapping.update).not.toHaveBeenCalled();
        });

        it("skips mappings with no provider data", async () => {
            mockPrisma.trackMapping.findMany.mockResolvedValue([
                {
                    id: "m4",
                    trackId: null,
                    trackTidal: null,
                    trackYtMusic: null,
                },
            ]);
            mockPrisma.track.findMany.mockResolvedValue([
                {
                    id: "t4",
                    title: "Song",
                    duration: 200,
                    filePath: "/music/song.flac",
                    album: { title: "Album", artist: { name: "Artist" } },
                },
            ]);

            const result = await trackReconciliationService.reconcile();

            expect(result.skipped).toBe(1);
            expect(result.linked).toBe(0);
        });

        it("respects batch size parameter", async () => {
            mockPrisma.trackMapping.findMany.mockResolvedValue([]);

            await trackReconciliationService.reconcile(10);

            expect(mockPrisma.trackMapping.findMany).toHaveBeenCalledWith(
                expect.objectContaining({ take: 10 })
            );
        });

        it("prefers Tidal metadata over YT Music when both exist", async () => {
            mockPrisma.trackMapping.findMany.mockResolvedValue([
                {
                    id: "m5",
                    trackId: null,
                    trackTidal: {
                        title: "Tidal Title",
                        artist: "Tidal Artist",
                        album: "Album",
                        duration: 200,
                        isrc: null,
                    },
                    trackYtMusic: {
                        title: "YT Title",
                        artist: "YT Artist",
                        album: "Album",
                        duration: 200,
                    },
                },
            ]);
            mockPrisma.track.findMany.mockResolvedValue([
                {
                    id: "t5",
                    title: "Tidal Title",
                    duration: 200,
                    filePath: "/music/t.flac",
                    album: { title: "Album", artist: { name: "Tidal Artist" } },
                },
            ]);

            const result = await trackReconciliationService.reconcile();

            expect(result.linked).toBe(1);
            // Should match using Tidal metadata (preferred)
            expect(mockPrisma.trackMapping.update).toHaveBeenCalledWith({
                where: { id: "m5" },
                data: expect.objectContaining({
                    trackId: "t5",
                }),
            });
        });

        it("processes multiple mappings in one batch", async () => {
            mockPrisma.trackMapping.findMany.mockResolvedValue([
                {
                    id: "m6a",
                    trackId: null,
                    trackTidal: {
                        title: "Song A",
                        artist: "Artist A",
                        album: "Album A",
                        duration: 200,
                        isrc: null,
                    },
                    trackYtMusic: null,
                },
                {
                    id: "m6b",
                    trackId: null,
                    trackTidal: null,
                    trackYtMusic: {
                        title: "Song B",
                        artist: "Artist B",
                        album: "Album B",
                        duration: 180,
                    },
                },
            ]);
            mockPrisma.track.findMany.mockResolvedValue([
                {
                    id: "t6a",
                    title: "Song A",
                    duration: 200,
                    filePath: "/music/a.flac",
                    album: { title: "Album A", artist: { name: "Artist A" } },
                },
                {
                    id: "t6b",
                    title: "Song B",
                    duration: 180,
                    filePath: "/music/b.flac",
                    album: { title: "Album B", artist: { name: "Artist B" } },
                },
            ]);

            const result = await trackReconciliationService.reconcile();

            expect(result.processed).toBe(2);
            expect(result.linked).toBe(2);
            expect(mockPrisma.trackMapping.update).toHaveBeenCalledTimes(2);
        });

        it("is idempotent — re-running produces same results", async () => {
            // First run: finds unlinked mapping
            mockPrisma.trackMapping.findMany.mockResolvedValueOnce([
                {
                    id: "m7",
                    trackId: null,
                    trackTidal: null,
                    trackYtMusic: {
                        title: "Stable",
                        artist: "Stable Artist",
                        album: "Stable Album",
                        duration: 200,
                    },
                },
            ]);
            mockPrisma.track.findMany.mockResolvedValueOnce([
                {
                    id: "t7",
                    title: "Stable",
                    duration: 200,
                    filePath: "/music/stable.flac",
                    album: { title: "Stable Album", artist: { name: "Stable Artist" } },
                },
            ]);

            await trackReconciliationService.reconcile();

            // Second run: no unlinked mappings (the one from before is now linked)
            mockPrisma.trackMapping.findMany.mockResolvedValueOnce([]);

            const result2 = await trackReconciliationService.reconcile();

            expect(result2).toEqual({ processed: 0, linked: 0, skipped: 0 });
        });
    });
});
