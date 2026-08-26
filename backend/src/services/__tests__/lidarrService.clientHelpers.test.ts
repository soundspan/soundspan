import {
    AcquisitionError,
    AcquisitionErrorType,
    cleanStuckDownloads,
    getQueue,
    getQueueCount,
    getRecentCompletedDownloads,
    isDownloadActive,
    lidarrService,
    getSystemSettings,
    musicBrainzService,
    stripAlbumEdition,
    mockedConfig,
    logger,
    mockLidarrClient,
    mockLidarrHttpClient,
    mockGetSystemSettings,
    mockMusicBrainzSearchArtist,
    mockStripAlbumEdition,
    LidarrHttpError,
    createClientMock,
    primeServiceWithClient,
} from "./lidarrService.helpers";

function primeMonitoringFailure(
    client: ReturnType<typeof createClientMock>,
    sentinel: string,
) {
    const album = {
        id: 401,
        title: "Unstable Album",
        foreignAlbumId: "album-mbid",
        artistId: 101,
    };
    const unmonitored = {
        ...album,
        monitored: false,
        anyReleaseOk: false,
        releases: [{ id: 1 }],
        rawSecret: sentinel,
    };
    client.get
        .mockResolvedValueOnce({
            data: [
                {
                    id: 101,
                    artistName: "Artist",
                    foreignArtistId: "artist-mbid",
                    monitored: true,
                },
            ],
        })
        .mockResolvedValueOnce({ data: [album] })
        .mockResolvedValueOnce({ data: unmonitored })
        .mockResolvedValueOnce({ status: 200, data: unmonitored });
    client.put.mockResolvedValue({ data: { monitored: true } });
    client.post.mockResolvedValue({ data: { id: 7101 } });
    return album;
}

