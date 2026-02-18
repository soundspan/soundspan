describe("cleanupDiscovery worker", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadCleanupDiscovery() {
        const logger = {
            debug: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        const prisma = {
            discoveryAlbum: {
                findMany: jest.fn(),
                delete: jest.fn(),
            },
            playlistItem: {
                findFirst: jest.fn(),
            },
            likedTrack: {
                findFirst: jest.fn(),
            },
            discoveryTrack: {
                delete: jest.fn(),
            },
        };
        const fsPromises = {
            rm: jest.fn(),
            unlink: jest.fn(),
        };

        jest.doMock("../../utils/logger", () => ({ logger }));
        jest.doMock("../../utils/db", () => ({ prisma }));
        jest.doMock("fs/promises", () => fsPromises);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../cleanupDiscovery");

        return {
            module,
            logger,
            prisma,
            fsPromises,
        };
    }

    it("returns zero deletions when no stale discovery albums are found", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-02-17T12:00:00.000Z"));
        const { module, logger, prisma } = loadCleanupDiscovery();
        prisma.discoveryAlbum.findMany.mockResolvedValueOnce([]);

        const result = await module.cleanupDiscoveryTracks();

        expect(result).toEqual({ deletedAlbums: 0, deletedTracks: 0 });
        expect(prisma.discoveryAlbum.findMany).toHaveBeenCalledWith({
            where: {
                downloadedAt: { lt: expect.any(Date) },
            },
            include: {
                tracks: true,
            },
        });
        const queryArg = prisma.discoveryAlbum.findMany.mock.calls[0][0] as {
            where: { downloadedAt: { lt: Date } };
        };
        expect(queryArg.where.downloadedAt.lt.toISOString()).toBe(
            "2026-02-10T12:00:00.000Z"
        );
        expect(logger.debug).toHaveBeenCalledWith("  No cleanup needed");
        expect(prisma.discoveryAlbum.delete).not.toHaveBeenCalled();
        expect(prisma.discoveryTrack.delete).not.toHaveBeenCalled();
    });

    it("cleans up stale discovery albums and tracks while preserving in-use content", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-02-17T12:00:00.000Z"));
        const { module, logger, prisma, fsPromises } = loadCleanupDiscovery();

        prisma.discoveryAlbum.findMany.mockResolvedValueOnce([
            {
                id: "album-delete-success",
                albumTitle: "Delete Me",
                artistName: "Artist Delete",
                folderPath: "/music/discovery/delete-success",
                tracks: [
                    {
                        id: "delete-track-1",
                        userKept: false,
                        trackId: null,
                        lastPlayedAt: null,
                    },
                ],
            },
            {
                id: "album-delete-rm-error",
                albumTitle: "Delete Folder Error",
                artistName: "Artist Error",
                folderPath: "/music/discovery/delete-rm-error",
                tracks: [
                    {
                        id: "delete-track-2",
                        userKept: false,
                        trackId: "track-delete-album",
                        lastPlayedAt: "2026-01-01T00:00:00.000Z",
                    },
                ],
            },
            {
                id: "album-partial",
                albumTitle: "Partial Cleanup",
                artistName: "Artist Mixed",
                folderPath: "/music/discovery/partial",
                tracks: [
                    {
                        id: "keep-user-marked",
                        userKept: true,
                        trackId: "track-keep-user-marked",
                        lastPlayedAt: null,
                    },
                    {
                        id: "keep-in-playlist",
                        userKept: false,
                        trackId: "track-keep-playlist",
                        lastPlayedAt: null,
                    },
                    {
                        id: "keep-liked",
                        userKept: false,
                        trackId: "track-keep-liked",
                        lastPlayedAt: null,
                    },
                    {
                        id: "keep-recent-play",
                        userKept: false,
                        trackId: "track-keep-recent",
                        lastPlayedAt: "2026-02-16T00:00:00.000Z",
                    },
                    {
                        id: "delete-file-ok",
                        userKept: false,
                        trackId: "track-delete-file-ok",
                        lastPlayedAt: "2025-12-31T00:00:00.000Z",
                        filePath: "/music/discovery/partial/delete-ok.mp3",
                        fileName: "delete-ok.mp3",
                    },
                    {
                        id: "delete-file-error",
                        userKept: false,
                        trackId: "track-delete-file-error",
                        lastPlayedAt: "2025-12-31T00:00:00.000Z",
                        filePath: "/music/discovery/partial/delete-error.mp3",
                        fileName: "delete-error.mp3",
                    },
                    {
                        id: "delete-no-file",
                        userKept: false,
                        trackId: null,
                        lastPlayedAt: null,
                    },
                ],
            },
            {
                id: "album-keep-all",
                albumTitle: "All In Use",
                artistName: "Artist Keep",
                folderPath: "/music/discovery/keep",
                tracks: [
                    {
                        id: "keep-track-1",
                        userKept: true,
                        trackId: null,
                        lastPlayedAt: null,
                    },
                ],
            },
        ]);
        prisma.discoveryAlbum.delete.mockResolvedValue(undefined);
        prisma.discoveryTrack.delete.mockResolvedValue(undefined);
        prisma.playlistItem.findFirst.mockImplementation(
            async ({ where }: { where: { trackId: string } }) => {
                if (where.trackId === "track-keep-playlist") {
                    return { id: "playlist-item-1" };
                }
                return null;
            }
        );
        prisma.likedTrack.findFirst.mockImplementation(
            async ({ where }: { where: { trackId: string } }) => {
                if (where.trackId === "track-keep-liked") {
                    return { id: "liked-track-1" };
                }
                return null;
            }
        );
        fsPromises.rm
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("rm-failed"));
        fsPromises.unlink
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("unlink-failed"));

        const result = await module.cleanupDiscoveryTracks();

        expect(result).toEqual({ deletedAlbums: 2, deletedTracks: 5 });

        expect(prisma.discoveryAlbum.delete).toHaveBeenCalledTimes(2);
        expect(prisma.discoveryAlbum.delete).toHaveBeenNthCalledWith(1, {
            where: { id: "album-delete-success" },
        });
        expect(prisma.discoveryAlbum.delete).toHaveBeenNthCalledWith(2, {
            where: { id: "album-delete-rm-error" },
        });

        expect(fsPromises.rm).toHaveBeenCalledTimes(2);
        expect(fsPromises.rm).toHaveBeenCalledWith(
            "/music/discovery/delete-success",
            { recursive: true, force: true }
        );
        expect(fsPromises.rm).toHaveBeenCalledWith(
            "/music/discovery/delete-rm-error",
            { recursive: true, force: true }
        );
        expect(logger.warn).toHaveBeenCalledWith(
            "    Could not delete folder: Error: rm-failed"
        );

        expect(prisma.discoveryTrack.delete).toHaveBeenCalledTimes(3);
        expect(prisma.discoveryTrack.delete).toHaveBeenNthCalledWith(1, {
            where: { id: "delete-file-ok" },
        });
        expect(prisma.discoveryTrack.delete).toHaveBeenNthCalledWith(2, {
            where: { id: "delete-file-error" },
        });
        expect(prisma.discoveryTrack.delete).toHaveBeenNthCalledWith(3, {
            where: { id: "delete-no-file" },
        });

        expect(fsPromises.unlink).toHaveBeenCalledTimes(2);
        expect(fsPromises.unlink).toHaveBeenNthCalledWith(
            1,
            "/music/discovery/partial/delete-ok.mp3"
        );
        expect(fsPromises.unlink).toHaveBeenNthCalledWith(
            2,
            "/music/discovery/partial/delete-error.mp3"
        );
        expect(logger.warn).toHaveBeenCalledWith(
            "    Could not delete file: Error: unlink-failed"
        );

        expect(prisma.playlistItem.findFirst).toHaveBeenCalledWith({
            where: { trackId: "track-keep-playlist" },
        });
        expect(prisma.likedTrack.findFirst).toHaveBeenCalledWith({
            where: { trackId: "track-keep-liked" },
        });

        expect(logger.debug).toHaveBeenCalledWith(
            "  Partial cleanup: Partial Cleanup (3/7 tracks)"
        );
        expect(logger.debug).toHaveBeenCalledWith(
            "  Keeping album: All In Use (all tracks in use)"
        );
    });

    it("logs and rethrows cleanup failures", async () => {
        const { module, logger, prisma } = loadCleanupDiscovery();
        const error = new Error("discovery lookup failed");
        prisma.discoveryAlbum.findMany.mockRejectedValueOnce(error);

        await expect(module.cleanupDiscoveryTracks()).rejects.toThrow(
            "discovery lookup failed"
        );
        expect(logger.error).toHaveBeenCalledWith(
            "Cleanup discovery tracks error:",
            error
        );
    });
});
