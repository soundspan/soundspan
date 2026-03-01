const mockPrisma = {
    trackTidal: {
        upsert: jest.fn(),
    },
    trackYtMusic: {
        upsert: jest.fn(),
    },
    trackMapping: {
        create: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
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

jest.mock("../../utils/db", () => ({
    prisma: mockPrisma,
}));

jest.mock("../../utils/logger", () => ({
    logger: mockLogger,
}));

import { trackMappingService } from "../trackMappingService";

describe("TrackMappingService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPrisma.$transaction.mockImplementation(
            async (callback: (tx: typeof mockPrisma) => unknown) =>
                callback(mockPrisma)
        );
    });

    describe("upsertTrackTidal", () => {
        it("upserts by tidalId and returns result", async () => {
            const tidalData = {
                tidalId: 12345678,
                title: "Test Song",
                artist: "Test Artist",
                album: "Test Album",
                duration: 240,
                isrc: "USRC17607839",
                quality: "LOSSLESS",
                explicit: false,
            };
            const expected = { id: "ct_1", ...tidalData, createdAt: new Date() };
            mockPrisma.trackTidal.upsert.mockResolvedValueOnce(expected);

            const result = await trackMappingService.upsertTrackTidal(tidalData);

            expect(result).toEqual(expected);
            expect(mockPrisma.trackTidal.upsert).toHaveBeenCalledWith({
                where: { tidalId: 12345678 },
                update: expect.objectContaining({ title: "Test Song" }),
                create: expect.objectContaining({ tidalId: 12345678 }),
            });
        });

        it("is idempotent - second upsert updates metadata", async () => {
            const data = {
                tidalId: 12345678,
                title: "Updated Title",
                artist: "Test Artist",
                album: "Test Album",
                duration: 240,
            };
            mockPrisma.trackTidal.upsert.mockResolvedValueOnce({
                id: "ct_1",
                ...data,
            });

            const result = await trackMappingService.upsertTrackTidal(data);

            expect(result.title).toBe("Updated Title");
        });

        it("throws and logs on DB error", async () => {
            mockPrisma.trackTidal.upsert.mockRejectedValueOnce(
                new Error("DB error")
            );

            await expect(
                trackMappingService.upsertTrackTidal({
                    tidalId: 1,
                    title: "T",
                    artist: "A",
                    album: "Al",
                    duration: 100,
                })
            ).rejects.toThrow("DB error");
            expect(mockLogger.error).toHaveBeenCalled();
        });
    });

    describe("upsertTrackYtMusic", () => {
        it("upserts by videoId and returns result", async () => {
            const ytData = {
                videoId: "dQw4w9WgXcQ",
                title: "Test Song",
                artist: "Test Artist",
                album: "Test Album",
                duration: 212,
                thumbnailUrl: "https://example.com/thumb.jpg",
            };
            const expected = { id: "cy_1", ...ytData, createdAt: new Date() };
            mockPrisma.trackYtMusic.upsert.mockResolvedValueOnce(expected);

            const result = await trackMappingService.upsertTrackYtMusic(ytData);

            expect(result).toEqual(expected);
            expect(mockPrisma.trackYtMusic.upsert).toHaveBeenCalledWith({
                where: { videoId: "dQw4w9WgXcQ" },
                update: expect.objectContaining({ title: "Test Song" }),
                create: expect.objectContaining({ videoId: "dQw4w9WgXcQ" }),
            });
        });

        it("throws and logs on DB error", async () => {
            mockPrisma.trackYtMusic.upsert.mockRejectedValueOnce(
                new Error("DB error")
            );

            await expect(
                trackMappingService.upsertTrackYtMusic({
                    videoId: "x",
                    title: "T",
                    artist: "A",
                    album: "Al",
                    duration: 100,
                })
            ).rejects.toThrow("DB error");
        });
    });

    describe("createMapping", () => {
        it("creates mapping with all FKs", async () => {
            const mapping = {
                id: "cm_1",
                trackId: "track_1",
                trackTidalId: "ct_1",
                trackYtMusicId: "cy_1",
                confidence: 0.95,
                source: "gap-fill",
                stale: false,
                createdAt: new Date(),
            };
            mockPrisma.trackMapping.findMany.mockResolvedValueOnce([]);
            mockPrisma.trackMapping.create.mockResolvedValueOnce(mapping);

            const result = await trackMappingService.createMapping({
                trackId: "track_1",
                trackTidalId: "ct_1",
                trackYtMusicId: "cy_1",
                confidence: 0.95,
                source: "gap-fill",
            });

            expect(result).toEqual(mapping);
            expect(mockPrisma.trackMapping.findMany).toHaveBeenCalledWith({
                where: {
                    trackId: "track_1",
                    trackTidalId: "ct_1",
                    trackYtMusicId: "cy_1",
                    stale: false,
                },
            });
            expect(mockPrisma.trackMapping.create).toHaveBeenCalledWith({
                data: {
                    trackId: "track_1",
                    trackTidalId: "ct_1",
                    trackYtMusicId: "cy_1",
                    confidence: 0.95,
                    source: "gap-fill",
                },
            });
        });

        it("creates mapping with only ytMusic (no local)", async () => {
            const mapping = {
                id: "cm_2",
                trackId: undefined,
                trackTidalId: undefined,
                trackYtMusicId: "cy_1",
                confidence: 0.85,
                source: "import-match",
                stale: false,
                createdAt: new Date(),
            };
            mockPrisma.trackMapping.findMany.mockResolvedValueOnce([]);
            mockPrisma.trackMapping.create.mockResolvedValueOnce(mapping);

            const result = await trackMappingService.createMapping({
                trackYtMusicId: "cy_1",
                confidence: 0.85,
                source: "import-match",
            });

            expect(result.trackYtMusicId).toBe("cy_1");
        });

        it("deduplicates active rows for the same linkage tuple", async () => {
            const preferred = {
                id: "cm_pref",
                trackId: "track_1",
                trackTidalId: "ct_1",
                trackYtMusicId: null,
                confidence: 0.95,
                source: "manual",
                stale: false,
                createdAt: new Date("2026-03-01T10:00:00.000Z"),
            };
            const duplicate = {
                id: "cm_dup",
                trackId: "track_1",
                trackTidalId: "ct_1",
                trackYtMusicId: null,
                confidence: 0.6,
                source: "gap-fill",
                stale: false,
                createdAt: new Date("2026-02-28T10:00:00.000Z"),
            };

            mockPrisma.trackMapping.findMany.mockResolvedValueOnce([
                duplicate,
                preferred,
            ]);
            mockPrisma.trackMapping.updateMany.mockResolvedValueOnce({
                count: 1,
            });

            const result = await trackMappingService.createMapping({
                trackId: "track_1",
                trackTidalId: "ct_1",
                confidence: 0.5,
                source: "gap-fill",
            });

            expect(result.id).toBe("cm_pref");
            expect(mockPrisma.trackMapping.update).not.toHaveBeenCalled();
            expect(mockPrisma.trackMapping.updateMany).toHaveBeenCalledWith({
                where: { id: { in: ["cm_dup"] } },
                data: { stale: true },
            });
        });

        it("updates existing tuple when incoming mapping has higher priority", async () => {
            const existing = {
                id: "cm_1",
                trackId: "track_1",
                trackTidalId: "ct_1",
                trackYtMusicId: null,
                confidence: 0.6,
                source: "gap-fill",
                stale: false,
                createdAt: new Date("2026-02-28T10:00:00.000Z"),
            };
            const updated = {
                ...existing,
                confidence: 0.9,
                source: "manual",
            };

            mockPrisma.trackMapping.findMany.mockResolvedValueOnce([existing]);
            mockPrisma.trackMapping.update.mockResolvedValueOnce(updated);

            const result = await trackMappingService.createMapping({
                trackId: "track_1",
                trackTidalId: "ct_1",
                confidence: 0.9,
                source: "manual",
            });

            expect(result).toEqual(updated);
            expect(mockPrisma.trackMapping.update).toHaveBeenCalledWith({
                where: { id: "cm_1" },
                data: {
                    trackId: "track_1",
                    trackTidalId: "ct_1",
                    trackYtMusicId: null,
                    confidence: 0.9,
                    source: "manual",
                    stale: false,
                },
            });
            expect(mockPrisma.trackMapping.updateMany).not.toHaveBeenCalled();
        });

        it("rejects orphan linkage payloads", async () => {
            await expect(
                trackMappingService.createMapping({
                    confidence: 0.9,
                    source: "manual",
                })
            ).rejects.toThrow(
                "TrackMapping requires at least one linkage key"
            );

            expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        });
    });

    describe("findMappingsForTrack", () => {
        it("returns mappings with includes", async () => {
            const mappings = [
                {
                    id: "cm_1",
                    trackId: "track_1",
                    trackTidal: { id: "ct_1", tidalId: 123 },
                    trackYtMusic: null,
                },
            ];
            mockPrisma.trackMapping.findMany.mockResolvedValueOnce(mappings);

            const result =
                await trackMappingService.findMappingsForTrack("track_1");

            expect(result).toHaveLength(1);
            expect(mockPrisma.trackMapping.findMany).toHaveBeenCalledWith({
                where: { trackId: "track_1", stale: false },
                include: { trackTidal: true, trackYtMusic: true },
            });
        });

        it("returns deterministic preferred mappings when provider candidates conflict", async () => {
            mockPrisma.trackMapping.findMany.mockResolvedValueOnce([
                {
                    id: "m_gap",
                    trackId: "track_1",
                    trackTidalId: "ct_gap",
                    trackYtMusicId: null,
                    confidence: 0.99,
                    source: "gap-fill",
                    stale: false,
                    createdAt: new Date("2026-02-28T10:00:00.000Z"),
                    trackTidal: { id: "ct_gap", tidalId: 111 },
                    trackYtMusic: null,
                },
                {
                    id: "m_manual",
                    trackId: "track_1",
                    trackTidalId: "ct_manual",
                    trackYtMusicId: null,
                    confidence: 0.65,
                    source: "manual",
                    stale: false,
                    createdAt: new Date("2026-02-27T10:00:00.000Z"),
                    trackTidal: { id: "ct_manual", tidalId: 222 },
                    trackYtMusic: null,
                },
                {
                    id: "m_yt_low",
                    trackId: "track_1",
                    trackTidalId: null,
                    trackYtMusicId: "cy_low",
                    confidence: 0.6,
                    source: "import-match",
                    stale: false,
                    createdAt: new Date("2026-02-28T12:00:00.000Z"),
                    trackTidal: null,
                    trackYtMusic: { id: "cy_low", videoId: "low" },
                },
                {
                    id: "m_yt_high",
                    trackId: "track_1",
                    trackTidalId: null,
                    trackYtMusicId: "cy_high",
                    confidence: 0.8,
                    source: "import-match",
                    stale: false,
                    createdAt: new Date("2026-02-28T09:00:00.000Z"),
                    trackTidal: null,
                    trackYtMusic: { id: "cy_high", videoId: "high" },
                },
            ]);

            const result =
                await trackMappingService.findMappingsForTrack("track_1");

            expect(result.map((m) => m.id)).toEqual(["m_manual", "m_yt_high"]);
        });

        it("returns empty array on DB error", async () => {
            mockPrisma.trackMapping.findMany.mockRejectedValueOnce(
                new Error("DB error")
            );

            const result =
                await trackMappingService.findMappingsForTrack("track_1");

            expect(result).toEqual([]);
        });
    });

    describe("getMappingsForAlbum", () => {
        it("fetches album tracks then bulk-queries mappings", async () => {
            mockPrisma.track.findMany.mockResolvedValueOnce([
                { id: "t1" },
                { id: "t2" },
                { id: "t3" },
            ]);
            const mappings = [
                {
                    id: "cm_1",
                    trackId: "t1",
                    trackTidal: null,
                    trackYtMusic: { id: "cy_1", videoId: "abc" },
                },
                {
                    id: "cm_2",
                    trackId: "t2",
                    trackTidal: { id: "ct_1", tidalId: 123 },
                    trackYtMusic: null,
                },
            ];
            mockPrisma.trackMapping.findMany.mockResolvedValueOnce(mappings);

            const result =
                await trackMappingService.getMappingsForAlbum("album_1");

            expect(result).toHaveLength(2);
            expect(mockPrisma.track.findMany).toHaveBeenCalledWith({
                where: { albumId: "album_1" },
                select: { id: true },
            });
            expect(mockPrisma.trackMapping.findMany).toHaveBeenCalledWith({
                where: {
                    trackId: { in: ["t1", "t2", "t3"] },
                    stale: false,
                },
                include: { trackTidal: true, trackYtMusic: true },
            });
        });

        it("selects deterministic preferred mapping per provider when album has duplicates", async () => {
            mockPrisma.track.findMany.mockResolvedValueOnce([{ id: "t1" }]);
            mockPrisma.trackMapping.findMany.mockResolvedValueOnce([
                {
                    id: "cm_manual",
                    trackId: "t1",
                    trackTidalId: "ct_1",
                    trackYtMusicId: null,
                    confidence: 0.7,
                    source: "manual",
                    stale: false,
                    createdAt: new Date("2026-02-28T09:00:00.000Z"),
                    trackTidal: { id: "ct_1", tidalId: 1 },
                    trackYtMusic: null,
                },
                {
                    id: "cm_gap",
                    trackId: "t1",
                    trackTidalId: "ct_2",
                    trackYtMusicId: null,
                    confidence: 0.95,
                    source: "gap-fill",
                    stale: false,
                    createdAt: new Date("2026-02-28T10:00:00.000Z"),
                    trackTidal: { id: "ct_2", tidalId: 2 },
                    trackYtMusic: null,
                },
                {
                    id: "cm_yt",
                    trackId: "t1",
                    trackTidalId: null,
                    trackYtMusicId: "cy_1",
                    confidence: 0.8,
                    source: "import-match",
                    stale: false,
                    createdAt: new Date("2026-02-28T11:00:00.000Z"),
                    trackTidal: null,
                    trackYtMusic: { id: "cy_1", videoId: "yt1" },
                },
            ]);

            const result =
                await trackMappingService.getMappingsForAlbum("album_1");

            expect(result.map((m) => m.id)).toEqual(["cm_manual", "cm_yt"]);
        });

        it("returns empty array when album has no tracks", async () => {
            mockPrisma.track.findMany.mockResolvedValueOnce([]);

            const result =
                await trackMappingService.getMappingsForAlbum("empty_album");

            expect(result).toEqual([]);
            expect(mockPrisma.trackMapping.findMany).not.toHaveBeenCalled();
        });

        it("returns empty array on DB error", async () => {
            mockPrisma.track.findMany.mockRejectedValueOnce(
                new Error("DB error")
            );

            const result =
                await trackMappingService.getMappingsForAlbum("album_1");

            expect(result).toEqual([]);
        });
    });

    describe("markStale", () => {
        it("sets stale=true on mapping", async () => {
            mockPrisma.trackMapping.update.mockResolvedValueOnce({
                id: "cm_1",
                stale: true,
            });

            const result = await trackMappingService.markStale("cm_1");

            expect(result.stale).toBe(true);
            expect(mockPrisma.trackMapping.update).toHaveBeenCalledWith({
                where: { id: "cm_1" },
                data: { stale: true },
            });
        });

        it("throws on DB error", async () => {
            mockPrisma.trackMapping.update.mockRejectedValueOnce(
                new Error("not found")
            );

            await expect(
                trackMappingService.markStale("nonexistent")
            ).rejects.toThrow("not found");
        });
    });
});
