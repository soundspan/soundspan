import {
    axios,
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
    mockAxiosCreate,
    mockAxiosGet,
    mockAxiosPost,
    mockAxiosDelete,
    mockGetSystemSettings,
    mockMusicBrainzSearchArtist,
    mockStripAlbumEdition,
    createClientMock,
    primeServiceWithClient,
} from "./lidarrService.helpers";

describe("lidarr service behavior", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetSystemSettings.mockResolvedValue(null);
        mockMusicBrainzSearchArtist.mockResolvedValue([]);
        mockStripAlbumEdition.mockImplementation((title: string) => title);
        mockedConfig.lidarr = undefined;
    });

    it("constructs AcquisitionError with typed metadata", () => {
        const original = new Error("boom");
        const err = new AcquisitionError(
            "album missing",
            AcquisitionErrorType.ALBUM_NOT_FOUND,
            false,
            original,
        );

        expect(err.name).toBe("AcquisitionError");
        expect(err.type).toBe(AcquisitionErrorType.ALBUM_NOT_FOUND);
        expect(err.isRecoverable).toBe(false);
        expect(err.originalError).toBe(original);
    });

    it("initializes from config when DB settings are disabled", async () => {
        const client = createClientMock();
        mockAxiosCreate.mockReturnValue(client);
        mockedConfig.lidarr = {
            enabled: true,
            url: "http://lidarr-config:8686",
            apiKey: "config-key",
        };
        mockGetSystemSettings.mockResolvedValueOnce(null);

        const svc = lidarrService as any;
        svc.initialized = false;
        svc.enabled = false;
        svc.client = null;

        await expect(lidarrService.isEnabled()).resolves.toBe(true);
    });

    it("initializes from system settings when enabled", async () => {
        const client = createClientMock();
        mockAxiosCreate.mockReturnValue(client);
        mockGetSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr:8686",
            lidarrApiKey: "api-key",
        });

        const svc = lidarrService as any;
        svc.initialized = false;
        svc.enabled = false;
        svc.client = null;

        await expect(lidarrService.isEnabled()).resolves.toBe(true);
        expect(mockAxiosCreate).toHaveBeenCalled();
    });

    it("returns disabled when settings are incomplete", async () => {
        mockGetSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr:8686",
            lidarrApiKey: null,
        });

        const svc = lidarrService as any;
        svc.initialized = false;
        svc.enabled = false;
        svc.client = null;

        await expect(lidarrService.isEnabled()).resolves.toBe(false);
    });

    it("keeps prior configuration state when settings lookup throws", async () => {
        const svc = lidarrService as any;
        svc.initialized = false;
        svc.enabled = false;
        svc.client = null;

        mockGetSystemSettings.mockRejectedValueOnce(
            new Error("settings db unavailable"),
        );

        await expect(lidarrService.isEnabled()).resolves.toBe(false);
    });

    it("searchArtist uses lookup and MusicBrainz fallback when MBID is provided", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({ data: [] });
        mockMusicBrainzSearchArtist.mockResolvedValueOnce([
            { id: "artist-mbid", name: "Fallback Artist", type: "Group" },
        ]);

        const results = await lidarrService.searchArtist(
            "Fallback Artist",
            "artist-mbid",
        );

        expect(client.get).toHaveBeenCalledWith("/api/v1/artist/lookup", {
            params: { term: "lidarr:artist-mbid" },
        });
        expect(results[0]).toEqual(
            expect.objectContaining({
                foreignArtistId: "artist-mbid",
                artistName: "Fallback Artist",
            }),
        );
    });

    it("searchArtist skips MusicBrainz fallback when MBID lookup returns data", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({
            data: [
                {
                    id: 31,
                    artistName: "Direct MBID Artist",
                    foreignArtistId: "artist-direct-mbid",
                },
            ],
        });

        const results = await lidarrService.searchArtist(
            "Direct MBID Artist",
            "artist-direct-mbid",
        );

        expect(results).toEqual([
            expect.objectContaining({
                foreignArtistId: "artist-direct-mbid",
                artistName: "Direct MBID Artist",
            }),
        ]);
        expect(mockMusicBrainzSearchArtist).not.toHaveBeenCalled();
    });

    it("searchArtist returns empty list when lookup misses and no MBID fallback exists", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({ data: [] });

        const results = await lidarrService.searchArtist("Unknown");
        expect(results).toEqual([]);
    });

    it("searchArtist falls back to MusicBrainz when Lidarr lookup throws", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockRejectedValueOnce(new Error("lookup failed"));
        mockMusicBrainzSearchArtist.mockResolvedValueOnce([
            {
                id: "artist-mbid-fallback",
                name: "Fallback Artist",
                type: "Group",
            },
        ]);

        const results = await lidarrService.searchArtist(
            "Fallback Artist",
            "artist-mbid-fallback",
        );

        expect(results).toEqual([
            expect.objectContaining({
                foreignArtistId: "artist-mbid-fallback",
                artistName: "Fallback Artist",
                artistType: "Group",
            }),
        ]);
    });

    it("searchArtist returns empty results when lookup and MusicBrainz fallback both fail", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockRejectedValueOnce(new Error("lookup failed"));
        mockMusicBrainzSearchArtist.mockRejectedValueOnce(new Error("mb fail"));

        await expect(
            lidarrService.searchArtist(
                "Fallback Artist",
                "artist-mbid-fallback",
            ),
        ).resolves.toEqual([]);
    });

    it("searchArtist throws when Lidarr is disabled", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(lidarrService.searchArtist("Artist")).rejects.toThrow(
            "Lidarr not enabled",
        );
    });

    it("searchAlbum returns direct Lidarr results without fallback", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({
            data: [
                {
                    id: 901,
                    title: "Album",
                    foreignAlbumId: "album-result",
                },
            ],
        });

        await expect(
            lidarrService.searchAlbum("Artist", "Album"),
        ).resolves.toEqual([
            expect.objectContaining({
                id: 901,
                title: "Album",
                foreignAlbumId: "album-result",
            }),
        ]);

        expect(client.get).toHaveBeenCalledTimes(1);
        expect(client.get).toHaveBeenCalledWith("/api/v1/album/lookup", {
            params: { term: "Artist Album" },
        });
    });

    it("searchAlbum returns empty list when lookup fails with response payload", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockRejectedValueOnce({
            response: { data: { error: "bad request" } },
            message: "lookup failed",
        });

        await expect(
            lidarrService.searchAlbum("Artist", "Album"),
        ).resolves.toEqual([]);
    });

    it("polls command status until terminal state and returns fallback message text", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockResolvedValueOnce({
                data: { status: "started", message: "" },
            })
            .mockResolvedValueOnce({
                data: { status: "completed", message: "finished successfully" },
            });

        await expect(
            (lidarrService as any).waitForCommand(12, 5000, 0),
        ).resolves.toEqual({
            status: "completed",
            message: "finished successfully",
        });

        client.get.mockReset();
        client.get.mockResolvedValueOnce({
            data: {
                status: "failed",
                body: { records: [{ message: "import failed" }] },
            },
        });
        await expect(
            (lidarrService as any).waitForCommand(13, 5000, 0),
        ).resolves.toEqual({
            status: "failed",
            message: "import failed",
        });
    });

    it("returns artist albums only when the target artist exists", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockResolvedValueOnce({
                data: [{ id: 51, foreignArtistId: "artist-mbid-1" }],
            })
            .mockResolvedValueOnce({
                data: [{ id: 81, title: "Album 81" }],
            });
        await expect(
            lidarrService.getArtistAlbums("artist-mbid-1"),
        ).resolves.toEqual([{ id: 81, title: "Album 81" }]);

        client.get.mockResolvedValueOnce({
            data: [{ id: 77, foreignArtistId: "other-mbid" }],
        });
        await expect(
            lidarrService.getArtistAlbums("missing-mbid"),
        ).resolves.toEqual([]);

        client.get.mockRejectedValueOnce(new Error("network"));
        await expect(
            lidarrService.getArtistAlbums("artist-mbid-1"),
        ).resolves.toEqual([]);
    });

    it("resolves root folders with fallback and safe defaults", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockResolvedValueOnce({
                data: [{ path: "/library" }],
            })
            .mockResolvedValueOnce({
                data: [],
            })
            .mockRejectedValueOnce(new Error("rootfolder down"));

        await expect(
            (lidarrService as any).ensureRootFolderExists("/missing"),
        ).resolves.toBe("/library");
        await expect(
            (lidarrService as any).ensureRootFolderExists("/missing"),
        ).resolves.toBe("/missing");
        await expect(
            (lidarrService as any).ensureRootFolderExists("/missing"),
        ).resolves.toBe("/missing");
    });

    it("returns requested root folder when it already exists", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({
            data: [{ path: "/music" }, { path: "/library" }],
        });

        await expect(
            (lidarrService as any).ensureRootFolderExists("/music"),
        ).resolves.toBe("/music");
        expect(client.get).toHaveBeenCalledWith("/api/v1/rootfolder");
    });

    it("addArtist uses a better non-group result when exact MBID match has zero albums", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const searchSpy = jest
            .spyOn(lidarrService as any, "searchArtist")
            .mockResolvedValue([
                {
                    id: 41,
                    artistName: "Artist",
                    foreignArtistId: "artist-mbid",
                    artistType: "Group",
                    monitored: false,
                    statistics: { albumCount: 0 },
                },
                {
                    id: 42,
                    artistName: "Artist",
                    foreignArtistId: "artist-mbid-better",
                    artistType: "Person",
                    monitored: false,
                    statistics: { albumCount: 4 },
                },
            ]);

        client.get
            .mockResolvedValueOnce({
                data: [{ path: "/library" }],
            })
            .mockResolvedValueOnce({
                data: [],
            });
        client.post.mockResolvedValueOnce({
            data: {
                id: 42,
                artistName: "Artist",
                foreignArtistId: "artist-mbid-better",
            },
        });

        await expect(
            lidarrService.addArtist(
                "artist-mbid",
                "Artist",
                "/missing",
                true,
                false,
                false,
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                foreignArtistId: "artist-mbid-better",
            }),
        );

        expect(client.post).toHaveBeenCalledWith(
            "/api/v1/artist",
            expect.objectContaining({
                foreignArtistId: "artist-mbid-better",
                rootFolderPath: "/library",
                monitorNewItems: "none",
            }),
        );
        searchSpy.mockRestore();
    });

    it("addArtist keeps exact Group MBID match when no better candidate exists", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const searchSpy = jest
            .spyOn(lidarrService as any, "searchArtist")
            .mockResolvedValue([
                {
                    id: 81,
                    artistName: "Group Match",
                    foreignArtistId: "artist-mbid-group",
                    artistType: "Group",
                    monitored: false,
                    statistics: { albumCount: 0 },
                },
                {
                    id: 82,
                    artistName: "Group Match",
                    foreignArtistId: "artist-alternate",
                    artistType: "Person",
                    monitored: false,
                    statistics: { albumCount: 0 },
                },
            ]);

        client.get
            .mockResolvedValueOnce({
                data: [{ path: "/music" }],
            })
            .mockResolvedValueOnce({
                data: [],
            });
        client.post.mockResolvedValueOnce({
            data: {
                id: 81,
                artistName: "Group Match",
                foreignArtistId: "artist-mbid-group",
            },
        });

        await expect(
            lidarrService.addArtist(
                "artist-mbid-group",
                "Group Match",
                "/music",
                false,
                false,
                false,
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                foreignArtistId: "artist-mbid-group",
            }),
        );

        searchSpy.mockRestore();
    });

    it("addArtist scores Artist-typed results during name-only lookup", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const searchSpy = jest
            .spyOn(lidarrService as any, "searchArtist")
            .mockResolvedValue([
                {
                    id: 10,
                    artistName: "Artist-Name-Only",
                    foreignArtistId: "artist-only",
                    artistType: "artist",
                    monitored: false,
                    ratings: { votes: 10 },
                    statistics: { albumCount: 1 },
                },
            ]);

        client.get
            .mockResolvedValueOnce({
                data: [{ path: "/music" }],
            })
            .mockResolvedValueOnce({
                data: [],
            });
        client.post.mockResolvedValueOnce({
            data: {
                id: 10,
                artistName: "Artist-Name-Only",
                foreignArtistId: "artist-only",
            },
        });

        await expect(
            lidarrService.addArtist(
                "",
                "Artist-Name-Only",
                "/music",
                false,
                false,
                false,
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                foreignArtistId: "artist-only",
            }),
        );

        searchSpy.mockRestore();
    });

    it("addArtist throws when Lidarr is disabled", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(
            lidarrService.addArtist("artist-disabled", "Disabled Artist"),
        ).rejects.toThrow("Lidarr not enabled");
    });

    it("addArtist adds missing artist without searching for all tracks when requested", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const searchSpy = jest
            .spyOn(lidarrService as any, "searchArtist")
            .mockResolvedValue([
                {
                    id: 77,
                    artistName: "Discovery Artist",
                    foreignArtistId: "artist-discovery-add",
                    artistType: "Person",
                    monitored: false,
                    statistics: { albumCount: 5 },
                },
            ]);
        const discoverySpy = jest
            .spyOn(lidarrService as any, "getOrCreateDiscoveryTag")
            .mockResolvedValue(77);
        const setTimeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation((callback: (...args: any[]) => void) => {
                callback();
                return 0 as any;
            });

        client.get
            .mockResolvedValueOnce({
                data: [{ path: "/music" }],
            })
            .mockResolvedValueOnce({
                data: [],
            });
        client.post.mockResolvedValue({
            data: {
                id: 77,
                artistName: "Discovery Artist",
                foreignArtistId: "artist-discovery-add",
            },
        });

        await expect(
            lidarrService.addArtist(
                "artist-discovery-add",
                "Discovery Artist",
                "/music",
                false,
                false,
                true,
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                id: 77,
                foreignArtistId: "artist-discovery-add",
            }),
        );

        expect(discoverySpy).toHaveBeenCalled();
        expect(client.post).toHaveBeenCalledWith(
            "/api/v1/artist",
            expect.objectContaining({
                tags: [77],
                monitorNewItems: "none",
            }),
        );
        expect(client.post).toHaveBeenCalledWith(
            "/api/v1/command",
            expect.objectContaining({
                name: "RefreshArtist",
                artistId: 77,
            }),
        );

        searchSpy.mockRestore();
        discoverySpy.mockRestore();
        setTimeoutSpy.mockRestore();
    });

    it("addArtist returns null when strict MBID match is not found", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const searchSpy = jest
            .spyOn(lidarrService as any, "searchArtist")
            .mockResolvedValue([
                {
                    id: 5,
                    artistName: "Different Artist",
                    foreignArtistId: "other-mbid",
                    artistType: "Person",
                    monitored: false,
                    statistics: { albumCount: 2 },
                },
            ]);

        client.get.mockResolvedValueOnce({
            data: [{ path: "/music" }],
        });

        await expect(
            lidarrService.addArtist(
                "target-mbid",
                "Wanted Artist",
                "/music",
                true,
                false,
                false,
            ),
        ).resolves.toBeNull();

        expect(client.post).not.toHaveBeenCalled();
        searchSpy.mockRestore();
    });

    it("addArtist updates and searches existing artists when monitorAllAlbums is requested", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const searchSpy = jest
            .spyOn(lidarrService as any, "searchArtist")
            .mockResolvedValue([
                {
                    id: 12,
                    artistName: "Artist",
                    foreignArtistId: "artist-mbid",
                    artistType: "Person",
                    monitored: false,
                    tags: [1],
                    statistics: { albumCount: 3 },
                },
            ]);
        const tagSpy = jest
            .spyOn(lidarrService as any, "getOrCreateDiscoveryTag")
            .mockResolvedValue(99);
        const addTagsSpy = jest
            .spyOn(lidarrService as any, "addTagsToArtist")
            .mockResolvedValue(true);

        client.get
            .mockResolvedValueOnce({
                data: [{ path: "/music" }],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 12,
                        artistName: "Artist",
                        foreignArtistId: "artist-mbid",
                        monitored: false,
                        tags: [1],
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [
                    { id: 301, monitored: false },
                    { id: 302, monitored: true },
                ],
            });
        client.put
            .mockResolvedValueOnce({
                data: { id: 12, artistName: "Artist", monitored: true },
            })
            .mockResolvedValueOnce({ data: {} });
        client.post.mockResolvedValueOnce({ data: { id: 777 } });

        await expect(
            lidarrService.addArtist(
                "artist-mbid",
                "Artist",
                "/music",
                true,
                true,
                true,
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                id: 12,
                monitored: true,
            }),
        );

        expect(addTagsSpy).toHaveBeenCalledWith(12, [99]);
        expect(client.put).toHaveBeenCalledWith(
            "/api/v1/artist/12",
            expect.objectContaining({
                monitored: true,
                monitorNewItems: "all",
            }),
        );
        expect(client.put).toHaveBeenCalledWith(
            "/api/v1/album/301",
            expect.objectContaining({
                id: 301,
                monitored: true,
            }),
        );
        expect(client.post).toHaveBeenCalledWith("/api/v1/command", {
            name: "AlbumSearch",
            albumIds: [301, 302],
        });

        searchSpy.mockRestore();
        tagSpy.mockRestore();
        addTagsSpy.mockRestore();
    });

    it("addArtist returns existing artist when create hits race-condition duplicate", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const searchSpy = jest
            .spyOn(lidarrService as any, "searchArtist")
            .mockResolvedValue([
                {
                    id: 22,
                    artistName: "Artist",
                    foreignArtistId: "artist-mbid-race",
                    artistType: "Person",
                    monitored: false,
                    statistics: { albumCount: 3 },
                },
            ]);

        client.get
            .mockResolvedValueOnce({
                data: [{ path: "/music" }],
            })
            .mockResolvedValueOnce({
                data: [],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 22,
                        artistName: "Artist",
                        foreignArtistId: "artist-mbid-race",
                        monitored: true,
                    },
                ],
            });
        client.post.mockRejectedValueOnce({
            response: {
                data: [{ errorMessage: "artist already exists" }],
            },
            message: "artist already exists",
        });

        await expect(
            lidarrService.addArtist(
                "artist-mbid-race",
                "Artist",
                "/music",
                true,
                false,
                false,
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                id: 22,
                foreignArtistId: "artist-mbid-race",
            }),
        );

        searchSpy.mockRestore();
    });

    it("addArtist returns null when Lidarr has no matching artist data", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockResolvedValueOnce({
                data: [{ path: "/music" }],
            })
            .mockResolvedValueOnce({
                data: [],
            });

        await expect(
            lidarrService.addArtist("artist-missing", "Missing Artist"),
        ).resolves.toBeNull();
    });

    it("returns an existing artist when monitorAllAlbums is false", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const searchSpy = jest
            .spyOn(lidarrService as any, "searchArtist")
            .mockResolvedValue([
                {
                    id: 88,
                    artistName: "Artist",
                    foreignArtistId: "artist-existing",
                    artistType: "Person",
                    monitored: false,
                    statistics: { albumCount: 4 },
                },
            ]);

        client.get
            .mockResolvedValueOnce({
                data: [{ path: "/music" }],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 88,
                        artistName: "Artist",
                        foreignArtistId: "artist-existing",
                        monitored: true,
                        tags: [4, 7],
                    },
                ],
            });

        await expect(
            lidarrService.addArtist(
                "artist-existing",
                "Artist",
                "/music",
                true,
                false,
                false,
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                id: 88,
                foreignArtistId: "artist-existing",
            }),
        );

        expect(client.put).not.toHaveBeenCalled();
        expect(client.post).not.toHaveBeenCalled();
        searchSpy.mockRestore();
    });

    it("applies discovery tags to an already-added artist when requested", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const searchSpy = jest
            .spyOn(lidarrService as any, "searchArtist")
            .mockResolvedValue([
                {
                    id: 89,
                    artistName: "Discovery Artist",
                    foreignArtistId: "artist-discovery",
                    artistType: "Person",
                    monitored: false,
                    statistics: { albumCount: 4 },
                },
            ]);
        const tagSpy = jest
            .spyOn(lidarrService as any, "getOrCreateDiscoveryTag")
            .mockResolvedValue(101);
        const addTagsSpy = jest
            .spyOn(lidarrService as any, "addTagsToArtist")
            .mockResolvedValue(true);

        client.get
            .mockResolvedValueOnce({
                data: [{ path: "/music" }],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 89,
                        artistName: "Discovery Artist",
                        foreignArtistId: "artist-discovery",
                        monitored: false,
                        tags: [7],
                    },
                ],
            });

        await expect(
            lidarrService.addArtist(
                "artist-discovery",
                "Discovery Artist",
                "/music",
                true,
                false,
                true,
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                id: 89,
                foreignArtistId: "artist-discovery",
            }),
        );

        expect(tagSpy).toHaveBeenCalled();
        expect(addTagsSpy).toHaveBeenCalledWith(89, [101]);
        searchSpy.mockRestore();
        tagSpy.mockRestore();
        addTagsSpy.mockRestore();
    });

    it("returns null when adding artist fails for non-duplicate reason", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const searchSpy = jest
            .spyOn(lidarrService as any, "searchArtist")
            .mockResolvedValue([
                {
                    id: 90,
                    artistName: "Artist",
                    foreignArtistId: "artist-failing",
                    artistType: "Person",
                    monitored: false,
                    statistics: { albumCount: 1 },
                },
            ]);

        client.get
            .mockResolvedValueOnce({
                data: [{ path: "/music" }],
            })
            .mockResolvedValueOnce({ data: [] });
        client.post.mockRejectedValueOnce(new Error("service unavailable"));

        await expect(
            lidarrService.addArtist(
                "artist-failing",
                "Artist",
                "/music",
                true,
                false,
                false,
            ),
        ).resolves.toBeNull();

        searchSpy.mockRestore();
    });

    it("addArtist scores name-only matches and selects the strongest candidate", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const searchSpy = jest
            .spyOn(lidarrService as any, "searchArtist")
            .mockResolvedValue([
                {
                    id: 61,
                    artistName: "Various Artists",
                    foreignArtistId: "va-1",
                    artistType: "Group",
                    monitored: false,
                    statistics: { albumCount: 30 },
                },
                {
                    id: 62,
                    artistName: "Alpha Artist",
                    foreignArtistId: "alpha-artist",
                    artistType: "Person",
                    monitored: false,
                    statistics: { albumCount: 3 },
                    ratings: { votes: 500, value: 4.8 },
                },
                {
                    id: 63,
                    artistName: "Alpha Artist Live Archive",
                    foreignArtistId: "alpha-archive",
                    artistType: "Group",
                    monitored: false,
                    statistics: { albumCount: 1 },
                },
            ]);

        client.get
            .mockResolvedValueOnce({
                data: [{ path: "/music" }],
            })
            .mockResolvedValueOnce({
                data: [],
            });
        client.post.mockResolvedValueOnce({
            data: {
                id: 62,
                artistName: "Alpha Artist",
                foreignArtistId: "alpha-artist",
            },
        });

        await expect(
            lidarrService.addArtist(
                "",
                "Alpha Artist",
                "/music",
                true,
                false,
                false,
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                foreignArtistId: "alpha-artist",
            }),
        );

        expect(client.post).toHaveBeenCalledWith(
            "/api/v1/artist",
            expect.objectContaining({
                foreignArtistId: "alpha-artist",
            }),
        );
        searchSpy.mockRestore();
    });

    it("reads and creates discovery tags with cache semantics", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockResolvedValueOnce({
            data: [
                { id: 7, label: "soundspan-discovery" },
                { id: 8, label: "other" },
            ],
        });

        const first = await lidarrService.getOrCreateDiscoveryTag();
        const second = await lidarrService.getOrCreateDiscoveryTag();

        expect(first).toBe(7);
        expect(second).toBe(7);
        expect(client.get).toHaveBeenCalledTimes(1);
    });

    it("creates discovery tag when missing", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({ data: [] });
        client.post.mockResolvedValueOnce({
            data: { id: 99, label: "soundspan-discovery" },
        });

        const tag = await lidarrService.getOrCreateDiscoveryTag();
        expect(tag).toBe(99);
        expect(client.post).toHaveBeenCalledWith("/api/v1/tag", {
            label: "soundspan-discovery",
        });
    });

    it("returns safe defaults when tag endpoints fail", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockRejectedValueOnce(new Error("tag lookup failed"));
        client.post.mockRejectedValueOnce(new Error("tag create failed"));

        await expect(lidarrService.getTags()).resolves.toEqual([]);
        await expect(lidarrService.createTag("new-tag")).resolves.toBeNull();

        expect(client.get).toHaveBeenCalledWith("/api/v1/tag");
        expect(client.post).toHaveBeenCalledWith("/api/v1/tag", {
            label: "new-tag",
        });
    });

    it("retries discovery tag lookup after create failures and only caches successful IDs", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({
            data: [{ id: 101, label: "soundspan-discovery" }],
        });
        client.post.mockRejectedValueOnce(new Error("tag create conflict"));

        await expect(
            lidarrService.getOrCreateDiscoveryTag(),
        ).resolves.toBeNull();
        await expect(lidarrService.getOrCreateDiscoveryTag()).resolves.toBe(
            101,
        );
        await expect(lidarrService.getOrCreateDiscoveryTag()).resolves.toBe(
            101,
        );

        expect(client.get).toHaveBeenCalledTimes(2);
        expect(client.post).toHaveBeenCalledTimes(1);
        expect(client.post).toHaveBeenCalledWith("/api/v1/tag", {
            label: "soundspan-discovery",
        });
    });

    it("adds and removes artist tags by updating merged tag lists", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockResolvedValueOnce({
                data: { id: 11, artistName: "Artist A", tags: [1, 2] },
            })
            .mockResolvedValueOnce({
                data: { id: 11, artistName: "Artist A", tags: [1, 2, 3] },
            });
        client.put.mockResolvedValue({});

        await expect(lidarrService.addTagsToArtist(11, [2, 3])).resolves.toBe(
            true,
        );
        await expect(
            lidarrService.removeTagsFromArtist(11, [1, 3]),
        ).resolves.toBe(true);

        expect(client.put).toHaveBeenCalledWith("/api/v1/artist/11", {
            id: 11,
            artistName: "Artist A",
            tags: [1, 2, 3],
        });
        expect(client.put).toHaveBeenCalledWith("/api/v1/artist/11", {
            id: 11,
            artistName: "Artist A",
            tags: [2],
        });
    });

    it("returns false when addTagsToArtist cannot persist merged tags", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockResolvedValueOnce({
            data: {
                id: 21,
                artistName: "Artist B",
                monitored: true,
                tags: [4, 7],
            },
        });
        client.put.mockRejectedValueOnce(new Error("tag update failed"));

        await expect(lidarrService.addTagsToArtist(21, [7, 9])).resolves.toBe(
            false,
        );
        expect(client.put).toHaveBeenCalledWith("/api/v1/artist/21", {
            id: 21,
            artistName: "Artist B",
            monitored: true,
            tags: [4, 7, 9],
        });
    });

    it("returns false when removeTagsFromArtist update fails after filtering tags", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockResolvedValueOnce({
            data: { id: 22, artistName: "Artist C", tags: [3, 5, 8] },
        });
        client.put.mockRejectedValueOnce(new Error("remove failed"));

        await expect(
            lidarrService.removeTagsFromArtist(22, [5, 99]),
        ).resolves.toBe(false);
        expect(client.put).toHaveBeenCalledWith("/api/v1/artist/22", {
            id: 22,
            artistName: "Artist C",
            tags: [3, 8],
        });
    });

    it("removes discovery tag by MBID when artist is found", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        (lidarrService as any).discoveryTagId = 5;

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 12,
                        foreignArtistId: "artist-1",
                        artistName: "Artist",
                        tags: [5, 9],
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: { id: 12, artistName: "Artist", tags: [5, 9] },
            });
        client.put.mockResolvedValue({});

        await expect(
            lidarrService.removeDiscoveryTagByMbid("artist-1"),
        ).resolves.toBe(true);
        expect(client.put).toHaveBeenCalledWith("/api/v1/artist/12", {
            id: 12,
            artistName: "Artist",
            tags: [9],
        });
    });

    it("maps release search, grab, and blocklist flows", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        guid: "r1",
                        indexerId: 1,
                        title: "A",
                        approved: false,
                        seeders: 2,
                        protocol: "torrent",
                        rejected: false,
                    },
                    {
                        guid: "r2",
                        indexerId: 2,
                        title: "B",
                        approved: true,
                        seeders: 1,
                        protocol: "torrent",
                        rejected: false,
                    },
                    {
                        guid: "r3",
                        indexerId: 3,
                        title: "C",
                        approved: true,
                        seeders: 9,
                        protocol: "torrent",
                        rejected: false,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: {
                    records: [
                        { id: 44, downloadId: "dl-1", title: "Queued Album" },
                    ],
                },
            });
        client.post.mockResolvedValue({});
        client.delete.mockResolvedValue({});

        const releases = await lidarrService.getAlbumReleases(77);
        expect(releases[0].guid).toBe("r3");
        expect(releases[1].guid).toBe("r2");

        await expect(
            lidarrService.grabRelease(releases[0] as any),
        ).resolves.toBe(true);
        await expect(lidarrService.blocklistAndRemove("dl-1")).resolves.toBe(
            true,
        );
        expect(client.delete).toHaveBeenCalledWith("/api/v1/queue/44", {
            params: {
                removeFromClient: true,
                blocklist: true,
                skipRedownload: true,
            },
        });
    });

    it("returns null when release search cannot find any download even after anyReleaseOk retry", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        (lidarrService as any)._indexerCountLogged = true;

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 301,
                        artistName: "Artist",
                        foreignArtistId: "artist-mbid",
                        monitored: true,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 401,
                        title: "Album",
                        foreignAlbumId: "album-rg-mbid",
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: {
                    id: 401,
                    title: "Album",
                    foreignAlbumId: "album-rg-mbid",
                    monitored: false,
                    anyReleaseOk: false,
                    releases: [{ id: 1 }],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    id: 401,
                    title: "Album",
                    foreignAlbumId: "album-rg-mbid",
                    monitored: true,
                    anyReleaseOk: false,
                    releases: [{ id: 1 }],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    id: 401,
                    title: "Album",
                    foreignAlbumId: "album-rg-mbid",
                    monitored: true,
                    anyReleaseOk: false,
                    releases: [{ id: 1 }],
                },
            });

        client.put.mockResolvedValue({ data: {} });
        client.post
            .mockResolvedValueOnce({ data: { id: 9001 } })
            .mockResolvedValueOnce({ data: { id: 9002 } });

        const waitSpy = jest.spyOn(lidarrService as any, "waitForCommand");
        waitSpy
            .mockResolvedValueOnce({
                status: "completed",
                message: "Search completed with 0 reports",
            })
            .mockResolvedValueOnce({
                status: "completed",
                message: "Retry completed with 0 reports",
            });

        await expect(
            lidarrService.addAlbum(
                "album-rg-mbid",
                "Artist",
                "Album",
                "/music",
                "artist-mbid",
            ),
        ).rejects.toMatchObject({
            type: AcquisitionErrorType.NO_RELEASES_AVAILABLE,
            isRecoverable: true,
        });

        expect(client.put).toHaveBeenCalledWith("/api/v1/album/401", {
            id: 401,
            title: "Album",
            foreignAlbumId: "album-rg-mbid",
            monitored: true,
            anyReleaseOk: false,
            releases: [{ id: 1 }],
        });
        expect(client.put).toHaveBeenCalledWith("/api/v1/album/401", {
            id: 401,
            title: "Album",
            foreignAlbumId: "album-rg-mbid",
            monitored: true,
            anyReleaseOk: true,
            releases: [{ id: 1 }],
        });
        expect(waitSpy).toHaveBeenCalledTimes(2);
        waitSpy.mockRestore();
    });

    it("falls back to base album and returns it when base search command times out", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        (lidarrService as any)._indexerCountLogged = true;
        mockStripAlbumEdition.mockReturnValueOnce("Album");

        const primaryAlbum = {
            id: 501,
            title: "Album Studio Session",
            foreignAlbumId: "album-rg-mbid",
        };
        const baseAlbum = {
            id: 502,
            title: "Album",
            foreignAlbumId: "album-rg-base",
        };

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 301,
                        artistName: "Artist",
                        foreignArtistId: "artist-mbid",
                        monitored: true,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [primaryAlbum, baseAlbum],
            })
            .mockResolvedValueOnce({
                data: {
                    ...primaryAlbum,
                    monitored: false,
                    anyReleaseOk: false,
                    releases: [{ id: 1 }],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    ...primaryAlbum,
                    monitored: true,
                    anyReleaseOk: false,
                    releases: [{ id: 1 }],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    ...primaryAlbum,
                    monitored: true,
                    anyReleaseOk: false,
                    releases: [{ id: 1 }],
                },
            });

        client.put.mockResolvedValue({ data: {} });
        client.post
            .mockResolvedValueOnce({ data: { id: 9101 } })
            .mockResolvedValueOnce({ data: { id: 9102 } })
            .mockResolvedValueOnce({ data: { id: 9103 } });

        const waitSpy = jest.spyOn(lidarrService as any, "waitForCommand");
        waitSpy
            .mockResolvedValueOnce({
                status: "completed",
                message: "Search completed with 0 reports",
            })
            .mockResolvedValueOnce({
                status: "completed",
                message: "Retry completed with 0 reports",
            })
            .mockRejectedValueOnce(
                new Error("Command 9103 timed out after 30000ms"),
            );

        await expect(
            lidarrService.addAlbum(
                "album-rg-mbid",
                "Artist",
                "Album Studio Session",
                "/music",
                "artist-mbid",
            ),
        ).resolves.toEqual(baseAlbum);

        expect(client.put).toHaveBeenCalledWith("/api/v1/album/502", {
            ...baseAlbum,
            monitored: true,
            anyReleaseOk: true,
        });
        expect(waitSpy).toHaveBeenCalledTimes(3);
        waitSpy.mockRestore();
    });

    it("addAlbum returns null when no MBID is available for a new artist", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({ data: [] });

        await expect(
            lidarrService.addAlbum(
                "album-mbid",
                "Unknown Artist",
                "Unknown Album",
            ),
        ).resolves.toBeNull();
    });

    it("addAlbum returns null when creating a missing artist fails", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        const addArtistSpy = jest
            .spyOn(lidarrService as any, "addArtist")
            .mockResolvedValue(null);

        client.get.mockResolvedValueOnce({
            data: [],
        });

        await expect(
            lidarrService.addAlbum(
                "album-mbid",
                "Unknown Artist",
                "Unknown Album",
                "/music",
                "artist-missing",
            ),
        ).resolves.toBeNull();

        expect(addArtistSpy).toHaveBeenCalledWith(
            "artist-missing",
            "Unknown Artist",
            "/music",
            false,
            false,
            false,
        );
        addArtistSpy.mockRestore();
    });

    it("addAlbum returns null when catalog has no matching album", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 501,
                        artistName: "Artist",
                        foreignArtistId: "artist-mbid",
                        monitored: true,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 602,
                        title: "Completely Different Album",
                        foreignAlbumId: "other-mbid",
                        monitored: true,
                        anyReleaseOk: false,
                        releases: [{ id: 22 }],
                    },
                ],
            });

        await expect(
            lidarrService.addAlbum(
                "album-mbid",
                "Artist",
                "Album",
                "/music",
                "artist-mbid",
            ),
        ).resolves.toBeNull();
    });

    it("addAlbum matches accent, punctuation, and edition variants", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        mockStripAlbumEdition.mockImplementation((title: string) =>
            title.replace(/\s*\(Deluxe Edition\)\s*$/i, ""),
        );
        const album = {
            id: 903,
            title: "Beyonce - Renaissance",
            foreignAlbumId: "catalog-mbid",
            artistId: 57,
        };
        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 57,
                        artistName: "Beyoncé",
                        foreignArtistId: "artist-mbid",
                        monitored: true,
                    },
                ],
            })
            .mockResolvedValueOnce({ data: [album] })
            .mockResolvedValueOnce({
                data: {
                    ...album,
                    monitored: false,
                    anyReleaseOk: false,
                    releases: [{ id: 1 }],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    ...album,
                    monitored: true,
                    anyReleaseOk: false,
                    releases: [{ id: 1 }],
                },
            });
        client.put.mockResolvedValue({ data: { ...album, monitored: true } });
        client.post.mockResolvedValue({ data: { id: 9102 } });
        const waitSpy = jest
            .spyOn(lidarrService as any, "waitForCommand")
            .mockResolvedValue({
                status: "completed",
                message: "Search completed with 1 report",
            });

        await expect(
            lidarrService.addAlbum(
                "requested-mbid",
                "Beyoncé",
                "Beyoncé – Renaissance (Deluxe Edition)",
                "/music",
                "artist-mbid",
            ),
        ).resolves.toEqual(expect.objectContaining({ id: 903 }));

        waitSpy.mockRestore();
    });

    it("adds existing unmonitored artist and enables monitoring before album search", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        const waitSpy = jest
            .spyOn(lidarrService as any, "waitForCommand")
            .mockResolvedValue({
                status: "completed",
                message: "Search completed with 1 report",
            });

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 55,
                        artistName: "Dormant Artist",
                        foreignArtistId: "artist-existing-unmonitored",
                        monitored: false,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 901,
                        title: "Dormant Album",
                        foreignAlbumId: "album-mbid",
                        artistId: 55,
                        monitored: true,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: {
                    id: 901,
                    title: "Dormant Album",
                    foreignAlbumId: "album-mbid",
                    monitored: false,
                    releases: [{ id: 10 }],
                    anyReleaseOk: false,
                },
            })
            .mockResolvedValueOnce({
                data: {
                    id: 901,
                    title: "Dormant Album",
                    foreignAlbumId: "album-mbid",
                    monitored: true,
                    releases: [{ id: 10 }],
                    anyReleaseOk: false,
                },
            });

        client.put
            .mockResolvedValueOnce({
                data: {
                    id: 55,
                    artistName: "Dormant Artist",
                    foreignArtistId: "artist-existing-unmonitored",
                    monitored: true,
                    tags: [],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    id: 901,
                    title: "Dormant Album",
                    foreignAlbumId: "album-mbid",
                    monitored: true,
                },
            });
        client.post.mockResolvedValue({ data: { id: 7001 } });

        await expect(
            lidarrService.addAlbum(
                "album-mbid",
                "Dormant Artist",
                "Dormant Album",
                "/music",
                "artist-existing-unmonitored",
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                id: 901,
                foreignAlbumId: "album-mbid",
                monitored: true,
            }),
        );

        expect(client.put).toHaveBeenCalledWith(
            "/api/v1/artist/55",
            expect.objectContaining({
                id: 55,
                artistName: "Dormant Artist",
                foreignArtistId: "artist-existing-unmonitored",
                monitored: true,
            }),
        );
        expect(waitSpy).toHaveBeenCalledWith(7001, 30000);
        waitSpy.mockRestore();
    });

    it("returns null when existing artist metadata refresh fails but catalog remains empty", async () => {
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
                        id: 99,
                        artistName: "Artist",
                        foreignArtistId: "artist-refresh-fail",
                        monitored: true,
                    },
                ],
            })
            .mockResolvedValueOnce({ data: [] })
            .mockResolvedValueOnce({ data: [] });
        client.post.mockRejectedValueOnce(new Error("refresh failed"));

        await expect(
            lidarrService.addAlbum(
                "album-refresh-fail",
                "Artist",
                "Uncataloged Album",
                "/music",
                "artist-refresh-fail",
            ),
        ).resolves.toBeNull();

        expect(client.post).toHaveBeenCalledWith("/api/v1/command", {
            name: "RefreshArtist",
            artistId: 99,
        });

        setTimeoutSpy.mockRestore();
    });

    it("addAlbum applies discovery tag to existing artist before album search", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const addTagsSpy = jest
            .spyOn(lidarrService as any, "addTagsToArtist")
            .mockResolvedValue(true);
        const discoverySpy = jest
            .spyOn(lidarrService as any, "getOrCreateDiscoveryTag")
            .mockResolvedValue(88);
        const waitSpy = jest
            .spyOn(lidarrService as any, "waitForCommand")
            .mockResolvedValue({
                status: "completed",
                message: "Search completed with 1 report",
            });

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 99,
                        artistName: "Disc Artist",
                        foreignArtistId: "artist-disc",
                        tags: [1],
                        monitored: true,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 901,
                        title: "Disc Album",
                        foreignAlbumId: "album-mbid",
                        artistId: 99,
                        monitored: true,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: {
                    id: 901,
                    title: "Disc Album",
                    foreignAlbumId: "album-mbid",
                    monitored: true,
                    releases: [{ id: 1 }],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    id: 901,
                    title: "Disc Album",
                    foreignAlbumId: "album-mbid",
                    monitored: true,
                    anyReleaseOk: false,
                    releases: [{ id: 1 }],
                },
            });
        client.put.mockResolvedValue({ data: { id: 901, monitored: true } });
        client.post.mockResolvedValue({ data: { id: 9901 } });

        await expect(
            lidarrService.addAlbum(
                "album-mbid",
                "Disc Artist",
                "Disc Album",
                "/music",
                "artist-disc",
                true,
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                id: 901,
                foreignAlbumId: "album-mbid",
            }),
        );

        expect(discoverySpy).toHaveBeenCalled();
        expect(addTagsSpy).toHaveBeenCalledWith(99, [88]);
        expect(waitSpy).toHaveBeenCalledWith(9901, 30000);

        addTagsSpy.mockRestore();
        discoverySpy.mockRestore();
        waitSpy.mockRestore();
    });

    it("addAlbum throws when Lidarr is disabled", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(
            lidarrService.addAlbum("album-mbid", "Artist", "Album"),
        ).rejects.toThrow("Lidarr not enabled");
    });

    it("addAlbum throws NO_RELEASES_AVAILABLE when there are no enabled Lidarr indexers", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        const setTimeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation((callback: (...args: any[]) => void) => {
                callback();
                return 0 as any;
            });

        const waitSpy = jest
            .spyOn(lidarrService as any, "waitForCommand")
            .mockResolvedValueOnce({
                status: "completed",
                message: "Search completed with 0 reports",
            })
            .mockResolvedValueOnce({
                status: "completed",
                message: "Retry completed with 0 reports",
            });

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 11,
                        artistName: "Artist",
                        foreignArtistId: "artist-no-indexers",
                        monitored: true,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 901,
                        title: "Album Deluxe (Remaster)",
                        foreignAlbumId: "album-no-indexers",
                        artistId: 11,
                        monitored: true,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: {
                    id: 901,
                    title: "Album Deluxe (Remaster)",
                    foreignAlbumId: "album-no-indexers",
                    artistId: 11,
                    monitored: true,
                    anyReleaseOk: false,
                    releases: [],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    id: 901,
                    title: "Album Deluxe (Remaster)",
                    foreignAlbumId: "album-no-indexers",
                    artistId: 11,
                    monitored: true,
                    anyReleaseOk: false,
                    releases: [],
                },
            })
            .mockResolvedValueOnce({ data: [] });

        client.put.mockResolvedValue({
            data: {
                id: 901,
                title: "Album Deluxe (Remaster)",
                foreignAlbumId: "album-no-indexers",
                artistId: 11,
                monitored: true,
                anyReleaseOk: true,
            },
        });

        client.post
            .mockResolvedValueOnce({ data: { id: 9101 } })
            .mockResolvedValueOnce({ data: { id: 9201 } });

        try {
            await expect(
                lidarrService.addAlbum(
                    "album-no-indexers",
                    "Artist",
                    "Album Deluxe (Remaster)",
                    "/music",
                    "artist-no-indexers",
                ),
            ).rejects.toThrow(
                "No releases available - indexers found no matching downloads",
            );

            expect(waitSpy).toHaveBeenCalled();
            expect(waitSpy.mock.calls[0]?.[1]).toBe(30000);
            expect(client.put).toHaveBeenCalledWith(
                "/api/v1/album/901",
                expect.objectContaining({ anyReleaseOk: true }),
            );
        } finally {
            setTimeoutSpy.mockRestore();
            waitSpy.mockRestore();
            mockStripAlbumEdition.mockReset();
        }
    });

    it("addAlbum returns the album when search command times out", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const waitSpy = jest
            .spyOn(lidarrService as any, "waitForCommand")
            .mockRejectedValueOnce(new Error("Command 9301 timed out"));

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 12,
                        artistName: "Timeout Artist",
                        foreignArtistId: "artist-timeout",
                        monitored: true,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 902,
                        title: "Timeout Album",
                        foreignAlbumId: "album-timeout",
                        artistId: 12,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: {
                    id: 902,
                    title: "Timeout Album",
                    foreignAlbumId: "album-timeout",
                    artistId: 12,
                    anyReleaseOk: false,
                    releases: [{ id: 11 }],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    id: 902,
                    title: "Timeout Album",
                    foreignAlbumId: "album-timeout",
                    artistId: 12,
                    anyReleaseOk: false,
                    monitored: true,
                    releases: [{ id: 11 }],
                },
            });

        client.put.mockResolvedValue({
            data: {
                id: 902,
                title: "Timeout Album",
                foreignAlbumId: "album-timeout",
                artistId: 12,
                monitored: true,
            },
        });
        client.post.mockResolvedValue({ data: { id: 9301 } });

        try {
            await expect(
                lidarrService.addAlbum(
                    "album-timeout",
                    "Timeout Artist",
                    "Timeout Album",
                    "/music",
                    "artist-timeout",
                ),
            ).resolves.toMatchObject({
                id: 902,
                foreignAlbumId: "album-timeout",
            });

            expect(waitSpy).toHaveBeenCalledWith(9301, 30000);
        } finally {
            waitSpy.mockRestore();
        }
    });

    it("returns true when blocklist target is already absent from queue", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({ data: { records: [] } });

        await expect(
            lidarrService.blocklistAndRemove("missing-download"),
        ).resolves.toBe(true);
        expect(client.delete).not.toHaveBeenCalled();
    });

    it("logs a critical error when album monitoring does not persist after PUT", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        (lidarrService as any)._indexerCountLogged = true;

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 101,
                        artistName: "Monitored Artist",
                        foreignArtistId: "artist-mbid",
                        monitored: true,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 401,
                        title: "Unstable Album",
                        foreignAlbumId: "album-mbid",
                        artistId: 101,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: {
                    id: 401,
                    title: "Unstable Album",
                    foreignAlbumId: "album-mbid",
                    monitored: false,
                    anyReleaseOk: false,
                    releases: [{ id: 1 }],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    id: 401,
                    title: "Unstable Album",
                    foreignAlbumId: "album-mbid",
                    monitored: false,
                    anyReleaseOk: false,
                    releases: [{ id: 1 }],
                },
            });

        client.put.mockResolvedValue({ data: { monitored: true } });
        client.post.mockResolvedValue({ data: { id: 7101 } });

        const waitSpy = jest
            .spyOn(lidarrService as any, "waitForCommand")
            .mockResolvedValue({
                status: "completed",
                message: "Search completed with 1 report",
            });

        await expect(
            lidarrService.addAlbum(
                "album-mbid",
                "Monitored Artist",
                "Unstable Album",
                "/music",
                "artist-mbid",
            ),
        ).resolves.toEqual(
            expect.objectContaining({ id: 401, foreignAlbumId: "album-mbid" }),
        );
        expect(waitSpy).toHaveBeenCalledWith(7101, 30000);
        expect(logger.error).toHaveBeenCalledWith(
            " CRITICAL: Album monitoring failed to persist!",
        );

        waitSpy.mockRestore();
    });

    it("logs lidarr indexer diagnostics when initial search returns zero reports", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        (lidarrService as any)._indexerCountLogged = false;

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 202,
                        artistName: "Index Artist",
                        foreignArtistId: "artist-index",
                        monitored: true,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 502,
                        title: "Indexed Album",
                        foreignAlbumId: "album-index",
                        artistId: 202,
                        monitored: false,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: {
                    id: 502,
                    title: "Indexed Album",
                    foreignAlbumId: "album-index",
                    monitored: false,
                    anyReleaseOk: true,
                    releases: [{ id: 11 }],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    id: 502,
                    title: "Indexed Album",
                    foreignAlbumId: "album-index",
                    monitored: true,
                    anyReleaseOk: true,
                    releases: [{ id: 11 }],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    id: 502,
                    title: "Indexed Album",
                    foreignAlbumId: "album-index",
                    anyReleaseOk: true,
                    releases: [],
                },
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        enableRss: false,
                        enableAutomaticSearch: false,
                    },
                ],
            });

        client.put.mockResolvedValue({
            data: {
                id: 502,
                title: "Indexed Album",
                foreignAlbumId: "album-index",
                monitored: true,
                anyReleaseOk: true,
                releases: [{ id: 11 }],
            },
        });
        client.post.mockResolvedValue({ data: { id: 7201 } });

        const waitSpy = jest
            .spyOn(lidarrService as any, "waitForCommand")
            .mockResolvedValue({
                status: "completed",
                message: "Search completed with 0 reports",
            });

        await expect(
            lidarrService.addAlbum(
                "album-index",
                "Index Artist",
                "Indexed Album",
                "/music",
                "artist-index",
            ),
        ).rejects.toThrow(
            "No releases available - indexers found no matching downloads",
        );
        expect((lidarrService as any)._indexerCountLogged).toBe(true);
        expect(client.get).toHaveBeenCalledWith("/api/v1/indexer");
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining(
                "No enabled indexers - Lidarr cannot search for releases",
            ),
        );

        waitSpy.mockRestore();
    });

    it("falls back to base album and returns it when base search succeeds", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        (lidarrService as any)._indexerCountLogged = true;
        mockStripAlbumEdition.mockReturnValueOnce("Alpha Deluxe");

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 303,
                        artistName: "Base Album Artist",
                        foreignArtistId: "artist-base",
                        monitored: true,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 701,
                        title: "Alpha Deluxe (Remix)",
                        foreignAlbumId: "album-base",
                        artistId: 303,
                    },
                    {
                        id: 702,
                        title: "Alpha Deluxe 2",
                        foreignAlbumId: "album-base-2",
                        artistId: 303,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: {
                    id: 701,
                    title: "Alpha Deluxe (Remix)",
                    foreignAlbumId: "album-base",
                    artistId: 303,
                    monitored: false,
                    anyReleaseOk: false,
                    releases: [{ id: 11 }],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    id: 701,
                    title: "Alpha Deluxe (Remix)",
                    foreignAlbumId: "album-base",
                    artistId: 303,
                    monitored: true,
                    anyReleaseOk: false,
                    releases: [{ id: 11 }],
                },
            });

        client.put.mockResolvedValue({
            data: {
                id: 701,
                title: "Alpha Deluxe (Remix)",
                foreignAlbumId: "album-base",
                monitored: true,
            },
        });
        client.post
            .mockResolvedValueOnce({ data: { id: 7301 } })
            .mockResolvedValueOnce({ data: { id: 7302 } })
            .mockResolvedValueOnce({ data: { id: 7303 } });

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
            .mockResolvedValueOnce({
                status: "completed",
                message: "Base album search completed with 1 report",
            });

        await expect(
            lidarrService.addAlbum(
                "album-base",
                "Base Album Artist",
                "Alpha Deluxe (Remix)",
                "/music",
                "artist-base",
            ),
        ).resolves.toEqual(expect.objectContaining({ id: 702 }));
        expect(client.put).toHaveBeenCalledWith(
            "/api/v1/album/702",
            expect.objectContaining({
                id: 702,
                monitored: true,
                anyReleaseOk: true,
            }),
        );

        waitSpy.mockRestore();
    });

    it("falls back to base album and throws when base search also returns no reports", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        (lidarrService as any)._indexerCountLogged = true;
        mockStripAlbumEdition.mockReturnValueOnce("Alpha Deluxe");

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 303,
                        artistName: "Base Album Artist",
                        foreignArtistId: "artist-base-fail",
                        monitored: true,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 701,
                        title: "Alpha Deluxe (Remix)",
                        foreignAlbumId: "album-base-fail",
                        artistId: 303,
                    },
                    {
                        id: 702,
                        title: "Alpha Deluxe 2",
                        foreignAlbumId: "album-base-fail-2",
                        artistId: 303,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: {
                    id: 701,
                    title: "Alpha Deluxe (Remix)",
                    foreignAlbumId: "album-base-fail",
                    artistId: 303,
                    monitored: false,
                    anyReleaseOk: false,
                    releases: [{ id: 11 }],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    id: 701,
                    title: "Alpha Deluxe (Remix)",
                    foreignAlbumId: "album-base-fail",
                    artistId: 303,
                    monitored: true,
                    anyReleaseOk: false,
                    releases: [{ id: 11 }],
                },
            });

        client.put.mockResolvedValue({
            data: {
                id: 701,
                title: "Alpha Deluxe (Remix)",
                foreignAlbumId: "album-base-fail",
                monitored: true,
            },
        });
        client.post
            .mockResolvedValueOnce({ data: { id: 7351 } })
            .mockResolvedValueOnce({ data: { id: 7352 } })
            .mockResolvedValueOnce({ data: { id: 7353 } });

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
            .mockResolvedValueOnce({
                status: "completed",
                message: "Base album search completed with 0 reports",
            });

        await expect(
            lidarrService.addAlbum(
                "album-base-fail",
                "Base Album Artist",
                "Alpha Deluxe (Remix)",
                "/music",
                "artist-base-fail",
            ),
        ).rejects.toThrow("No releases available for");

        expect(logger.warn).toHaveBeenCalledWith(
            `   Base album "Alpha Deluxe 2" also has no releases`,
        );

        waitSpy.mockRestore();
    });

    it("returns null when start command returns an unrecoverable generic failure", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        (lidarrService as any)._indexerCountLogged = true;

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 404,
                        artistName: "Error Artist",
                        foreignArtistId: "artist-fail",
                        monitored: true,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 801,
                        title: "Error Album",
                        foreignAlbumId: "album-fail",
                        artistId: 404,
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: {
                    id: 801,
                    title: "Error Album",
                    foreignAlbumId: "album-fail",
                    artistId: 404,
                    monitored: false,
                    anyReleaseOk: false,
                    releases: [{ id: 1 }],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    id: 801,
                    title: "Error Album",
                    foreignAlbumId: "album-fail",
                    artistId: 404,
                    monitored: true,
                    anyReleaseOk: false,
                    releases: [{ id: 1 }],
                },
            });

        client.put.mockResolvedValue({ data: { id: 801, monitored: true } });
        client.post.mockResolvedValue({ data: { id: 7401 } });

        const waitSpy = jest
            .spyOn(lidarrService as any, "waitForCommand")
            .mockRejectedValue(new Error("command transport failed"));

        await expect(
            lidarrService.addAlbum(
                "album-fail",
                "Error Artist",
                "Error Album",
                "/music",
                "artist-fail",
            ),
        ).resolves.toBeNull();
        expect(logger.error).toHaveBeenCalledWith(
            "Lidarr add album error:",
            "command transport failed",
        );

        waitSpy.mockRestore();
    });

    it("blocklistAndRemove throws when Lidarr is disabled", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(
            lidarrService.blocklistAndRemove("missing-download"),
        ).rejects.toThrow("Lidarr not enabled");
    });

    it("grabRelease throws when Lidarr is disabled", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(
            lidarrService.grabRelease({
                guid: "g",
                protocol: "torrent",
                approved: false,
                rejected: false,
                indexerId: 1,
                title: "t",
            }),
        ).rejects.toThrow("Lidarr not enabled");
    });

    it("getAlbumReleases throws when Lidarr is disabled", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(lidarrService.getAlbumReleases(5)).rejects.toThrow(
            "Lidarr not enabled",
        );
    });

    it("returns false when blocklist deletion fails after queue lookup", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({
            data: {
                records: [
                    { id: 123, downloadId: "dl-fail", title: "Album Failing" },
                ],
            },
        });
        client.delete.mockRejectedValueOnce(new Error("delete failed"));

        await expect(lidarrService.blocklistAndRemove("dl-fail")).resolves.toBe(
            false,
        );
        expect(client.delete).toHaveBeenCalledWith("/api/v1/queue/123", {
            params: {
                removeFromClient: true,
                blocklist: true,
                skipRedownload: true,
            },
        });
    });

    it("returns empty releases and false grabs when release API operations fail", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockRejectedValueOnce(new Error("release API down"));
        client.post.mockRejectedValueOnce(new Error("grab failed"));

        await expect(lidarrService.getAlbumReleases(77)).resolves.toEqual([]);
        await expect(
            lidarrService.grabRelease({
                guid: "guid-1",
                indexerId: 5,
                title: "Broken Release",
                protocol: "torrent",
                approved: true,
                rejected: false,
            } as any),
        ).resolves.toBe(false);
    });
});
