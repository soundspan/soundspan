const mockPrisma = {
    trackMapping: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
    },
    userSettings: {
        findMany: jest.fn(),
    },
    trackTidal: {
        findMany: jest.fn(),
    },
    trackYtMusic: {
        findMany: jest.fn(),
    },
    track: {
        findMany: jest.fn(),
    },
    $transaction: jest.fn(),
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
jest.mock("../tidalStreaming", () => ({
    tidalStreamingService: {
        restoreOAuth: jest.fn(),
        findMatchesForAlbum: jest.fn(),
    },
}));

import { trackReconciliationService } from "../trackReconciliation";
import { trackMappingService } from "../trackMappingService";
import { tidalStreamingService } from "../tidalStreaming";

describe("TrackReconciliationService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Default: empty local library
        mockPrisma.track.findMany.mockResolvedValue([]);
        // Default: no orphans
        mockPrisma.trackTidal.findMany.mockResolvedValue([]);
        mockPrisma.trackYtMusic.findMany.mockResolvedValue([]);
        // Default: transaction passes through
        mockPrisma.$transaction.mockImplementation(
            async (callback: (tx: typeof mockPrisma) => unknown) =>
                callback(mockPrisma)
        );
        mockPrisma.trackMapping.findFirst.mockResolvedValue(null);
        mockPrisma.trackMapping.findMany.mockResolvedValue([]);
        mockPrisma.userSettings.findMany.mockResolvedValue([]);
        mockPrisma.trackMapping.create.mockImplementation(async (args: any) => ({
            id: `orphan-mapping-${Math.random().toString(36).slice(2, 8)}`,
            ...args.data,
            stale: false,
            createdAt: new Date(),
        }));
        (tidalStreamingService.restoreOAuth as jest.Mock).mockResolvedValue(false);
        (tidalStreamingService.findMatchesForAlbum as jest.Mock).mockResolvedValue([]);
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

        it("marks orphan mapping stale when linked mapping already exists for same tuple", async () => {
            mockPrisma.trackMapping.findMany.mockResolvedValueOnce([
                {
                    id: "m-orphan",
                    trackId: null,
                    trackTidalId: "ct_1",
                    trackYtMusicId: null,
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
            mockPrisma.track.findMany.mockResolvedValueOnce([
                {
                    id: "t1",
                    title: "Song",
                    duration: 200,
                    filePath: "/music/song.flac",
                    album: { title: "Album", artist: { name: "Artist" } },
                },
            ]);
            // A linked mapping already exists for (t1, ct_1)
            mockPrisma.trackMapping.findFirst.mockResolvedValueOnce({
                id: "m-linked",
                trackId: "t1",
                trackTidalId: "ct_1",
                trackYtMusicId: null,
                stale: false,
            });

            const result = await trackReconciliationService.reconcile();

            expect(result.linked).toBe(0);
            expect(result.skipped).toBe(1);
            // Should mark the orphan as stale, not try to update trackId
            expect(mockPrisma.trackMapping.update).toHaveBeenCalledWith({
                where: { id: "m-orphan" },
                data: { stale: true },
            });
        });

        it("is idempotent \u2014 re-running produces same results", async () => {
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

    describe("reconcileOrphans", () => {
        it("creates mappings for orphaned TrackTidal rows", async () => {
            mockPrisma.trackTidal.findMany.mockResolvedValueOnce([
                { id: "tt-orphan-1" },
                { id: "tt-orphan-2" },
            ]);
            mockPrisma.trackYtMusic.findMany.mockResolvedValueOnce([]);

            const result = await trackReconciliationService.reconcileOrphans();

            expect(result.created).toBe(2);
            expect(mockPrisma.trackTidal.findMany).toHaveBeenCalledWith({
                where: { mappings: { none: { stale: false } } },
                select: { id: true },
                take: 50,
            });
        });

        it("creates mappings for orphaned TrackYtMusic rows", async () => {
            mockPrisma.trackTidal.findMany.mockResolvedValueOnce([]);
            mockPrisma.trackYtMusic.findMany.mockResolvedValueOnce([
                { id: "yt-orphan-1" },
            ]);

            const result = await trackReconciliationService.reconcileOrphans();

            expect(result.created).toBe(1);
            expect(mockPrisma.trackYtMusic.findMany).toHaveBeenCalledWith({
                where: { mappings: { none: { stale: false } } },
                select: { id: true },
                take: 50,
            });
        });

        it("creates mappings for both providers in a single pass", async () => {
            mockPrisma.trackTidal.findMany.mockResolvedValueOnce([
                { id: "tt-orphan-1" },
            ]);
            mockPrisma.trackYtMusic.findMany.mockResolvedValueOnce([
                { id: "yt-orphan-1" },
                { id: "yt-orphan-2" },
            ]);

            const result = await trackReconciliationService.reconcileOrphans();

            expect(result.created).toBe(3);
        });

        it("continues processing when individual createMapping fails", async () => {
            mockPrisma.trackTidal.findMany.mockResolvedValueOnce([
                { id: "tt-fail" },
                { id: "tt-ok" },
            ]);
            mockPrisma.trackYtMusic.findMany.mockResolvedValueOnce([
                { id: "yt-fail" },
            ]);
            // First tidal fails, second succeeds; yt fails
            mockPrisma.trackMapping.findMany
                .mockRejectedValueOnce(new Error("DB error"))  // tt-fail: createMapping transaction
                .mockResolvedValueOnce([])                     // tt-ok: createMapping transaction
                .mockRejectedValueOnce(new Error("DB error")); // yt-fail: createMapping transaction

            const result = await trackReconciliationService.reconcileOrphans();

            // Only tt-ok succeeded
            expect(result.created).toBe(1);
        });

        it("returns zero when no orphans exist", async () => {
            mockPrisma.trackTidal.findMany.mockResolvedValueOnce([]);
            mockPrisma.trackYtMusic.findMany.mockResolvedValueOnce([]);

            const result = await trackReconciliationService.reconcileOrphans();

            expect(result.created).toBe(0);
        });
    });

    describe("reconcileYoutubeToTidal", () => {
        it("returns early when no YT-only mappings exist", async () => {
            mockPrisma.trackMapping.findMany.mockResolvedValueOnce([]);

            const result = await trackReconciliationService.reconcileYoutubeToTidal();

            expect(result).toEqual({ processed: 0, upgraded: 0, skipped: 0 });
            expect(tidalStreamingService.restoreOAuth).not.toHaveBeenCalled();
            expect(tidalStreamingService.findMatchesForAlbum).not.toHaveBeenCalled();
        });

        it("skips when no TIDAL-authenticated user is available", async () => {
            mockPrisma.trackMapping.findMany.mockResolvedValueOnce([
                {
                    id: "yt-only-1",
                    trackId: "local-track-1",
                    trackTidalId: null,
                    trackYtMusicId: "yt-row-1",
                    confidence: 0.8,
                    source: "gap-fill",
                    trackYtMusic: {
                        title: "Song",
                        artist: "Artist",
                        album: "Album",
                        duration: 200,
                    },
                },
            ]);
            mockPrisma.userSettings.findMany.mockResolvedValueOnce([]);

            const result = await trackReconciliationService.reconcileYoutubeToTidal();

            expect(result).toEqual({ processed: 1, upgraded: 0, skipped: 1 });
            expect(tidalStreamingService.restoreOAuth).not.toHaveBeenCalled();
            expect(tidalStreamingService.findMatchesForAlbum).not.toHaveBeenCalled();
        });

        it("upgrades YT-only mapping when TIDAL match is found", async () => {
            mockPrisma.trackMapping.findMany.mockResolvedValueOnce([
                {
                    id: "yt-only-2",
                    trackId: "local-track-2",
                    trackTidalId: null,
                    trackYtMusicId: "yt-row-2",
                    confidence: 0.82,
                    source: "import-match",
                    trackYtMusic: {
                        title: "Cast of Frozen",
                        artist: "Some Artist",
                        album: "Frozen",
                        duration: 193,
                    },
                },
            ]);
            mockPrisma.userSettings.findMany.mockResolvedValueOnce([
                {
                    userId: "tidal-user-1",
                    tidalOAuthJson:
                        '{"access_token":"access","refresh_token":"refresh","user_id":"1","country_code":"US"}',
                },
            ]);
            (tidalStreamingService.restoreOAuth as jest.Mock).mockResolvedValueOnce(
                true
            );
            (tidalStreamingService.findMatchesForAlbum as jest.Mock).mockResolvedValueOnce(
                [
                    {
                        id: 123456,
                        title: "Cast of Frozen",
                        artist: "Some Artist",
                        duration: 193,
                        isrc: "USAA10000001",
                    },
                ]
            );
            mockPrisma.trackMapping.findFirst.mockResolvedValueOnce(null);
            mockPrisma.trackMapping.update.mockResolvedValueOnce({
                id: "yt-only-2",
            });
            const upsertSpy = jest
                .spyOn(trackMappingService, "upsertTrackTidal")
                .mockResolvedValueOnce({ id: "tidal-row-2" } as any);

            const result = await trackReconciliationService.reconcileYoutubeToTidal();

            expect(tidalStreamingService.restoreOAuth).toHaveBeenCalledWith(
                "tidal-user-1",
                expect.any(String)
            );
            expect(tidalStreamingService.findMatchesForAlbum).toHaveBeenCalledWith(
                "tidal-user-1",
                [
                    {
                        artist: "Some Artist",
                        title: "Cast of Frozen",
                        albumTitle: "Frozen",
                        duration: 193,
                        isrc: undefined,
                    },
                ]
            );
            expect(upsertSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    tidalId: 123456,
                    title: "Cast of Frozen",
                    artist: "Some Artist",
                    album: "Frozen",
                    duration: 193,
                    isrc: "USAA10000001",
                })
            );
            expect(mockPrisma.trackMapping.update).toHaveBeenCalledWith({
                where: { id: "yt-only-2" },
                data: expect.objectContaining({
                    trackTidalId: "tidal-row-2",
                }),
            });
            expect(result).toEqual({ processed: 1, upgraded: 1, skipped: 0 });

            upsertSpy.mockRestore();
        });

        it("falls back to next TIDAL user when first restore fails", async () => {
            mockPrisma.trackMapping.findMany.mockResolvedValueOnce([
                {
                    id: "yt-only-fallback-1",
                    trackId: "local-track-fallback-1",
                    trackTidalId: null,
                    trackYtMusicId: "yt-row-fallback-1",
                    confidence: 0.8,
                    source: "gap-fill",
                    trackYtMusic: {
                        title: "Fallback Song",
                        artist: "Fallback Artist",
                        album: "Fallback Album",
                        duration: 210,
                    },
                },
            ]);
            mockPrisma.userSettings.findMany.mockResolvedValueOnce([
                {
                    userId: "tidal-user-bad",
                    tidalOAuthJson:
                        '{"access_token":"bad","refresh_token":"bad","user_id":"9","country_code":"US"}',
                },
                {
                    userId: "tidal-user-good",
                    tidalOAuthJson:
                        '{"access_token":"good","refresh_token":"good","user_id":"10","country_code":"US"}',
                },
            ]);
            (tidalStreamingService.restoreOAuth as jest.Mock)
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true);
            (tidalStreamingService.findMatchesForAlbum as jest.Mock).mockResolvedValueOnce(
                [
                    {
                        id: 654321,
                        title: "Fallback Song",
                        artist: "Fallback Artist",
                        duration: 210,
                        isrc: "USAA10000002",
                    },
                ]
            );
            mockPrisma.trackMapping.findFirst.mockResolvedValueOnce(null);
            mockPrisma.trackMapping.update.mockResolvedValueOnce({
                id: "yt-only-fallback-1",
            });
            const upsertSpy = jest
                .spyOn(trackMappingService, "upsertTrackTidal")
                .mockResolvedValueOnce({ id: "tidal-row-fallback-1" } as any);

            const result = await trackReconciliationService.reconcileYoutubeToTidal();

            expect(tidalStreamingService.restoreOAuth).toHaveBeenNthCalledWith(
                1,
                "tidal-user-bad",
                expect.any(String)
            );
            expect(tidalStreamingService.restoreOAuth).toHaveBeenNthCalledWith(
                2,
                "tidal-user-good",
                expect.any(String)
            );
            expect(tidalStreamingService.findMatchesForAlbum).toHaveBeenCalledWith(
                "tidal-user-good",
                [
                    {
                        artist: "Fallback Artist",
                        title: "Fallback Song",
                        albumTitle: "Fallback Album",
                        duration: 210,
                        isrc: undefined,
                    },
                ]
            );
            expect(result).toEqual({ processed: 1, upgraded: 1, skipped: 0 });

            upsertSpy.mockRestore();
        });

        it("skips upgrade when a conflicting mapping already exists", async () => {
            mockPrisma.trackMapping.findMany.mockResolvedValueOnce([
                {
                    id: "yt-only-conflict-1",
                    trackId: "local-track-conflict-1",
                    trackTidalId: null,
                    trackYtMusicId: "yt-row-conflict-1",
                    confidence: 0.8,
                    source: "gap-fill",
                    trackYtMusic: {
                        title: "Conflict Song",
                        artist: "Conflict Artist",
                        album: "Conflict Album",
                        duration: 205,
                    },
                },
            ]);
            mockPrisma.userSettings.findMany.mockResolvedValueOnce([
                {
                    userId: "tidal-user-1",
                    tidalOAuthJson:
                        '{"access_token":"access","refresh_token":"refresh","user_id":"1","country_code":"US"}',
                },
            ]);
            (tidalStreamingService.restoreOAuth as jest.Mock).mockResolvedValueOnce(
                true
            );
            (tidalStreamingService.findMatchesForAlbum as jest.Mock).mockResolvedValueOnce(
                [
                    {
                        id: 222333,
                        title: "Conflict Song",
                        artist: "Conflict Artist",
                        duration: 205,
                        isrc: "USAA10000003",
                    },
                ]
            );
            const upsertSpy = jest
                .spyOn(trackMappingService, "upsertTrackTidal")
                .mockResolvedValueOnce({ id: "tidal-row-conflict-1" } as any);
            mockPrisma.trackMapping.findFirst.mockResolvedValueOnce({
                id: "existing-conflict",
            });

            const result = await trackReconciliationService.reconcileYoutubeToTidal();

            expect(mockPrisma.trackMapping.update).not.toHaveBeenCalled();
            expect(result).toEqual({ processed: 1, upgraded: 0, skipped: 1 });

            upsertSpy.mockRestore();
        });

        it("scans beyond the first user-settings page when restoring TIDAL auth", async () => {
            mockPrisma.trackMapping.findMany.mockResolvedValueOnce([
                {
                    id: "yt-only-paged-1",
                    trackId: "local-track-paged-1",
                    trackTidalId: null,
                    trackYtMusicId: "yt-row-paged-1",
                    confidence: 0.8,
                    source: "gap-fill",
                    trackYtMusic: {
                        title: "Paged Song",
                        artist: "Paged Artist",
                        album: "Paged Album",
                        duration: 205,
                    },
                },
            ]);
            mockPrisma.userSettings.findMany
                .mockResolvedValueOnce([
                    {
                        userId: "tidal-user-1",
                        tidalOAuthJson:
                            '{"access_token":"bad","refresh_token":"bad","user_id":"1","country_code":"US"}',
                    },
                ])
                .mockResolvedValueOnce([
                    {
                        userId: "tidal-user-2",
                        tidalOAuthJson:
                            '{"access_token":"good","refresh_token":"good","user_id":"2","country_code":"US"}',
                    },
                ]);
            (tidalStreamingService.restoreOAuth as jest.Mock)
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true);
            (tidalStreamingService.findMatchesForAlbum as jest.Mock).mockResolvedValueOnce(
                [
                    {
                        id: 333444,
                        title: "Paged Song",
                        artist: "Paged Artist",
                        duration: 205,
                        isrc: "USAA10000004",
                    },
                ]
            );
            mockPrisma.trackMapping.findFirst.mockResolvedValueOnce(null);
            mockPrisma.trackMapping.update.mockResolvedValueOnce({
                id: "yt-only-paged-1",
            });
            const upsertSpy = jest
                .spyOn(trackMappingService, "upsertTrackTidal")
                .mockResolvedValueOnce({ id: "tidal-row-paged-1" } as any);

            const result = await trackReconciliationService.reconcileYoutubeToTidal();

            expect(mockPrisma.userSettings.findMany).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    take: 100,
                    orderBy: { userId: "asc" },
                })
            );
            expect(mockPrisma.userSettings.findMany).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    take: 100,
                    cursor: { userId: "tidal-user-1" },
                    skip: 1,
                })
            );
            expect(result).toEqual({ processed: 1, upgraded: 1, skipped: 0 });

            upsertSpy.mockRestore();
        });
    });
});