describe("lidarr service behavior", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetSystemSettings.mockResolvedValue(null);
        mockMusicBrainzSearchArtist.mockResolvedValue([]);
        mockStripAlbumEdition.mockImplementation((title: string) => title);
        mockedConfig.lidarr = undefined;
    });

    it("resolves queue items and calendar/monitored artist maps", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockResolvedValueOnce({
                data: {
                    records: [{ downloadId: "dl-2", id: 2, title: "Album 2" }],
                },
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 22,
                        title: "Release",
                        artist: {
                            id: 7,
                            artistName: "Artist Name",
                            foreignArtistId: "artist-mbid",
                        },
                        foreignAlbumId: "album-mbid",
                        releaseDate: "2026-02-17",
                        monitored: true,
                        grabbed: true,
                        statistics: { percentOfTracks: 100 },
                        images: [
                            {
                                coverType: "cover",
                                remoteUrl: "https://cover.jpg",
                            },
                        ],
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 7,
                        artistName: "Artist Name",
                        foreignArtistId: "artist-mbid",
                        monitored: true,
                    },
                    {
                        id: 8,
                        artistName: "Not Monitored",
                        foreignArtistId: "artist-2",
                        monitored: false,
                    },
                ],
            });

        await expect(
            lidarrService.findQueueItemByDownloadId("dl-2"),
        ).resolves.toEqual({ downloadId: "dl-2", id: 2, title: "Album 2" });

        const calendar = await lidarrService.getCalendar(
            new Date("2026-02-01"),
            new Date("2026-02-28"),
        );
        expect(calendar).toEqual([
            expect.objectContaining({
                id: 22,
                artistName: "Artist Name",
                albumMbid: "album-mbid",
                hasFile: true,
            }),
        ]);

        const monitored = await lidarrService.getMonitoredArtists();
        expect(monitored).toEqual([
            { id: 7, name: "Artist Name", mbid: "artist-mbid" },
        ]);
    });

    it("returns empty calendar when calendar endpoint errors", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockRejectedValueOnce(new Error("calendar error"));

        const calendar = await lidarrService.getCalendar(
            new Date("2026-02-01"),
            new Date("2026-02-28"),
        );
        expect(calendar).toEqual([]);
    });

    it("deletes artists/albums and checks availability helpers", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 51,
                        foreignArtistId: "artist-mbid-1",
                        artistName: "Artist 1",
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: {
                    id: 81,
                    artistId: 51,
                    title: "Album 81",
                },
            })
            .mockResolvedValueOnce({
                data: [{ id: 801 }, { id: 802 }],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        foreignAlbumId: "album-1",
                        statistics: { percentOfTracks: 100 },
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [
                    { id: 51, artistName: "Artist 1", sortName: "artist 1" },
                ],
            })
            .mockResolvedValueOnce({
                data: [
                    { title: "Album 1", statistics: { percentOfTracks: 100 } },
                ],
            })
            .mockResolvedValueOnce({
                data: [{ foreignArtistId: "artist-mbid-1" }],
            });
        client.delete.mockResolvedValue({});
        client.put.mockResolvedValue({});

        await expect(
            lidarrService.deleteArtist("artist-mbid-1"),
        ).resolves.toEqual(expect.objectContaining({ success: true }));
        await expect(lidarrService.deleteAlbum(81)).resolves.toEqual(
            expect.objectContaining({ success: true }),
        );
        await expect(lidarrService.isAlbumAvailable("album-1")).resolves.toBe(
            true,
        );
        await expect(
            lidarrService.isAlbumAvailableByTitle("Artist 1", "Album 1"),
        ).resolves.toBe(true);
        await expect(
            lidarrService.isArtistInLidarr("artist-mbid-1"),
        ).resolves.toBe(true);
    });

    it("searchAlbum falls back to stripped title when direct lookup returns no album", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        mockStripAlbumEdition.mockReturnValueOnce("Album");

        client.get.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({
            data: [
                { id: 901, title: "Album", foreignAlbumId: "album-mbid-901" },
            ],
        });

        await expect(
            lidarrService.searchAlbum("Artist", "Album (Deluxe)"),
        ).resolves.toEqual([
            expect.objectContaining({
                id: 901,
                foreignAlbumId: "album-mbid-901",
            }),
        ]);

        expect(client.get).toHaveBeenCalledTimes(2);
        expect(client.get).toHaveBeenNthCalledWith(2, "/api/v1/album/lookup", {
            params: { term: "Artist Album" },
        });
    });

    it("searchAlbum with MBID uses only primary lookup and does not try stripped title", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockResolvedValueOnce({ data: [] });

        await expect(
            lidarrService.searchAlbum("Artist", "Album", "album-mbid"),
        ).resolves.toEqual([]);

        expect(client.get).toHaveBeenCalledTimes(1);
        expect(client.get).toHaveBeenCalledWith("/api/v1/album/lookup", {
            params: { term: "lidarr:album-mbid" },
        });
    });

    it("searchAlbum returns empty list when album lookup fails", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockRejectedValueOnce(new Error("lookup down"));

        await expect(
            lidarrService.searchAlbum("Artist", "Album", "album-mbid"),
        ).resolves.toEqual([]);
    });

    it("searchAlbum throws when Lidarr is disabled", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(
            lidarrService.searchAlbum("Artist", "Album"),
        ).rejects.toThrow("Lidarr not enabled");
    });

    it("searchArtist returns empty on Lidarr error when no MBID is supplied", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockRejectedValueOnce(new Error("lookup down"));

        await expect(lidarrService.searchArtist("No Backup")).resolves.toEqual(
            [],
        );
    });

    it("waitForCommand rejects when command never reaches terminal state", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValue({
            data: {
                status: "queued",
                message: "",
            },
        });

        await expect(
            (lidarrService as any).waitForCommand(99, 10, 0),
        ).rejects.toThrow("Command 99 timed out after 10ms");
    });

    it("rescanLibrary dispatches command and returns errors from Lidarr", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.post.mockResolvedValue({ data: {} });

        await expect(lidarrService.rescanLibrary()).resolves.toBeUndefined();
        expect(client.post).toHaveBeenCalledWith("/api/v1/command", {
            name: "RescanFolders",
        });

        client.post.mockRejectedValueOnce(new Error("rescan failed"));
        await expect(lidarrService.rescanLibrary()).rejects.toThrow(
            "rescan failed",
        );
    });

    it("getArtists returns empty when Lidarr is disabled", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(lidarrService.getArtists()).resolves.toEqual([]);
    });

    it("getArtists falls back to empty list on fetch failure", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockRejectedValueOnce(new Error("artist fetch failed"));

        await expect(lidarrService.getArtists()).resolves.toEqual([]);
    });

    it("deleteArtist handles temporary MBID without touching Lidarr", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        await expect(
            lidarrService.deleteArtist("temp-artist"),
        ).resolves.toEqual({
            success: false,
            message: "Invalid or temporary MBID",
        });

        expect(client.get).not.toHaveBeenCalled();
        expect(client.delete).not.toHaveBeenCalled();
    });

    it("deleteArtist reports already removed artists as successful no-ops", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({ data: [] });

        await expect(
            lidarrService.deleteArtist("missing-mbid"),
        ).resolves.toEqual({
            success: true,
            message: "Artist not in Lidarr (already removed or never added)",
        });
    });

    it("deleteAlbum removes cached track files and unmonitors album", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockResolvedValueOnce({
                data: { id: 81, artistId: 33, title: "Album 81" },
            })
            .mockResolvedValueOnce({ data: [{ id: 201 }, { id: 202 }] });
        client.delete.mockResolvedValue({});
        client.put.mockResolvedValue({ data: {} });

        await expect(lidarrService.deleteAlbum(81)).resolves.toEqual(
            expect.objectContaining({
                success: true,
                message: "Deleted files and unmonitored Album 81",
            }),
        );

        expect(client.delete).toHaveBeenCalledWith("/api/v1/trackFile/201");
        expect(client.delete).toHaveBeenCalledWith("/api/v1/trackFile/202");
        expect(client.put).toHaveBeenCalledWith("/api/v1/album/81", {
            id: 81,
            artistId: 33,
            title: "Album 81",
            monitored: false,
        });
    });

    it("deleteAlbum returns a failure object on Lidarr errors", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockRejectedValueOnce(new Error("album missing"));

        await expect(lidarrService.deleteAlbum(99)).resolves.toEqual({
            success: false,
            message: "album missing",
        });
    });

    it("deleteArtist returns failure object when Lidarr delete fails", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockResolvedValueOnce({
            data: [
                {
                    id: 9,
                    artistName: "Failing Artist",
                    foreignArtistId: "artist-delete-fail",
                },
            ],
        });
        client.delete.mockRejectedValueOnce(new Error("delete failed"));

        await expect(
            lidarrService.deleteArtist("artist-delete-fail"),
        ).resolves.toEqual({
            success: false,
            message: "delete failed",
        });
    });

    it("returns safe defaults for disabled Lidarr helper methods", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(
            lidarrService.deleteArtist("artist-disabled"),
        ).resolves.toEqual({
            success: false,
            message: "Lidarr not enabled or configured",
        });
        await expect(lidarrService.deleteAlbum(9)).resolves.toEqual({
            success: false,
            message: "Lidarr not enabled or configured",
        });
        expect(await lidarrService.isAlbumAvailable("album-mbid")).toBe(false);
        expect(
            await lidarrService.isAlbumAvailableByTitle("Artist", "Album"),
        ).toBe(false);
        expect(await lidarrService.isArtistInLidarr("artist-disabled")).toBe(
            false,
        );
        expect(await lidarrService.getTags()).toEqual([]);
        expect(await lidarrService.createTag("new-tag")).toBeNull();
        expect(await lidarrService.getOrCreateDiscoveryTag()).toBeNull();
        expect(await lidarrService.addTagsToArtist(1, [3])).toBe(false);
        expect(await lidarrService.removeTagsFromArtist(1, [3])).toBe(false);
        expect(await lidarrService.getArtistsByTag(3)).toEqual([]);
        expect(
            await lidarrService.removeDiscoveryTagByMbid("artist-disabled"),
        ).toBe(false);
        await expect(lidarrService.deleteArtistById(7)).resolves.toEqual({
            success: false,
            message: "Lidarr not enabled",
        });
        const snapshot = await lidarrService.getReconciliationSnapshot();
        expect(snapshot.queue.size).toBe(0);
        expect(snapshot.albumsByMbid.size).toBe(0);
    });

    it("isAlbumAvailable reports false for missing, zero-file and 404 states", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockResolvedValueOnce({
            data: [
                {
                    foreignAlbumId: "album-mbid",
                    statistics: { percentOfTracks: 80 },
                },
            ],
        });
        await expect(
            lidarrService.isAlbumAvailable("album-mbid"),
        ).resolves.toBe(true);

        client.get.mockResolvedValueOnce({
            data: [
                {
                    foreignAlbumId: "other",
                    statistics: { percentOfTracks: 100 },
                },
            ],
        });
        await expect(
            lidarrService.isAlbumAvailable("album-mbid"),
        ).resolves.toBe(false);

        client.get.mockResolvedValueOnce({
            data: [
                {
                    foreignAlbumId: "album-mbid",
                    statistics: { percentOfTracks: 0 },
                },
            ],
        });
        await expect(
            lidarrService.isAlbumAvailable("album-mbid"),
        ).resolves.toBe(false);

        client.get.mockRejectedValueOnce({ response: { status: 404 } });
        await expect(
            lidarrService.isAlbumAvailable("album-mbid"),
        ).resolves.toBe(false);
    });

    it("isAlbumAvailableByTitle returns false when no matches or matching entries have no files", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockResolvedValueOnce({ data: [] });
        await expect(
            lidarrService.isAlbumAvailableByTitle("A", "B"),
        ).resolves.toBe(false);

        client.get
            .mockResolvedValueOnce({
                data: [{ id: 5, artistName: "Target", foreignArtistId: "mb" }],
            })
            .mockResolvedValueOnce({
                data: [{ title: "B", statistics: { percentOfTracks: 0 } }],
            });
        await expect(
            lidarrService.isAlbumAvailableByTitle("Target", "B"),
        ).resolves.toBe(false);
    });

    it("isAlbumAvailableByTitle returns true when title matches with files", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 55,
                        artistName: "Target Artist",
                        foreignArtistId: "target-mbid",
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 77,
                        title: "Wanted Album",
                        statistics: { percentOfTracks: 42 },
                    },
                ],
            });

        await expect(
            lidarrService.isAlbumAvailableByTitle(
                "Target Artist",
                "Wanted Album",
            ),
        ).resolves.toBe(true);
    });

    it("matches available albums across accents, punctuation, and conjunctions", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 55,
                        artistName: "Beyonce and Jay-Z",
                        sortName: "Beyonce and Jay-Z",
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        title: "Renaissance – Deluxe",
                        statistics: { percentOfTracks: 100 },
                    },
                ],
            });

        await expect(
            lidarrService.isAlbumAvailableByTitle(
                "Beyoncé & Jay Z",
                "Renaissance - Deluxe",
            ),
        ).resolves.toBe(true);
    });

    it("matches reconciliation snapshot keys across canonical variants", () => {
        const snapshot = {
            queue: new Map(),
            albumsByMbid: new Map(),
            albumsByTitle: new Map([
                [
                    "beyonceandjayz|renaissancedeluxe",
                    {
                        id: 1,
                        title: "Renaissance – Deluxe",
                        foreignAlbumId: "album-mbid",
                        artistName: "Beyonce and Jay-Z",
                        hasFiles: true,
                    },
                ],
            ]),
            fetchedAt: new Date(),
        } as any;

        expect(
            (lidarrService as any).isAlbumAvailableInSnapshot(
                snapshot,
                undefined,
                "Beyoncé & Jay Z",
                "Renaissance - Deluxe",
            ),
        ).toBe(true);
    });

    it("returns false on Lidarr availability lookup failures and checks snapshot helpers", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockRejectedValueOnce(new Error("album query failed"))
            .mockRejectedValueOnce(new Error("title lookup failed"));

        await expect(
            lidarrService.isAlbumAvailable("album-lookup-failed"),
        ).resolves.toBe(false);
        await expect(
            lidarrService.isAlbumAvailableByTitle(
                "Unavailable Artist",
                "Unavailable Album",
            ),
        ).resolves.toBe(false);

        const snapshot = {
            queue: new Map([
                [
                    "dl-1",
                    {
                        id: 1,
                        downloadId: "dl-1",
                        status: "downloading",
                        progress: 33,
                        title: "Known",
                    },
                ],
            ]),
            albumsByMbid: new Map([
                [
                    "album-mbid-1",
                    {
                        id: 1,
                        title: "Album",
                        foreignAlbumId: "album-mbid-1",
                        artistName: "Artist",
                        hasFiles: true,
                    },
                ],
            ]),
            albumsByTitle: new Map([
                [
                    "artist|albumdeluxe",
                    {
                        id: 1,
                        title: "Album Deluxe",
                        foreignAlbumId: "album-mbid-1",
                        artistName: "Artist",
                        hasFiles: true,
                    },
                ],
            ]),
            fetchedAt: new Date(),
        } as any;

        expect(
            (lidarrService as any).isAlbumAvailableInSnapshot(
                snapshot,
                undefined,
                "Artist",
                "Album Deluxe",
            ),
        ).toBe(true);
        expect(
            (lidarrService as any).isAlbumAvailableInSnapshot(
                snapshot,
                undefined,
                "Artist",
                "Album",
            ),
        ).toBe(true);
        expect(
            (lidarrService as any).isAlbumAvailableInSnapshot(
                snapshot,
                undefined,
                "Nope",
                "Missing",
            ),
        ).toBe(false);
        expect(
            (lidarrService as any).isDownloadActiveInSnapshot(
                snapshot,
                "dl-missing",
            ),
        ).toEqual({ active: false });
    });

    it("isArtistInLidarr returns false when artist is absent", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({
            data: [{ foreignArtistId: "other" }],
        });

        await expect(
            lidarrService.isArtistInLidarr("absent-mbid"),
        ).resolves.toBe(false);
    });

    it("isArtistInLidarr reports true when artist exists", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({
            data: [{ id: 11, foreignArtistId: "present-mbid" }],
        });

        await expect(
            lidarrService.isArtistInLidarr("present-mbid"),
        ).resolves.toBe(true);
    });

    it("getArtistsByTag filters artists using Lidarr tag ids", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({
            data: [
                {
                    id: 1,
                    foreignArtistId: "a",
                    tags: [9, 8],
                    artistName: "With Tag",
                },
                {
                    id: 2,
                    foreignArtistId: "b",
                    tags: [1],
                    artistName: "No Tag",
                },
            ],
        });

        await expect(lidarrService.getArtistsByTag(9)).resolves.toEqual([
            expect.objectContaining({
                id: 1,
                foreignArtistId: "a",
            }),
        ]);
    });

    it("returns empty list when artist-tag lookup fails", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockRejectedValueOnce(new Error("tag query failed"));

        await expect(lidarrService.getArtistsByTag(9)).resolves.toEqual([]);
    });

    it("getDiscoveryArtists returns discovery tagged artists and empty list when tag missing", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        const tagSpy = jest
            .spyOn(lidarrService as any, "getOrCreateDiscoveryTag")
            .mockResolvedValue(55);

        client.get.mockResolvedValueOnce({
            data: [
                { id: 1, artistName: "Tagged", tags: [55] },
                { id: 2, artistName: "Other", tags: [1] },
            ],
        });

        await expect(lidarrService.getDiscoveryArtists()).resolves.toEqual([
            expect.objectContaining({
                id: 1,
                artistName: "Tagged",
            }),
        ]);
        expect(tagSpy).toHaveBeenCalled();

        tagSpy.mockResolvedValue(null);
        client.get.mockClear();
        await expect(lidarrService.getDiscoveryArtists()).resolves.toEqual([]);
        tagSpy.mockRestore();
    });

    it("removeDiscoveryTagByMbid handles missing artist as no-op", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        (lidarrService as any).discoveryTagId = 10;
        client.get.mockResolvedValueOnce({ data: [] });

        await expect(
            lidarrService.removeDiscoveryTagByMbid("missing-mbid"),
        ).resolves.toBe(true);
    });

    it("removeDiscoveryTagByMbid is no-op when artist already lacks discovery tag", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        (lidarrService as any).discoveryTagId = 10;
        client.get.mockResolvedValueOnce({
            data: [{ foreignArtistId: "mb", tags: [99], id: 3 }],
        });
        client.put.mockResolvedValue({});

        await expect(
            lidarrService.removeDiscoveryTagByMbid("mb"),
        ).resolves.toBe(true);
        expect(client.put).not.toHaveBeenCalled();
    });

    it("deleteArtistById removes existing artists and handles already-removed state", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.delete.mockResolvedValueOnce({});
        await expect(lidarrService.deleteArtistById(7)).resolves.toEqual({
            success: true,
            message: "Artist deleted",
        });

        client.delete.mockRejectedValueOnce({
            response: { status: 404 },
            message: "missing",
        });
        await expect(lidarrService.deleteArtistById(8)).resolves.toEqual({
            success: true,
            message: "Artist already removed",
        });
    });

    it("deleteArtistById returns failure when deletion throws non-404 errors", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.delete.mockRejectedValueOnce({
            response: { status: 500 },
            message: "server down",
        });

        await expect(
            lidarrService.deleteArtistById(99, false),
        ).resolves.toEqual({
            success: false,
            message: "server down",
        });

        expect(client.delete).toHaveBeenCalledWith("/api/v1/artist/99", {
            params: { deleteFiles: false, addImportListExclusion: false },
        });
    });

    it("getReconciliationSnapshot fails closed on queue failures", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockRejectedValueOnce(new Error("queue fail"))
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 31,
                        title: "Fallback Album",
                        foreignAlbumId: "album-fallback",
                        artist: { artistName: "Fallback Artist" },
                        statistics: { percentOfTracks: 100 },
                    },
                ],
            });

        await expect(lidarrService.getReconciliationSnapshot()).rejects.toThrow(
            "queue fail",
        );
    });

    it("searchArtist returns direct results when Lidarr lookup is populated", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({
            data: [
                {
                    id: 10,
                    artistName: "Direct Artist",
                    foreignArtistId: "artist-direct",
                    artistType: "Person",
                    monitored: false,
                    statistics: { albumCount: 7 },
                },
            ],
        });

        const results = await lidarrService.searchArtist("Direct Artist");

        expect(results).toEqual([
            expect.objectContaining({
                id: 10,
                artistName: "Direct Artist",
                foreignArtistId: "artist-direct",
            }),
        ]);
        expect(mockMusicBrainzSearchArtist).not.toHaveBeenCalled();
    });

    it("ensureRootFolderExists returns requested path when service client is unavailable", async () => {
        const svc = lidarrService as any;
        svc.client = null;

        await expect(svc.ensureRootFolderExists("/fallback")).resolves.toBe(
            "/fallback",
        );
    });

    it("getArtistAlbums returns empty list when service client is unavailable", async () => {
        const svc = lidarrService as any;
        svc.client = null;

        await expect(
            lidarrService.getArtistAlbums("artist-mbid"),
        ).resolves.toEqual([]);
    });

    it("addArtist updates existing artist but skips missing album search when disabled", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const searchSpy = jest
            .spyOn(lidarrService as any, "searchArtist")
            .mockResolvedValue([
                {
                    id: 12,
                    artistName: "Artist",
                    foreignArtistId: "artist-existing",
                    artistType: "Person",
                    monitored: false,
                    statistics: { albumCount: 6 },
                },
            ]);

        client.get
            .mockResolvedValueOnce({ data: [{ path: "/music" }] })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 12,
                        artistName: "Artist",
                        foreignArtistId: "artist-existing",
                        monitored: false,
                        tags: [1],
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [{ id: 121, monitored: false }],
            });
        client.put.mockResolvedValueOnce({
            data: {
                id: 12,
                artistName: "Artist",
                foreignArtistId: "artist-existing",
                monitored: true,
            },
        });

        await expect(
            lidarrService.addArtist(
                "artist-existing",
                "Artist",
                "/music",
                false,
                true,
                false,
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                id: 12,
                foreignArtistId: "artist-existing",
            }),
        );

        expect(client.post).not.toHaveBeenCalled();
        expect(client.put).toHaveBeenCalledWith(
            "/api/v1/artist/12",
            expect.objectContaining({
                monitored: true,
                monitorNewItems: "all",
            }),
        );
        searchSpy.mockRestore();
    });

    it("addArtist falls back to existing artist when monitoring update fails", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const searchSpy = jest
            .spyOn(lidarrService as any, "searchArtist")
            .mockResolvedValue([
                {
                    id: 21,
                    artistName: "Fallback Artist",
                    foreignArtistId: "artist-failing-update",
                    artistType: "Person",
                    monitored: false,
                    statistics: { albumCount: 4 },
                },
            ]);

        const existingArtist = {
            id: 21,
            artistName: "Fallback Artist",
            foreignArtistId: "artist-failing-update",
            monitored: false,
            tags: [5],
        };

        client.get
            .mockResolvedValueOnce({ data: [{ path: "/music" }] })
            .mockResolvedValueOnce({ data: [existingArtist] });
        client.put.mockRejectedValueOnce(new Error("database lock"));

        await expect(
            lidarrService.addArtist(
                "artist-failing-update",
                "Fallback Artist",
                "/music",
                true,
                true,
                false,
            ),
        ).resolves.toEqual(existingArtist);

        expect(client.put).toHaveBeenCalledTimes(1);
        searchSpy.mockRestore();
    });

    it("addArtist continues when metadata refresh fails after creation", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        const setTimeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation((callback: (...args: any[]) => void) => {
                callback();
                return 0 as any;
            });

        client.get
            .mockResolvedValueOnce({ data: [{ path: "/music" }] })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 77,
                        artistName: "Refresh Fail Artist",
                        foreignArtistId: "artist-refresh-fail",
                        artistType: "Person",
                        monitored: false,
                        statistics: { albumCount: 1 },
                    },
                ],
            })
            .mockResolvedValueOnce({ data: [] });
        client.post
            .mockResolvedValueOnce({
                data: {
                    id: 77,
                    artistName: "Refresh Fail Artist",
                    foreignArtistId: "artist-refresh-fail",
                },
            })
            .mockRejectedValueOnce(new Error("refresh failed"));

        await expect(
            lidarrService.addArtist(
                "artist-refresh-fail",
                "Refresh Fail Artist",
                "/music",
                false,
                false,
                false,
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                id: 77,
                foreignArtistId: "artist-refresh-fail",
            }),
        );

        expect(client.post).toHaveBeenCalledWith("/api/v1/command", {
            name: "RefreshArtist",
            artistId: 77,
        });
        setTimeoutSpy.mockRestore();
    });

    it("searchAlbum does not attempt stripped lookup when title is unchanged", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({ data: [] });

        await expect(
            lidarrService.searchAlbum("Artist", "Album"),
        ).resolves.toEqual([]);

        expect(client.get).toHaveBeenCalledTimes(1);
        expect(client.get).toHaveBeenCalledWith("/api/v1/album/lookup", {
            params: { term: "Artist Album" },
        });
    });

    it("does not log raw Lidarr response bodies from acquisition catches", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        const sentinel = "response-body-api-key-sentinel";
        const failure = (method: string, path: string) =>
            new LidarrHttpError({
                status: 500,
                method,
                path,
                attempts: 1,
                isTransient: true,
                data: [{ errorMessage: sentinel }],
            });
        const searchArtistSpy = jest
            .spyOn(lidarrService, "searchArtist")
            .mockRejectedValueOnce(failure("GET", "/api/v1/artist/lookup"));
        client.get
            .mockResolvedValueOnce({ data: [{ path: "/music" }] })
            .mockRejectedValueOnce(failure("GET", "/api/v1/album/lookup"))
            .mockRejectedValueOnce(failure("GET", "/api/v1/artist"));
        client.post.mockRejectedValueOnce(failure("POST", "/api/v1/release"));

        await expect(
            lidarrService.addArtist("artist-mbid", "Artist"),
        ).resolves.toBeNull();
        await expect(
            lidarrService.searchAlbum("Artist", "Album"),
        ).resolves.toEqual([]);
        await expect(
            lidarrService.addAlbum(
                "album-mbid",
                "Artist",
                "Album",
                "/music",
                "artist-mbid",
            ),
        ).resolves.toBeNull();
        await expect(
            lidarrService.grabRelease({
                guid: "release-guid",
                indexerId: 1,
                title: "Release",
                protocol: "torrent",
                approved: true,
                rejected: false,
            }),
        ).resolves.toBe(false);

        const errorLogs = (logger.error as jest.Mock).mock.calls;
        expect(JSON.stringify(errorLogs)).not.toContain(sentinel);
        for (const path of [
            "/api/v1/artist/lookup",
            "/api/v1/album/lookup",
            "/api/v1/artist",
            "/api/v1/release",
        ]) {
            expect(errorLogs).toContainEqual([
                expect.any(String),
                expect.objectContaining({
                    message: `Lidarr ${path === "/api/v1/release" ? "POST" : "GET"} ${path} failed after 1 attempt(s)`,
                    status: 500,
                    path,
                }),
            ]);
        }
        searchArtistSpy.mockRestore();
    });

    it("does not log raw album payloads when monitoring does not persist", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        const sentinel = "monitoring-payload-api-key-sentinel";
        const album = primeMonitoringFailure(client, sentinel);
        const waitSpy = jest
            .spyOn(lidarrService as any, "waitForCommand")
            .mockResolvedValue({
                status: "completed",
                message: "Search completed with 1 report",
            });

        await lidarrService.addAlbum(
            album.foreignAlbumId,
            "Artist",
            album.title,
            "/music",
            "artist-mbid",
        );

        const errorLogs = (logger.error as jest.Mock).mock.calls;
        expect(JSON.stringify(errorLogs)).not.toContain(sentinel);
        expect(errorLogs).toContainEqual([
            " CRITICAL: Album monitoring failed to persist!",
            {
                albumId: album.id,
                title: album.title,
                monitored: false,
                status: 200,
            },
        ]);
        waitSpy.mockRestore();
    });

    it("addAlbum refreshes metadata when an existing artist has no albums", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        const setTimeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation((callback: (...args: any[]) => void) => {
                callback();
                return 0 as any;
            });

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 55,
                        artistName: "Artist",
                        foreignArtistId: "artist-mbid-refresh",
                        monitored: true,
                    },
                ],
            })
            .mockResolvedValueOnce({ data: [] })
            .mockResolvedValueOnce({ data: [] });
        client.post.mockResolvedValue({ data: { id: 99 } });

        await expect(
            lidarrService.addAlbum(
                "album-mbid-refresh",
                "Artist",
                "Album",
                "/music",
                "artist-mbid-refresh",
            ),
        ).resolves.toBeNull();

        expect(client.post).toHaveBeenCalledWith("/api/v1/command", {
            name: "RefreshArtist",
            artistId: 55,
        });
        setTimeoutSpy.mockRestore();
    });

    it("addAlbum adds a missing artist and enables monitoring for the artist and album", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const addArtistSpy = jest
            .spyOn(lidarrService as any, "addArtist")
            .mockResolvedValue({
                id: 88,
                artistName: "Added Artist",
                foreignArtistId: "artist-added",
                monitored: false,
                tags: [],
            });
        const waitSpy = jest
            .spyOn(lidarrService as any, "waitForCommand")
            .mockResolvedValue({
                status: "completed",
                message: "Search completed with 1 report",
            });

        client.get
            .mockResolvedValueOnce({ data: [] }) // addAlbum did not find existing artist
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 301,
                        title: "Album Added",
                        foreignAlbumId: "album-added-mbid",
                        artistId: 88,
                        monitored: false,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: {
                    id: 301,
                    title: "Album Added",
                    foreignAlbumId: "album-added-mbid",
                    artistId: 88,
                    monitored: false,
                    releases: [{ id: 10 }],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    id: 301,
                    title: "Album Added",
                    foreignAlbumId: "album-added-mbid",
                    artistId: 88,
                    monitored: true,
                    releases: [{ id: 10 }],
                },
            });
        client.put.mockResolvedValue({
            data: {
                id: 301,
                title: "Album Added",
                foreignAlbumId: "album-added-mbid",
                artistId: 88,
                monitored: true,
            },
        });
        client.post.mockResolvedValue({
            data: { id: 909 },
        });

        await expect(
            lidarrService.addAlbum(
                "album-added-mbid",
                "Added Artist",
                "Album Added",
                "/music",
                "artist-added",
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                id: 301,
                foreignAlbumId: "album-added-mbid",
                monitored: true,
            }),
        );

        expect(addArtistSpy).toHaveBeenCalledWith(
            "artist-added",
            "Added Artist",
            "/music",
            false,
            false,
            false,
        );
        expect(client.put).toHaveBeenCalledWith(
            "/api/v1/artist/88",
            expect.objectContaining({
                id: 88,
                artistName: "Added Artist",
                foreignArtistId: "artist-added",
                monitored: true,
                tags: [],
            }),
        );
        expect(client.put).toHaveBeenCalledWith(
            "/api/v1/album/301",
            expect.objectContaining({
                id: 301,
                title: "Album Added",
                monitored: true,
            }),
        );

        addArtistSpy.mockRestore();
        waitSpy.mockRestore();
    });

    it("getCalendar returns empty list without client", async () => {
        const svc = lidarrService as any;
        svc.client = null;

        const calendar = await lidarrService.getCalendar(
            new Date("2026-02-01"),
            new Date("2026-02-28"),
        );
        expect(calendar).toEqual([]);
    });

    it("getMonitoredArtists returns empty list without client", async () => {
        const svc = lidarrService as any;
        svc.client = null;

        const artists = await lidarrService.getMonitoredArtists();
        expect(artists).toEqual([]);
    });

    it("cleanStuckDownloads removes terminal import-failed items", async () => {
        mockLidarrClient.get.mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 11,
                        title: "Terminal Import Failed",
                        statusMessages: [],
                        trackedDownloadStatus: "warning",
                        trackedDownloadState: "importFailed",
                    },
                ],
            },
        });
        mockLidarrClient.delete.mockResolvedValue({});

        const result = await cleanStuckDownloads(
            "http://lidarr:8686",
            "api-key",
        );
        expect(result).toEqual({
            removed: 1,
            items: ["Terminal Import Failed"],
        });
        expect(mockLidarrClient.delete).toHaveBeenCalledTimes(1);
    });

    it("initializes a Lidarr client from environment config during construction", () => {
        const constructedClient = createClientMock();
        mockedConfig.lidarr = {
            enabled: true,
            url: "http://constructor-lidarr:8686",
            apiKey: "constructor-key",
        };
        mockLidarrHttpClient.mockImplementationOnce(
            () => constructedClient as any,
        );

        const ServiceClass = (lidarrService as any).constructor;
        const freshService = new ServiceClass();

        expect(mockLidarrHttpClient).toHaveBeenCalledWith(
            {
                baseUrl: "http://constructor-lidarr:8686",
                apiKey: "constructor-key",
            },
            { timeoutMs: 30_000 },
        );
        expect(freshService.client).toBe(constructedClient);
        expect(freshService.enabled).toBe(true);
    });

    it("falls back to disabled state when settings are off and env config is absent", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            lidarrEnabled: false,
            lidarrUrl: null,
            lidarrApiKey: null,
        });
        mockedConfig.lidarr = undefined;

        const svc = lidarrService as any;
        svc.initialized = false;
        svc.enabled = true;
        svc.client = null;

        await expect(lidarrService.isEnabled()).resolves.toBe(false);
    });

    it("addAlbum waits for metadata after adding a new artist and logs timeout when still empty", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const setTimeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation((callback: (...args: any[]) => void) => {
                callback();
                return 0 as any;
            });

        const addArtistSpy = jest
            .spyOn(lidarrService as any, "addArtist")
            .mockResolvedValue({
                id: 88,
                artistName: "Timeout Artist",
                foreignArtistId: "artist-timeout",
                artistType: "Person",
                monitored: false,
            });

        client.get.mockResolvedValue({ data: [] });

        await expect(
            lidarrService.addAlbum(
                "album-timeout",
                "Timeout Artist",
                "No Data Album",
                "/music",
                "artist-timeout",
            ),
        ).resolves.toBeNull();

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Timeout reached after 60s"),
        );

        addArtistSpy.mockRestore();
        setTimeoutSpy.mockRestore();
    });

    it.each([
        ["parenthetical", "("],
        ["bracket", "["],
    ])(
        "addAlbum preserves exact title matching for a long unmatched %s opening delimiter",
        async (_case, openingDelimiter) => {
            const client = createClientMock();
            primeServiceWithClient(client);
            const longTitle = `Long Album ${openingDelimiter.repeat(50_000)}`;
            const artist = {
                id: 56,
                artistName: "Long Match Band",
                foreignArtistId: "artist-long-match",
                monitored: true,
            };
            const album = {
                id: 903,
                title: longTitle,
                foreignAlbumId: "album-long-match",
                artistId: 56,
            };

            client.get
                .mockResolvedValueOnce({ data: [artist] })
                .mockResolvedValueOnce({ data: [album] })
                .mockResolvedValueOnce({
                    data: {
                        ...album,
                        monitored: true,
                        anyReleaseOk: true,
                        releases: [{ id: 1 }],
                    },
                })
                .mockResolvedValueOnce({
                    data: {
                        ...album,
                        monitored: true,
                        anyReleaseOk: true,
                        releases: [{ id: 1 }],
                    },
                });
            client.put.mockResolvedValue({
                data: { ...album, monitored: true },
            });
            client.post.mockResolvedValue({ data: { id: 9103 } });
            const waitSpy = jest
                .spyOn(lidarrService as any, "waitForCommand")
                .mockResolvedValue({
                    status: "completed",
                    message: "Search completed with 1 report",
                });
            const startedAt = performance.now();

            await expect(
                lidarrService.addAlbum(
                    "different-mbid",
                    "Long Match Band",
                    longTitle,
                    "/music",
                    "artist-long-match",
                ),
            ).resolves.toEqual(expect.objectContaining({ id: 903 }));
            expect(performance.now() - startedAt).toBeLessThan(500);

            waitSpy.mockRestore();
        },
    );

    it("getOrCreateDiscoveryTag returns null when tag discovery fails", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        const getTagsSpy = jest
            .spyOn(lidarrService as any, "getTags")
            .mockRejectedValueOnce(new Error("tag lookup failed"));
        (lidarrService as any).discoveryTagId = null;

        await expect(
            lidarrService.getOrCreateDiscoveryTag(),
        ).resolves.toBeNull();
        expect(getTagsSpy).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(
            "[LIDARR] Failed to get/create discovery tag:",
            expect.objectContaining({ message: "tag lookup failed" }),
        );

        getTagsSpy.mockRestore();
    });

    it("removeDiscoveryTagByMbid returns false when discovery tag id is unavailable", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const discoverySpy = jest
            .spyOn(lidarrService as any, "getOrCreateDiscoveryTag")
            .mockResolvedValue(null);

        await expect(
            lidarrService.removeDiscoveryTagByMbid("artist-without-tag-id"),
        ).resolves.toBe(false);
        expect(discoverySpy).toHaveBeenCalled();

        discoverySpy.mockRestore();
    });

    it("blocklistAndRemove returns false when removal request is rejected", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 100,
                        downloadId: "remove-fail",
                        title: "Album",
                    },
                ],
            },
        });
        client.delete.mockRejectedValueOnce(
            new LidarrHttpError({
                status: 500,
                method: "DELETE",
                path: "/api/v1/queue/100",
                attempts: 3,
                isTransient: true,
                message: "delete failed",
            }),
        );

        await expect(
            lidarrService.blocklistAndRemove("remove-fail", true),
        ).resolves.toBe(false);
        expect(logger.error).toHaveBeenCalledWith(
            "[LIDARR] Failed to blocklist:",
            "delete failed",
        );
    });

    it("blocklistAndRemove treats a queue-list 404 as a failure", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockRejectedValueOnce(
            new LidarrHttpError({
                status: 404,
                method: "GET",
                path: "/api/v1/queue",
                attempts: 1,
                isTransient: false,
                message: "queue endpoint not found",
            }),
        );

        await expect(
            lidarrService.blocklistAndRemove("missing", false),
        ).resolves.toBe(false);
        expect(client.delete).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            "[LIDARR] Failed to blocklist:",
            "queue endpoint not found",
        );
    });

    it("clearFailedQueue removes failed items and searches their albums", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({
            data: {
                records: [
                    { id: 10, albumId: 20, status: "failed", title: "Failed" },
                    {
                        id: 11,
                        status: "downloading",
                        title: "Healthy",
                        statusMessages: [],
                    },
                ],
            },
        });
        client.delete.mockResolvedValueOnce({ data: undefined });
        client.post.mockResolvedValueOnce({ data: { id: 30 } });

        const signal = new AbortController().signal;
        await expect(lidarrService.clearFailedQueue(signal)).resolves.toEqual({
            removed: 1,
            errors: [],
        });
        expect(client.get).toHaveBeenCalledWith("/api/v1/queue", {
            timeoutMs: 10_000,
            maxRetries: 0,
            signal,
        });
        expect(client.delete).toHaveBeenCalledWith("/api/v1/queue/10", {
            params: {
                removeFromClient: true,
                blocklist: true,
                skipRedownload: false,
            },
            timeoutMs: 10_000,
            maxRetries: 0,
            signal,
        });
        expect(client.post).toHaveBeenCalledWith(
            "/api/v1/command",
            {
                name: "AlbumSearch",
                albumIds: [20],
            },
            { timeoutMs: 10_000, maxRetries: 0, signal },
        );
    });

    it("clearFailedQueue collects delete errors and tolerates search failures", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({
            data: {
                records: [
                    { id: 301, albumId: 91, status: "failed" },
                    { id: 302, albumId: 92, status: "warning" },
                ],
            },
        });
        client.delete
            .mockRejectedValueOnce(new Error("delete failed"))
            .mockResolvedValueOnce({});
        client.post.mockRejectedValueOnce(new Error("search trigger failed"));

        await expect(lidarrService.clearFailedQueue()).resolves.toEqual({
            removed: 1,
            errors: ["Failed to remove 301: delete failed"],
        });
        expect(client.post).toHaveBeenCalledTimes(1);
    });

    it("clearFailedQueue returns the queue-fetch failure", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockRejectedValueOnce(new Error("queue unavailable"));

        await expect(lidarrService.clearFailedQueue()).resolves.toEqual({
            removed: 0,
            errors: ["queue unavailable"],
        });
        expect(client.delete).not.toHaveBeenCalled();
    });

    it("clearFailedQueue normalizes non-Error delete rejections", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({
            data: {
                records: [
                    { id: 901, status: "failed" },
                    { id: 902, status: "warning" },
                ],
            },
        });
        client.delete
            .mockRejectedValueOnce("network")
            .mockResolvedValueOnce({});

        await expect(lidarrService.clearFailedQueue()).resolves.toEqual({
            removed: 1,
            errors: ["Failed to remove 901: network"],
        });
    });

    it("clearFailedQueue starts at most two deletions at a time", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({
            data: {
                records: Array.from({ length: 5 }, (_, index) => ({
                    id: index + 1,
                    status: "failed",
                    title: `Failed ${index + 1}`,
                })),
            },
        });
        const releases: Array<() => void> = [];
        client.delete.mockImplementation(
            () => new Promise((resolve) => releases.push(() => resolve({}))),
        );

        const cleanup = lidarrService.clearFailedQueue();
        await Promise.resolve();
        await Promise.resolve();
        expect(client.delete).toHaveBeenCalledTimes(2);
        releases.splice(0, 2).forEach((release) => release());
        await Promise.resolve();
        await Promise.resolve();
        expect(client.delete).toHaveBeenCalledTimes(4);
        releases.splice(0, 2).forEach((release) => release());
        await Promise.resolve();
        await Promise.resolve();
        expect(client.delete).toHaveBeenCalledTimes(5);
        releases.splice(0).forEach((release) => release());
        await expect(cleanup).resolves.toEqual({ removed: 5, errors: [] });
    });

    it("clearFailedQueue counts a retried queue DELETE 404 as removed", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({
            data: { records: [{ id: 10, status: "failed", title: "Gone" }] },
        });
        client.delete.mockRejectedValueOnce(
            new LidarrHttpError({
                status: 404,
                method: "DELETE",
                path: "/api/v1/queue/10",
                attempts: 2,
                isTransient: false,
                data: { message: "Not Found" },
                message: "Request failed with status code 404",
            }),
        );

        await expect(lidarrService.clearFailedQueue()).resolves.toEqual({
            removed: 1,
            errors: [],
        });
    });

    it("blocklistAndRemove accepts a retried queue DELETE 404", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({
            data: {
                records: [
                    { id: 12, downloadId: "already-gone", title: "Gone" },
                ],
            },
        });
        client.delete.mockRejectedValueOnce(
            new LidarrHttpError({
                status: 404,
                method: "DELETE",
                path: "/api/v1/queue/12",
                attempts: 2,
                isTransient: false,
                data: { message: "Not Found" },
                message: "Request failed with status code 404",
            }),
        );

        await expect(
            lidarrService.blocklistAndRemove("already-gone", false),
        ).resolves.toBe(true);
    });

    it("rescanLibrary throws when Lidarr is disabled", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(lidarrService.rescanLibrary()).rejects.toThrow(
            "Lidarr not enabled",
        );
    });

    it("checks album availability with generic Lidarr failures", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockRejectedValueOnce(new Error("album query failed"));

        await expect(
            lidarrService.isAlbumAvailable("album-failure"),
        ).resolves.toBe(false);
        expect(logger.error).toHaveBeenCalledWith(
            "Lidarr album check error:",
            "album query failed",
        );
    });

    it("checks artist existence with fallback false on Lidarr errors", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockRejectedValueOnce(new Error("artist fetch failed"));

        await expect(
            lidarrService.isArtistInLidarr("artist-failure"),
        ).resolves.toBe(false);
    });

    it("getAlbumReleases sorts approval-first and seeds-second and returns empty list on failures", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockResolvedValueOnce({
                data: [
                    { id: 1, title: "Seeded C", approved: false, seeders: 2 },
                    { id: 2, title: "Approved A", approved: true, seeders: 1 },
                    { id: 3, title: "Seeded B", approved: false, seeders: 9 },
                ],
            })
            .mockRejectedValueOnce(
                new LidarrHttpError({
                    status: 500,
                    method: "GET",
                    path: "/api/v1/release",
                    attempts: 1,
                    isTransient: true,
                    data: [{ errorMessage: "release-body-secret-sentinel" }],
                }),
            );

        await expect(lidarrService.getAlbumReleases(12)).resolves.toEqual([
            expect.objectContaining({ id: 2 }),
            expect.objectContaining({ id: 3 }),
            expect.objectContaining({ id: 1 }),
        ]);
        expect(client.get).toHaveBeenCalledWith("/api/v1/release", {
            params: { albumId: 12 },
            timeoutMs: 60_000,
            maxRetries: 0,
        });

        const emptyReleases = await lidarrService.getAlbumReleases(13);
        expect(emptyReleases).toEqual([]);
        expect(logger.error).toHaveBeenCalledWith(
            "[LIDARR] Failed to fetch releases:",
            expect.objectContaining({
                status: 500,
                path: "/api/v1/release",
            }),
        );
        const releaseLogCalls = JSON.stringify(
            (logger.error as jest.Mock).mock.calls,
        );
        expect(releaseLogCalls).not.toContain("release-body-secret-sentinel");
    });

    it("returns null for findQueueItemByDownloadId when client is unavailable", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(
            (lidarrService as any).findQueueItemByDownloadId("dl-disabled"),
        ).resolves.toBeNull();
    });

    it("findQueueItemByDownloadId returns null when queue lookup fails", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockRejectedValueOnce(new Error("queue down"));

        await expect(
            (lidarrService as any).findQueueItemByDownloadId("dl-down"),
        ).resolves.toBeNull();
        expect(logger.error).toHaveBeenCalledWith(
            "[LIDARR] Failed to find queue item:",
            "queue down",
        );
    });

    it("getMonitoredArtists returns empty list on fetch failures", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockRejectedValueOnce(
            new Error("monitored artists unavailable"),
        );

        await expect(lidarrService.getMonitoredArtists()).resolves.toEqual([]);
        expect(logger.error).toHaveBeenCalledWith(
            "[LIDARR] Failed to fetch monitored artists:",
            "monitored artists unavailable",
        );
    });

    it("rejects when reconciliation snapshot enrichment is malformed", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockResolvedValueOnce({
                data: {
                    records: [],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    records: 5 as any,
                },
            });

        await expect(lidarrService.getReconciliationSnapshot()).rejects.toThrow(
            "not readable",
        );
        expect(logger.error).toHaveBeenCalledWith(
            "[LIDARR] Failed to create reconciliation snapshot:",
            expect.objectContaining({
                message: "Lidarr album response was not readable",
            }),
        );
    });

    it("re-throws non-release errors from base-album fallback as add-album failure", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        (lidarrService as any)._indexerCountLogged = true;
        const baseTitleSpy = jest
            .spyOn(lidarrService as any, "extractBaseTitle")
            .mockReturnValue("Fallback Album");

        const artist = {
            id: 303,
            artistName: "Base Album Artist",
            foreignArtistId: "artist-base-fallback",
            monitored: true,
        };

        const baseAlbums = [
            {
                id: 701,
                title: "Fallback Album (Remix)",
                foreignAlbumId: "album-base-fallback",
                artistId: 303,
            },
            {
                id: 702,
                title: "Fallback Album",
                foreignAlbumId: "album-base-fallback-2",
                artistId: 303,
            },
        ];

        client.get
            .mockResolvedValueOnce({ data: [artist] })
            .mockResolvedValueOnce({ data: baseAlbums })
            .mockResolvedValueOnce({
                data: {
                    id: 701,
                    title: "Fallback Album (Remix)",
                    foreignAlbumId: "album-base-fallback",
                    artistId: 303,
                    monitored: false,
                    anyReleaseOk: false,
                    releases: [{ id: 1 }],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    id: 701,
                    title: "Fallback Album (Remix)",
                    foreignAlbumId: "album-base-fallback",
                    artistId: 303,
                    monitored: true,
                    anyReleaseOk: false,
                    releases: [{ id: 1 }],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    id: 702,
                    title: "Fallback Album",
                    foreignAlbumId: "album-base-fallback-2",
                    artistId: 303,
                    monitored: false,
                    anyReleaseOk: false,
                    releases: [{ id: 2 }],
                },
            });

        client.put.mockResolvedValue({
            data: {
                id: 701,
                title: "Fallback Album (Remix)",
                foreignAlbumId: "album-base-fallback",
                monitored: true,
            },
        });
        client.post
            .mockResolvedValueOnce({ data: { id: 7401 } })
            .mockResolvedValueOnce({ data: { id: 7402 } })
            .mockResolvedValueOnce({ data: { id: 7403 } });

        const waitSpy = jest
            .spyOn(lidarrService as any, "waitForCommand")
            .mockResolvedValueOnce({
                status: "completed",
                message: "Search completed with 0 reports",
            })
            .mockResolvedValueOnce({
                status: "completed",
                message: "Retry completed with 0 reports",
            })
            .mockRejectedValueOnce(new Error("base search command failed"));

        await expect(
            lidarrService.addAlbum(
                "album-base-fallback",
                "Base Album Artist",
                "Fallback Album (Remix)",
                "/music",
                "artist-base-fallback",
            ),
        ).rejects.toBeInstanceOf(AcquisitionError);
        expect(baseTitleSpy).toHaveBeenCalledWith("Fallback Album (Remix)");

        baseTitleSpy.mockRestore();
        waitSpy.mockRestore();
    });
});

