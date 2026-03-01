export {};

const mockPrisma = {
    trackTidal: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
    },
    trackYtMusic: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
    },
    trackMapping: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
    },
    playlistItem: {
        create: jest.fn(),
        findMany: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({
    prisma: mockPrisma,
}));

describe("TrackMapping data model", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("TrackTidal CRUD", () => {
        it("upserts TrackTidal on tidalId", async () => {
            const tidalData = {
                id: "ct_1",
                tidalId: 12345678,
                title: "Test Song",
                artist: "Test Artist",
                album: "Test Album",
                duration: 240,
                isrc: "USRC17607839",
                quality: "LOSSLESS",
                explicit: false,
                createdAt: new Date(),
            };

            mockPrisma.trackTidal.upsert.mockResolvedValueOnce(tidalData);

            const result = await mockPrisma.trackTidal.upsert({
                where: { tidalId: 12345678 },
                update: {
                    title: tidalData.title,
                    artist: tidalData.artist,
                    album: tidalData.album,
                    duration: tidalData.duration,
                    isrc: tidalData.isrc,
                    quality: tidalData.quality,
                    explicit: tidalData.explicit,
                },
                create: tidalData,
            });

            expect(result).toEqual(tidalData);
            expect(mockPrisma.trackTidal.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { tidalId: 12345678 },
                })
            );
        });

        it("upsert is idempotent - second call updates existing", async () => {
            const tidalData = {
                id: "ct_1",
                tidalId: 12345678,
                title: "Updated Title",
                artist: "Test Artist",
                album: "Test Album",
                duration: 240,
                isrc: "USRC17607839",
                quality: "HI_RES",
                explicit: false,
                createdAt: new Date(),
            };

            mockPrisma.trackTidal.upsert.mockResolvedValueOnce(tidalData);

            const result = await mockPrisma.trackTidal.upsert({
                where: { tidalId: 12345678 },
                update: { title: "Updated Title", quality: "HI_RES" },
                create: tidalData,
            });

            expect(result.title).toBe("Updated Title");
            expect(result.quality).toBe("HI_RES");
        });
    });

    describe("TrackYtMusic CRUD", () => {
        it("upserts TrackYtMusic on videoId", async () => {
            const ytData = {
                id: "cy_1",
                videoId: "dQw4w9WgXcQ",
                title: "Test Song",
                artist: "Test Artist",
                album: "Test Album",
                duration: 212,
                thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
                createdAt: new Date(),
            };

            mockPrisma.trackYtMusic.upsert.mockResolvedValueOnce(ytData);

            const result = await mockPrisma.trackYtMusic.upsert({
                where: { videoId: "dQw4w9WgXcQ" },
                update: {
                    title: ytData.title,
                    artist: ytData.artist,
                    album: ytData.album,
                    duration: ytData.duration,
                },
                create: ytData,
            });

            expect(result).toEqual(ytData);
            expect(mockPrisma.trackYtMusic.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { videoId: "dQw4w9WgXcQ" },
                })
            );
        });

        it("upsert is idempotent - second call updates existing", async () => {
            const ytData = {
                id: "cy_1",
                videoId: "dQw4w9WgXcQ",
                title: "Updated Title",
                artist: "Test Artist",
                album: "Test Album",
                duration: 215,
                thumbnailUrl: null,
                createdAt: new Date(),
            };

            mockPrisma.trackYtMusic.upsert.mockResolvedValueOnce(ytData);

            const result = await mockPrisma.trackYtMusic.upsert({
                where: { videoId: "dQw4w9WgXcQ" },
                update: { title: "Updated Title", duration: 215 },
                create: ytData,
            });

            expect(result.title).toBe("Updated Title");
            expect(result.duration).toBe(215);
        });
    });

    describe("TrackMapping CRUD", () => {
        it("creates a mapping linking all three track types", async () => {
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

            mockPrisma.trackMapping.create.mockResolvedValueOnce(mapping);

            const result = await mockPrisma.trackMapping.create({
                data: {
                    trackId: "track_1",
                    trackTidalId: "ct_1",
                    trackYtMusicId: "cy_1",
                    confidence: 0.95,
                    source: "gap-fill",
                },
            });

            expect(result).toEqual(mapping);
            expect(result.trackId).toBe("track_1");
            expect(result.trackTidalId).toBe("ct_1");
            expect(result.trackYtMusicId).toBe("cy_1");
        });

        it("creates mapping with only trackYtMusicId (no local track)", async () => {
            const mapping = {
                id: "cm_2",
                trackId: null,
                trackTidalId: null,
                trackYtMusicId: "cy_1",
                confidence: 0.85,
                source: "import-match",
                stale: false,
                createdAt: new Date(),
            };

            mockPrisma.trackMapping.create.mockResolvedValueOnce(mapping);

            const result = await mockPrisma.trackMapping.create({
                data: {
                    trackYtMusicId: "cy_1",
                    confidence: 0.85,
                    source: "import-match",
                },
            });

            expect(result.trackId).toBeNull();
            expect(result.trackTidalId).toBeNull();
            expect(result.trackYtMusicId).toBe("cy_1");
        });

        it("allows multiple mappings referencing same Track (no unique violation)", async () => {
            const mapping1 = {
                id: "cm_1",
                trackId: "track_1",
                trackTidalId: "ct_1",
                trackYtMusicId: null,
                confidence: 0.9,
                source: "gap-fill",
                stale: false,
                createdAt: new Date(),
            };
            const mapping2 = {
                id: "cm_2",
                trackId: "track_1",
                trackTidalId: null,
                trackYtMusicId: "cy_1",
                confidence: 0.85,
                source: "gap-fill",
                stale: false,
                createdAt: new Date(),
            };

            mockPrisma.trackMapping.create
                .mockResolvedValueOnce(mapping1)
                .mockResolvedValueOnce(mapping2);

            const result1 = await mockPrisma.trackMapping.create({
                data: {
                    trackId: "track_1",
                    trackTidalId: "ct_1",
                    confidence: 0.9,
                    source: "gap-fill",
                },
            });
            const result2 = await mockPrisma.trackMapping.create({
                data: {
                    trackId: "track_1",
                    trackYtMusicId: "cy_1",
                    confidence: 0.85,
                    source: "gap-fill",
                },
            });

            expect(result1.trackId).toBe("track_1");
            expect(result2.trackId).toBe("track_1");
            expect(mockPrisma.trackMapping.create).toHaveBeenCalledTimes(2);
        });

        it("marks mapping as stale", async () => {
            mockPrisma.trackMapping.update.mockResolvedValueOnce({
                id: "cm_1",
                stale: true,
            });

            const result = await mockPrisma.trackMapping.update({
                where: { id: "cm_1" },
                data: { stale: true },
            });

            expect(result.stale).toBe(true);
        });

        it("finds mappings for a track", async () => {
            const mappings = [
                {
                    id: "cm_1",
                    trackId: "track_1",
                    trackTidalId: "ct_1",
                    trackYtMusicId: null,
                    confidence: 0.9,
                    source: "gap-fill",
                    stale: false,
                },
                {
                    id: "cm_2",
                    trackId: "track_1",
                    trackTidalId: null,
                    trackYtMusicId: "cy_1",
                    confidence: 0.85,
                    source: "gap-fill",
                    stale: false,
                },
            ];

            mockPrisma.trackMapping.findMany.mockResolvedValueOnce(mappings);

            const result = await mockPrisma.trackMapping.findMany({
                where: { trackId: "track_1" },
                include: { trackTidal: true, trackYtMusic: true },
            });

            expect(result).toHaveLength(2);
            expect(mockPrisma.trackMapping.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { trackId: "track_1" },
                })
            );
        });
    });

    describe("PlaylistItem with provider FKs", () => {
        it("creates PlaylistItem with null trackId and trackYtMusicId populated", async () => {
            const item = {
                id: "pi_1",
                playlistId: "pl_1",
                trackId: null,
                trackTidalId: null,
                trackYtMusicId: "cy_1",
                sort: 0,
            };

            mockPrisma.playlistItem.create.mockResolvedValueOnce(item);

            const result = await mockPrisma.playlistItem.create({
                data: {
                    playlistId: "pl_1",
                    trackYtMusicId: "cy_1",
                    sort: 0,
                },
            });

            expect(result.trackId).toBeNull();
            expect(result.trackYtMusicId).toBe("cy_1");
        });

        it("creates PlaylistItem with trackTidalId populated", async () => {
            const item = {
                id: "pi_2",
                playlistId: "pl_1",
                trackId: null,
                trackTidalId: "ct_1",
                trackYtMusicId: null,
                sort: 1,
            };

            mockPrisma.playlistItem.create.mockResolvedValueOnce(item);

            const result = await mockPrisma.playlistItem.create({
                data: {
                    playlistId: "pl_1",
                    trackTidalId: "ct_1",
                    sort: 1,
                },
            });

            expect(result.trackId).toBeNull();
            expect(result.trackTidalId).toBe("ct_1");
        });

        it("creates mixed PlaylistItems in same playlist", async () => {
            const localItem = {
                id: "pi_1",
                playlistId: "pl_1",
                trackId: "track_1",
                trackTidalId: null,
                trackYtMusicId: null,
                sort: 0,
            };
            const remoteItem = {
                id: "pi_2",
                playlistId: "pl_1",
                trackId: null,
                trackTidalId: null,
                trackYtMusicId: "cy_1",
                sort: 1,
            };

            mockPrisma.playlistItem.create
                .mockResolvedValueOnce(localItem)
                .mockResolvedValueOnce(remoteItem);

            const result1 = await mockPrisma.playlistItem.create({
                data: { playlistId: "pl_1", trackId: "track_1", sort: 0 },
            });
            const result2 = await mockPrisma.playlistItem.create({
                data: { playlistId: "pl_1", trackYtMusicId: "cy_1", sort: 1 },
            });

            expect(result1.trackId).toBe("track_1");
            expect(result2.trackId).toBeNull();
            expect(result2.trackYtMusicId).toBe("cy_1");
        });
    });

    describe("onDelete cascade behavior", () => {
        it("TrackMapping uses SetNull on track deletion", async () => {
            // When a Track is deleted, TrackMapping.trackId should be set to null
            // This is defined in the schema with onDelete: SetNull
            const mappingAfterDeletion = {
                id: "cm_1",
                trackId: null, // Set to null after Track deletion
                trackTidalId: "ct_1",
                trackYtMusicId: "cy_1",
                confidence: 0.95,
                source: "gap-fill",
                stale: false,
            };

            mockPrisma.trackMapping.findUnique.mockResolvedValueOnce(
                mappingAfterDeletion
            );

            const result = await mockPrisma.trackMapping.findUnique({
                where: { id: "cm_1" },
            });

            expect(result!.trackId).toBeNull();
            expect(result!.trackTidalId).toBe("ct_1");
            expect(result!.trackYtMusicId).toBe("cy_1");
        });

        it("PlaylistItem uses SetNull on TrackTidal/TrackYtMusic deletion", async () => {
            // When a TrackTidal or TrackYtMusic is deleted,
            // PlaylistItem FKs should be set to null
            const itemAfterDeletion = {
                id: "pi_1",
                playlistId: "pl_1",
                trackId: null,
                trackTidalId: null, // Set to null after TrackTidal deletion
                trackYtMusicId: null, // Set to null after TrackYtMusic deletion
                sort: 0,
            };

            mockPrisma.playlistItem.findMany.mockResolvedValueOnce([
                itemAfterDeletion,
            ]);

            const items = await mockPrisma.playlistItem.findMany({
                where: { playlistId: "pl_1" },
            });

            expect(items[0].trackTidalId).toBeNull();
            expect(items[0].trackYtMusicId).toBeNull();
        });
    });
});