describe("lidarr exported queue/history helpers", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr:8686",
            lidarrApiKey: "api-key",
        });
    });

    it("cleans stuck queue downloads by status and message patterns", async () => {
        mockLidarrClient.get.mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 1,
                        title: "Album One",
                        statusMessages: [
                            {
                                title: "msg",
                                messages: [
                                    "No files found are eligible for import",
                                ],
                            },
                        ],
                        trackedDownloadStatus: "ok",
                        trackedDownloadState: "downloading",
                    },
                    {
                        id: 2,
                        title: "Album Two",
                        statusMessages: [],
                        trackedDownloadStatus: "warning",
                        trackedDownloadState: "importPending",
                    },
                    {
                        id: 3,
                        title: "Album Three",
                        statusMessages: [],
                        trackedDownloadStatus: "ok",
                        trackedDownloadState: "importFailed",
                    },
                ],
            },
        });
        mockLidarrClient.delete.mockResolvedValue({});

        const result = await cleanStuckDownloads(
            "http://lidarr:8686",
            "api-key",
        );
        expect(result.removed).toBe(3);
        expect(result.items).toEqual(["Album One", "Album Two", "Album Three"]);
        expect(mockLidarrClient.delete).toHaveBeenCalledTimes(3);
    });

    it("filters recent completed downloads from history", async () => {
        const now = Date.now();
        mockLidarrClient.get.mockResolvedValueOnce({
            data: {
                records: [
                    { id: 1, date: new Date(now - 60_000).toISOString() },
                    { id: 2, date: new Date(now - 20 * 60_000).toISOString() },
                ],
            },
        });

        const records = await getRecentCompletedDownloads(
            "http://lidarr:8686",
            "api-key",
            5,
        );
        expect(records).toHaveLength(1);
        expect(records[0].id).toBe(1);
    });

    it("returns queue count with safe fallback on errors", async () => {
        mockLidarrClient.get.mockResolvedValueOnce({
            data: { totalRecords: 17 },
        });
        await expect(
            getQueueCount("http://lidarr:8686", "api-key"),
        ).resolves.toBe(17);

        mockLidarrClient.get.mockRejectedValueOnce(new Error("queue down"));
        await expect(
            getQueueCount("http://lidarr:8686", "api-key"),
        ).resolves.toBe(0);
    });

    it("returns queue and active download status from settings", async () => {
        mockLidarrClient.get
            .mockResolvedValueOnce({
                data: {
                    records: [
                        { id: 11, downloadId: "dl-11", status: "downloading" },
                    ],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    records: [
                        {
                            id: 11,
                            downloadId: "dl-11",
                            status: "downloading",
                            trackedDownloadStatus: "ok",
                            trackedDownloadState: "downloading",
                            size: 100,
                            sizeleft: 25,
                        },
                    ],
                },
            })
            .mockResolvedValueOnce({
                data: { records: [] },
            });

        const queue = await getQueue();
        const active = await isDownloadActive("dl-11");
        const missing = await isDownloadActive("dl-missing");

        expect(queue).toEqual([
            { id: 11, downloadId: "dl-11", status: "downloading" },
        ]);
        expect(active).toEqual({
            active: true,
            status: "downloading",
            progress: 75,
        });
        expect(missing).toEqual({ active: false, status: "not_found" });
    });

    it("marks warning-tracked downloads as inactive even when still downloading", async () => {
        mockLidarrClient.get.mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 19,
                        downloadId: "dl-warning",
                        status: "queued",
                        trackedDownloadStatus: "warning",
                        trackedDownloadState: "downloading",
                        size: 100,
                        sizeleft: 40,
                    },
                ],
            },
        });

        await expect(isDownloadActive("dl-warning")).resolves.toEqual({
            active: false,
            status: "downloading",
            progress: 60,
        });
    });

    it("counts an already-removed queue item as successfully cleaned", async () => {
        mockLidarrClient.get.mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 9,
                        title: "Already Gone",
                        statusMessages: [],
                        trackedDownloadStatus: "warning",
                        trackedDownloadState: "importPending",
                    },
                ],
            },
        });
        mockLidarrClient.delete.mockRejectedValueOnce(
            new LidarrHttpError({
                status: 404,
                method: "DELETE",
                path: "/api/v1/queue/9",
                attempts: 2,
                isTransient: false,
                data: { message: "Not Found" },
                message: "Request failed with status code 404",
            }),
        );

        await expect(
            cleanStuckDownloads("http://lidarr:8686", "api-key"),
        ).resolves.toEqual({ removed: 1, items: ["Already Gone"] });
        expect(mockLidarrClient.delete).toHaveBeenCalledTimes(1);
    });

    it("logs non-404 cleanup failures and continues without counting removed items", async () => {
        mockLidarrClient.get.mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 77,
                        title: "Sticky item",
                        statusMessages: [
                            {
                                title: "msg",
                                messages: [
                                    "No files found are eligible for import",
                                ],
                            },
                        ],
                        trackedDownloadStatus: "warning",
                        trackedDownloadState: "importPending",
                    },
                ],
            },
        });
        mockLidarrClient.delete.mockRejectedValueOnce({
            response: { status: 500 },
            message: "delete failed",
        });

        await expect(
            cleanStuckDownloads("http://lidarr:8686", "api-key"),
        ).resolves.toEqual({ removed: 0, items: [] });
        expect(mockLidarrClient.delete).toHaveBeenCalledTimes(1);
    });

    it("bubbles queue cleanup fetch failures", async () => {
        mockLidarrClient.get.mockRejectedValueOnce(
            new Error("queue unavailable"),
        );

        await expect(
            cleanStuckDownloads("http://lidarr:8686", "api-key"),
        ).rejects.toThrow("queue unavailable");
    });

    it("returns empty queue/inactive status when Lidarr settings are absent", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            lidarrEnabled: false,
            lidarrUrl: null,
            lidarrApiKey: null,
        });
        expect(await getQueue()).toEqual([]);

        mockGetSystemSettings.mockResolvedValueOnce({
            lidarrEnabled: false,
            lidarrUrl: null,
            lidarrApiKey: null,
        });
        expect(await isDownloadActive("any")).toEqual({ active: false });
    });

    it("cleanStuckDownloads leaves non-stuck items untouched", async () => {
        mockLidarrClient.get.mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 77,
                        title: "Healthy item",
                        statusMessages: [
                            { title: "ok", messages: ["all good"] },
                        ],
                        trackedDownloadStatus: "ok",
                        trackedDownloadState: "downloading",
                    },
                ],
            },
        });

        const result = await cleanStuckDownloads(
            "http://lidarr:8686",
            "api-key",
        );
        expect(result).toEqual({ removed: 0, items: [] });
        expect(mockLidarrClient.delete).not.toHaveBeenCalled();
    });

    it("returns empty queue when queue fetch fails", async () => {
        mockLidarrClient.get.mockRejectedValueOnce(new Error("queue down"));
        await expect(getQueue()).resolves.toEqual([]);
    });

    it("returns inactive status when active-check fetch fails", async () => {
        mockLidarrClient.get.mockRejectedValueOnce(new Error("queue down"));
        await expect(isDownloadActive("dl-11")).resolves.toEqual({
            active: false,
        });
    });

    it("propagates recent-completed-download failures from Lidarr history", async () => {
        mockLidarrClient.get.mockRejectedValueOnce(new Error("history down"));

        await expect(
            getRecentCompletedDownloads("http://lidarr:8686", "api-key", 5),
        ).rejects.toThrow("history down");
    });
});

describe("lidarr exported queue/history helpers use the shared client seam", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr:8686",
            lidarrApiKey: "api-key",
        });
    });

    it("cleanStuckDownloads sends relative paths and operation parameters", async () => {
        mockLidarrClient.get.mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 5,
                        title: "Stuck Album",
                        statusMessages: [],
                        trackedDownloadStatus: "warning",
                        trackedDownloadState: "importFailed",
                    },
                ],
            },
        });
        mockLidarrClient.delete.mockResolvedValue({});

        const signal = new AbortController().signal;
        await cleanStuckDownloads("http://lidarr:8686", "api-key", signal);

        expect(mockLidarrHttpClient).toHaveBeenLastCalledWith(
            { baseUrl: "http://lidarr:8686", apiKey: "api-key" },
            { timeoutMs: 30_000 },
        );
        expect(mockLidarrClient.get).toHaveBeenCalledWith(
            "/api/v1/queue",
            expect.objectContaining({
                params: expect.any(Object),
                timeoutMs: 10_000,
                maxRetries: 0,
                signal,
            }),
        );
        expect(mockLidarrClient.delete).toHaveBeenCalledWith(
            "/api/v1/queue/5",
            {
                params: {
                    removeFromClient: true,
                    blocklist: true,
                    skipRedownload: false,
                },
                timeoutMs: 10_000,
                maxRetries: 0,
                signal,
            },
        );
    });

    it("getRecentCompletedDownloads uses the shared client", async () => {
        mockLidarrClient.get.mockResolvedValueOnce({ data: { records: [] } });

        await getRecentCompletedDownloads("http://lidarr:8686", "api-key", 5);

        expect(mockLidarrHttpClient).toHaveBeenLastCalledWith(
            { baseUrl: "http://lidarr:8686", apiKey: "api-key" },
            { timeoutMs: 30_000 },
        );
        expect(mockLidarrClient.get).toHaveBeenCalledWith(
            "/api/v1/history",
            expect.objectContaining({ params: expect.any(Object) }),
        );
    });

    it("getQueueCount uses the shared client", async () => {
        mockLidarrClient.get.mockResolvedValueOnce({
            data: { totalRecords: 0 },
        });

        await getQueueCount("http://lidarr:8686", "api-key");

        expect(mockLidarrHttpClient).toHaveBeenLastCalledWith(
            { baseUrl: "http://lidarr:8686", apiKey: "api-key" },
            { timeoutMs: 30_000 },
        );
        expect(mockLidarrClient.get).toHaveBeenCalledWith("/api/v1/queue", {
            params: { page: 1, pageSize: 1 },
        });
    });

    it("getQueue uses the shared client", async () => {
        mockLidarrClient.get.mockResolvedValueOnce({ data: { records: [] } });

        await getQueue();

        expect(mockLidarrHttpClient).toHaveBeenLastCalledWith(
            { baseUrl: "http://lidarr:8686", apiKey: "api-key" },
            { timeoutMs: 30_000 },
        );
        expect(mockLidarrClient.get).toHaveBeenCalledWith(
            "/api/v1/queue",
            expect.objectContaining({ params: expect.any(Object) }),
        );
    });

    it("isDownloadActive uses the shared client", async () => {
        mockLidarrClient.get.mockResolvedValueOnce({ data: { records: [] } });

        await isDownloadActive("dl-1");

        expect(mockLidarrHttpClient).toHaveBeenLastCalledWith(
            { baseUrl: "http://lidarr:8686", apiKey: "api-key" },
            { timeoutMs: 30_000 },
        );
        expect(mockLidarrClient.get).toHaveBeenCalledWith(
            "/api/v1/queue",
            expect.objectContaining({ params: expect.any(Object) }),
        );
    });
});
