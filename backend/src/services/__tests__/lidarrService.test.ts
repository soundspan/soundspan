import axios from "axios";
import {
    AcquisitionError,
    AcquisitionErrorType,
    cleanStuckDownloads,
    getQueue,
    getQueueCount,
    getRecentCompletedDownloads,
    isDownloadActive,
    lidarrService,
} from "../lidarr";
import { getSystemSettings } from "../../utils/systemSettings";
import { musicBrainzService } from "../musicbrainz";
import { stripAlbumEdition } from "../../utils/artistNormalization";
import { config as mockedConfig } from "../../config";
import { logger } from "../../utils/logger";

jest.mock("axios");

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../utils/artistNormalization", () => ({
    stripAlbumEdition: jest.fn((title: string) => title),
}));

jest.mock("../../config", () => ({
    config: {
        lidarr: undefined,
        music: {
            musicPath: "/music",
        },
    },
}));

jest.mock("../musicbrainz", () => ({
    musicBrainzService: {
        searchArtist: jest.fn(),
    },
}));

const mockAxiosCreate = axios.create as jest.Mock;
const mockAxiosGet = axios.get as jest.Mock;
const mockAxiosPost = axios.post as jest.Mock;
const mockAxiosDelete = axios.delete as jest.Mock;
const mockGetSystemSettings = getSystemSettings as jest.Mock;
const mockMusicBrainzSearchArtist = musicBrainzService.searchArtist as jest.Mock;
const mockStripAlbumEdition = stripAlbumEdition as jest.Mock;

function createClientMock() {
    return {
        get: jest.fn(),
        post: jest.fn(),
        put: jest.fn(),
        delete: jest.fn(),
    };
}

function primeServiceWithClient(client: ReturnType<typeof createClientMock>) {
    const svc = lidarrService as any;
    svc.client = client;
    svc.enabled = true;
    svc.initialized = true;
    svc.discoveryTagId = null;
    svc._indexerCountLogged = false;
}

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
            original
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
            new Error("settings db unavailable")
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
            "artist-mbid"
        );

        expect(client.get).toHaveBeenCalledWith("/api/v1/artist/lookup", {
            params: { term: "lidarr:artist-mbid" },
        });
        expect(results[0]).toEqual(
            expect.objectContaining({
                foreignArtistId: "artist-mbid",
                artistName: "Fallback Artist",
            })
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
            "artist-direct-mbid"
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
            { id: "artist-mbid-fallback", name: "Fallback Artist", type: "Group" },
        ]);

        const results = await lidarrService.searchArtist(
            "Fallback Artist",
            "artist-mbid-fallback"
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
            lidarrService.searchArtist("Fallback Artist", "artist-mbid-fallback")
        ).resolves.toEqual([]);
    });

    it("searchArtist throws when Lidarr is disabled", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(lidarrService.searchArtist("Artist")).rejects.toThrow(
            "Lidarr not enabled"
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
            lidarrService.searchAlbum("Artist", "Album")
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
            lidarrService.searchAlbum("Artist", "Album")
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
            (lidarrService as any).waitForCommand(12, 5000, 0)
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
            (lidarrService as any).waitForCommand(13, 5000, 0)
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
        await expect(lidarrService.getArtistAlbums("artist-mbid-1")).resolves.toEqual(
            [{ id: 81, title: "Album 81" }]
        );

        client.get.mockResolvedValueOnce({
            data: [{ id: 77, foreignArtistId: "other-mbid" }],
        });
        await expect(lidarrService.getArtistAlbums("missing-mbid")).resolves.toEqual(
            []
        );

        client.get.mockRejectedValueOnce(new Error("network"));
        await expect(lidarrService.getArtistAlbums("artist-mbid-1")).resolves.toEqual(
            []
        );
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
            (lidarrService as any).ensureRootFolderExists("/missing")
        ).resolves.toBe("/library");
        await expect(
            (lidarrService as any).ensureRootFolderExists("/missing")
        ).resolves.toBe("/missing");
        await expect(
            (lidarrService as any).ensureRootFolderExists("/missing")
        ).resolves.toBe("/missing");
    });

    it("returns requested root folder when it already exists", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({
            data: [{ path: "/music" }, { path: "/library" }],
        });

        await expect(
            (lidarrService as any).ensureRootFolderExists("/music")
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
                false
            )
        ).resolves.toEqual(
            expect.objectContaining({
                foreignArtistId: "artist-mbid-better",
            })
        );

        expect(client.post).toHaveBeenCalledWith(
            "/api/v1/artist",
            expect.objectContaining({
                foreignArtistId: "artist-mbid-better",
                rootFolderPath: "/library",
                monitorNewItems: "none",
            })
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
                false
            )
        ).resolves.toEqual(
            expect.objectContaining({
                foreignArtistId: "artist-mbid-group",
            })
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
                false
            )
        ).resolves.toEqual(
            expect.objectContaining({
                foreignArtistId: "artist-only",
            })
        );

        searchSpy.mockRestore();
    });

    it("addArtist throws when Lidarr is disabled", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(
            lidarrService.addArtist("artist-disabled", "Disabled Artist")
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
                true
            )
        ).resolves.toEqual(
            expect.objectContaining({
                id: 77,
                foreignArtistId: "artist-discovery-add",
            })
        );

        expect(discoverySpy).toHaveBeenCalled();
        expect(client.post).toHaveBeenCalledWith(
            "/api/v1/artist",
            expect.objectContaining({
                tags: [77],
                monitorNewItems: "none",
            })
        );
        expect(client.post).toHaveBeenCalledWith(
            "/api/v1/command",
            expect.objectContaining({
                name: "RefreshArtist",
                artistId: 77,
            })
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
                false
            )
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
                true
            )
        ).resolves.toEqual(
            expect.objectContaining({
                id: 12,
                monitored: true,
            })
        );

        expect(addTagsSpy).toHaveBeenCalledWith(12, [99]);
        expect(client.put).toHaveBeenCalledWith(
            "/api/v1/artist/12",
            expect.objectContaining({
                monitored: true,
                monitorNewItems: "all",
            })
        );
        expect(client.put).toHaveBeenCalledWith(
            "/api/v1/album/301",
            expect.objectContaining({
                id: 301,
                monitored: true,
            })
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
                false
            )
        ).resolves.toEqual(
            expect.objectContaining({
                id: 22,
                foreignArtistId: "artist-mbid-race",
            })
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
            lidarrService.addArtist("artist-missing", "Missing Artist")
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
                false
            )
        ).resolves.toEqual(
            expect.objectContaining({
                id: 88,
                foreignArtistId: "artist-existing",
            })
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
                true
            )
        ).resolves.toEqual(
            expect.objectContaining({
                id: 89,
                foreignArtistId: "artist-discovery",
            })
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
                false
            )
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
            lidarrService.addArtist("", "Alpha Artist", "/music", true, false, false)
        ).resolves.toEqual(
            expect.objectContaining({
                foreignArtistId: "alpha-artist",
            })
        );

        expect(client.post).toHaveBeenCalledWith(
            "/api/v1/artist",
            expect.objectContaining({
                foreignArtistId: "alpha-artist",
            })
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

        client.get
            .mockResolvedValueOnce({ data: [] })
            .mockResolvedValueOnce({
                data: [{ id: 101, label: "soundspan-discovery" }],
            });
        client.post.mockRejectedValueOnce(new Error("tag create conflict"));

        await expect(lidarrService.getOrCreateDiscoveryTag()).resolves.toBeNull();
        await expect(lidarrService.getOrCreateDiscoveryTag()).resolves.toBe(101);
        await expect(lidarrService.getOrCreateDiscoveryTag()).resolves.toBe(101);

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

        await expect(lidarrService.addTagsToArtist(11, [2, 3])).resolves.toBe(true);
        await expect(lidarrService.removeTagsFromArtist(11, [1, 3])).resolves.toBe(
            true
        );

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
            data: { id: 21, artistName: "Artist B", monitored: true, tags: [4, 7] },
        });
        client.put.mockRejectedValueOnce(new Error("tag update failed"));

        await expect(lidarrService.addTagsToArtist(21, [7, 9])).resolves.toBe(
            false
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

        await expect(lidarrService.removeTagsFromArtist(22, [5, 99])).resolves.toBe(
            false
        );
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

        await expect(lidarrService.removeDiscoveryTagByMbid("artist-1")).resolves.toBe(
            true
        );
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
                    records: [{ id: 44, downloadId: "dl-1", title: "Queued Album" }],
                },
            });
        client.post.mockResolvedValue({});
        client.delete.mockResolvedValue({});

        const releases = await lidarrService.getAlbumReleases(77);
        expect(releases[0].guid).toBe("r3");
        expect(releases[1].guid).toBe("r2");

        await expect(lidarrService.grabRelease(releases[0] as any)).resolves.toBe(true);
        await expect(lidarrService.blocklistAndRemove("dl-1")).resolves.toBe(true);
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
                "artist-mbid"
            )
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
                new Error("Command 9103 timed out after 30000ms")
            );

        await expect(
            lidarrService.addAlbum(
                "album-rg-mbid",
                "Artist",
                "Album Studio Session",
                "/music",
                "artist-mbid"
            )
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
            lidarrService.addAlbum("album-mbid", "Unknown Artist", "Unknown Album")
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
                "artist-missing"
            )
        ).resolves.toBeNull();

        expect(addArtistSpy).toHaveBeenCalledWith(
            "artist-missing",
            "Unknown Artist",
            "/music",
            false,
            false,
            false
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
                "artist-mbid"
            )
        ).resolves.toBeNull();
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
                "artist-existing-unmonitored"
            )
        ).resolves.toEqual(
            expect.objectContaining({
                id: 901,
                foreignAlbumId: "album-mbid",
                monitored: true,
            })
        );

        expect(client.put).toHaveBeenCalledWith(
            "/api/v1/artist/55",
            expect.objectContaining({
                id: 55,
                artistName: "Dormant Artist",
                foreignArtistId: "artist-existing-unmonitored",
                monitored: true,
            })
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
                "artist-refresh-fail"
            )
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
                true
            )
        ).resolves.toEqual(
            expect.objectContaining({
                id: 901,
                foreignAlbumId: "album-mbid",
            })
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
            lidarrService.addAlbum("album-mbid", "Artist", "Album")
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
                    "artist-no-indexers"
                )
            ).rejects.toThrow("No releases available - indexers found no matching downloads");

            expect(waitSpy).toHaveBeenCalled();
            expect(waitSpy.mock.calls[0]?.[1]).toBe(30000);
            expect(client.put).toHaveBeenCalledWith(
                "/api/v1/album/901",
                expect.objectContaining({ anyReleaseOk: true })
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
                    "artist-timeout"
                )
            ).resolves.toMatchObject({ id: 902, foreignAlbumId: "album-timeout" });

            expect(waitSpy).toHaveBeenCalledWith(9301, 30000);
        } finally {
            waitSpy.mockRestore();
        }
    });

    it("returns true when blocklist target is already absent from queue", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({ data: { records: [] } });

        await expect(lidarrService.blocklistAndRemove("missing-download")).resolves.toBe(
            true
        );
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
                "artist-mbid"
            )
        ).resolves.toEqual(
            expect.objectContaining({ id: 401, foreignAlbumId: "album-mbid" })
        );
        expect(waitSpy).toHaveBeenCalledWith(7101, 30000);
        expect(logger.error).toHaveBeenCalledWith(
            " CRITICAL: Album monitoring failed to persist!"
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
                "artist-index"
            )
        ).rejects.toThrow(
            "No releases available - indexers found no matching downloads"
        );
        expect((lidarrService as any)._indexerCountLogged).toBe(true);
        expect(client.get).toHaveBeenCalledWith("/api/v1/indexer");
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining(
                "No enabled indexers - Lidarr cannot search for releases"
            )
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
                "artist-base"
            )
        ).resolves.toEqual(expect.objectContaining({ id: 702 }));
        expect(client.put).toHaveBeenCalledWith(
            "/api/v1/album/702",
            expect.objectContaining({
                id: 702,
                monitored: true,
                anyReleaseOk: true,
            })
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
                "artist-base-fail"
            )
        ).rejects.toThrow("No releases available for");

        expect(logger.warn).toHaveBeenCalledWith(
            `   Base album "Alpha Deluxe 2" also has no releases`
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
                "artist-fail"
            )
        ).resolves.toBeNull();
        expect(logger.error).toHaveBeenCalledWith(
            "Lidarr add album error:",
            "command transport failed"
        );

        waitSpy.mockRestore();
    });

    it("blocklistAndRemove throws when Lidarr is disabled", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(
            lidarrService.blocklistAndRemove("missing-download")
        ).rejects.toThrow("Lidarr not enabled");
    });

    it("grabRelease throws when Lidarr is disabled", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(
            lidarrService.grabRelease({ guid: "g", protocol: "torrent", approved: false, rejected: false, indexerId: 1, title: "t", })
        ).rejects.toThrow("Lidarr not enabled");
    });

    it("getAlbumReleases throws when Lidarr is disabled", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(lidarrService.getAlbumReleases(5)).rejects.toThrow(
            "Lidarr not enabled"
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

        await expect(lidarrService.blocklistAndRemove("dl-fail")).resolves.toBe(false);
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
            } as any)
        ).resolves.toBe(false);
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
                        images: [{ coverType: "cover", remoteUrl: "https://cover.jpg" }],
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

        await expect(lidarrService.findQueueItemByDownloadId("dl-2")).resolves.toEqual(
            { downloadId: "dl-2", id: 2, title: "Album 2" }
        );

        const calendar = await lidarrService.getCalendar(
            new Date("2026-02-01"),
            new Date("2026-02-28")
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
            new Date("2026-02-28")
        );
        expect(calendar).toEqual([]);
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
                "album-mbid-31"
            )
        ).toBe(true);
        expect(
            (lidarrService as any).isAlbumAvailableInSnapshot(
                snapshot,
                undefined,
                "My Artist",
                "My Album"
            )
        ).toBe(true);

        expect(
            (lidarrService as any).isDownloadActiveInSnapshot(snapshot, "queue-1")
        ).toEqual({ active: true, progress: 80 });
        expect(
            (lidarrService as any).isDownloadActiveInSnapshot(snapshot, "queue-2")
        ).toEqual({ active: false, progress: 30 });
    });

    it("keeps queue state when album indexing fails during snapshot creation", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

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
            .mockRejectedValueOnce(new Error("album index down"));

        const snapshot = await lidarrService.getReconciliationSnapshot();
        expect(snapshot.queue.size).toBe(1);
        expect(snapshot.albumsByMbid.size).toBe(0);
    });

    it("deletes artists/albums and checks availability helpers", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockResolvedValueOnce({
                data: [
                    { id: 51, foreignArtistId: "artist-mbid-1", artistName: "Artist 1" },
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
                data: [{ foreignAlbumId: "album-1", statistics: { percentOfTracks: 100 } }],
            })
            .mockResolvedValueOnce({
                data: [
                    { id: 51, artistName: "Artist 1", sortName: "artist 1" },
                ],
            })
            .mockResolvedValueOnce({
                data: [{ title: "Album 1", statistics: { percentOfTracks: 100 } }],
            })
            .mockResolvedValueOnce({
                data: [{ foreignArtistId: "artist-mbid-1" }],
            });
        client.delete.mockResolvedValue({});
        client.put.mockResolvedValue({});

        await expect(lidarrService.deleteArtist("artist-mbid-1")).resolves.toEqual(
            expect.objectContaining({ success: true })
        );
        await expect(lidarrService.deleteAlbum(81)).resolves.toEqual(
            expect.objectContaining({ success: true })
        );
        await expect(lidarrService.isAlbumAvailable("album-1")).resolves.toBe(true);
        await expect(
            lidarrService.isAlbumAvailableByTitle("Artist 1", "Album 1")
        ).resolves.toBe(true);
        await expect(lidarrService.isArtistInLidarr("artist-mbid-1")).resolves.toBe(
            true
        );
    });

    it("searchAlbum falls back to stripped title when direct lookup returns no album", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        mockStripAlbumEdition.mockReturnValueOnce("Album");

        client.get
            .mockResolvedValueOnce({ data: [] })
            .mockResolvedValueOnce({
                data: [{ id: 901, title: "Album", foreignAlbumId: "album-mbid-901" }],
            });

        await expect(
            lidarrService.searchAlbum("Artist", "Album (Deluxe)")
        ).resolves.toEqual([
            expect.objectContaining({
                id: 901,
                foreignAlbumId: "album-mbid-901",
            }),
        ]);

        expect(client.get).toHaveBeenCalledTimes(2);
        expect(client.get).toHaveBeenNthCalledWith(
            2,
            "/api/v1/album/lookup",
            {
                params: { term: "Artist Album" },
            }
        );
    });

    it("searchAlbum with MBID uses only primary lookup and does not try stripped title", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockResolvedValueOnce({ data: [] });

        await expect(
            lidarrService.searchAlbum("Artist", "Album", "album-mbid")
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
            lidarrService.searchAlbum("Artist", "Album", "album-mbid")
        ).resolves.toEqual([]);
    });

    it("searchAlbum throws when Lidarr is disabled", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(
            lidarrService.searchAlbum("Artist", "Album")
        ).rejects.toThrow("Lidarr not enabled");
    });

    it("searchArtist returns empty on Lidarr error when no MBID is supplied", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockRejectedValueOnce(new Error("lookup down"));

        await expect(lidarrService.searchArtist("No Backup")).resolves.toEqual([]);
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
            (lidarrService as any).waitForCommand(99, 10, 0)
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
        await expect(lidarrService.rescanLibrary()).rejects.toThrow("rescan failed");
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
            lidarrService.deleteArtist("temp-artist")
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
            lidarrService.deleteArtist("missing-mbid")
        ).resolves.toEqual({
            success: true,
            message: "Artist not in Lidarr (already removed or never added)",
        });
    });

    it("deleteAlbum removes cached track files and unmonitors album", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockResolvedValueOnce({ data: { id: 81, artistId: 33, title: "Album 81" } })
            .mockResolvedValueOnce({ data: [{ id: 201 }, { id: 202 }] });
        client.delete.mockResolvedValue({});
        client.put.mockResolvedValue({ data: {} });

        await expect(lidarrService.deleteAlbum(81)).resolves.toEqual(
            expect.objectContaining({
                success: true,
                message: "Deleted files and unmonitored Album 81",
            })
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

        await expect(lidarrService.deleteArtist("artist-delete-fail")).resolves.toEqual({
            success: false,
            message: "delete failed",
        });
    });

    it("returns safe defaults for disabled Lidarr helper methods", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(lidarrService.deleteArtist("artist-disabled")).resolves.toEqual({
            success: false,
            message: "Lidarr not enabled or configured",
        });
        await expect(lidarrService.deleteAlbum(9)).resolves.toEqual({
            success: false,
            message: "Lidarr not enabled or configured",
        });
        expect(await lidarrService.isAlbumAvailable("album-mbid")).toBe(false);
        expect(await lidarrService.isAlbumAvailableByTitle("Artist", "Album")).toBe(
            false
        );
        expect(await lidarrService.isArtistInLidarr("artist-disabled")).toBe(false);
        expect(await lidarrService.getTags()).toEqual([]);
        expect(await lidarrService.createTag("new-tag")).toBeNull();
        expect(await lidarrService.getOrCreateDiscoveryTag()).toBeNull();
        expect(await lidarrService.addTagsToArtist(1, [3])).toBe(false);
        expect(await lidarrService.removeTagsFromArtist(1, [3])).toBe(false);
        expect(await lidarrService.getArtistsByTag(3)).toEqual([]);
        expect(await lidarrService.removeDiscoveryTagByMbid("artist-disabled")).toBe(
            false
        );
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
            data: [{ foreignAlbumId: "album-mbid", statistics: { percentOfTracks: 80 } }],
        });
        await expect(lidarrService.isAlbumAvailable("album-mbid")).resolves.toBe(true);

        client.get.mockResolvedValueOnce({
            data: [{ foreignAlbumId: "other", statistics: { percentOfTracks: 100 } }],
        });
        await expect(lidarrService.isAlbumAvailable("album-mbid")).resolves.toBe(false);

        client.get.mockResolvedValueOnce({
            data: [{ foreignAlbumId: "album-mbid", statistics: { percentOfTracks: 0 } }],
        });
        await expect(lidarrService.isAlbumAvailable("album-mbid")).resolves.toBe(false);

        client.get.mockRejectedValueOnce({ response: { status: 404 } });
        await expect(lidarrService.isAlbumAvailable("album-mbid")).resolves.toBe(false);
    });

    it("isAlbumAvailableByTitle returns false when no matches or matching entries have no files", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockResolvedValueOnce({ data: [] });
        await expect(lidarrService.isAlbumAvailableByTitle("A", "B")).resolves.toBe(false);

        client.get
            .mockResolvedValueOnce({
                data: [{ id: 5, artistName: "Target", foreignArtistId: "mb" }],
            })
            .mockResolvedValueOnce({
                data: [{ title: "B", statistics: { percentOfTracks: 0 } }],
            });
        await expect(
            lidarrService.isAlbumAvailableByTitle("Target", "B")
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
            lidarrService.isAlbumAvailableByTitle("Target Artist", "Wanted Album")
        ).resolves.toBe(true);
    });

    it("returns false on Lidarr availability lookup failures and checks snapshot helpers", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockRejectedValueOnce(new Error("album query failed"))
            .mockRejectedValueOnce(new Error("title lookup failed"));

        await expect(
            lidarrService.isAlbumAvailable("album-lookup-failed")
        ).resolves.toBe(false);
        await expect(
            lidarrService.isAlbumAvailableByTitle("Unavailable Artist", "Unavailable Album")
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
                    "artist|album deluxe",
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
                "Album Deluxe"
            )
        ).toBe(true);
        expect(
            (lidarrService as any).isAlbumAvailableInSnapshot(
                snapshot,
                undefined,
                "Artist",
                "Album"
            )
        ).toBe(true);
        expect(
            (lidarrService as any).isAlbumAvailableInSnapshot(
                snapshot,
                undefined,
                "Nope",
                "Missing"
            )
        ).toBe(false);
        expect(
            (lidarrService as any).isDownloadActiveInSnapshot(snapshot, "dl-missing")
        ).toEqual({ active: false });
    });

    it("isArtistInLidarr returns false when artist is absent", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({ data: [{ foreignArtistId: "other" }] });

        await expect(
            lidarrService.isArtistInLidarr("absent-mbid")
        ).resolves.toBe(false);
    });

    it("isArtistInLidarr reports true when artist exists", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({
            data: [{ id: 11, foreignArtistId: "present-mbid" }],
        });

        await expect(lidarrService.isArtistInLidarr("present-mbid")).resolves.toBe(true);
    });

    it("getArtistsByTag filters artists using Lidarr tag ids", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({
            data: [
                { id: 1, foreignArtistId: "a", tags: [9, 8], artistName: "With Tag" },
                { id: 2, foreignArtistId: "b", tags: [1], artistName: "No Tag" },
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
            lidarrService.removeDiscoveryTagByMbid("missing-mbid")
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
            lidarrService.removeDiscoveryTagByMbid("mb")
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
            lidarrService.deleteArtistById(99, false)
        ).resolves.toEqual({
            success: false,
            message: "server down",
        });

        expect(client.delete).toHaveBeenCalledWith("/api/v1/artist/99", {
            params: { deleteFiles: false, addImportListExclusion: false },
            timeout: 30000,
        });
    });

    it("getReconciliationSnapshot tolerates queue failures and uses album fallback", async () => {
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

        const snapshot = await lidarrService.getReconciliationSnapshot();
        expect(snapshot.queue.size).toBe(0);
        expect(snapshot.albumsByMbid.has("album-fallback")).toBe(true);
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
            "/fallback"
        );
    });

    it("getArtistAlbums returns empty list when service client is unavailable", async () => {
        const svc = lidarrService as any;
        svc.client = null;

        await expect(lidarrService.getArtistAlbums("artist-mbid")).resolves.toEqual(
            []
        );
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
                false
            )
        ).resolves.toEqual(
            expect.objectContaining({
                id: 12,
                foreignArtistId: "artist-existing",
            })
        );

        expect(client.post).not.toHaveBeenCalled();
        expect(client.put).toHaveBeenCalledWith(
            "/api/v1/artist/12",
            expect.objectContaining({
                monitored: true,
                monitorNewItems: "all",
            })
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
                false
            )
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
                false
            )
        ).resolves.toEqual(
            expect.objectContaining({
                id: 77,
                foreignArtistId: "artist-refresh-fail",
            })
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

        await expect(lidarrService.searchAlbum("Artist", "Album")).resolves.toEqual(
            []
        );

        expect(client.get).toHaveBeenCalledTimes(1);
        expect(client.get).toHaveBeenCalledWith("/api/v1/album/lookup", {
            params: { term: "Artist Album" },
        });
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
                "artist-mbid-refresh"
            )
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
                "artist-added"
            )
        ).resolves.toEqual(
            expect.objectContaining({
                id: 301,
                foreignAlbumId: "album-added-mbid",
                monitored: true,
            })
        );

        expect(addArtistSpy).toHaveBeenCalledWith(
            "artist-added",
            "Added Artist",
            "/music",
            false,
            false,
            false
        );
        expect(client.put).toHaveBeenCalledWith(
            "/api/v1/artist/88",
            expect.objectContaining({
                id: 88,
                artistName: "Added Artist",
                foreignArtistId: "artist-added",
                monitored: true,
                tags: [],
            })
        );
        expect(client.put).toHaveBeenCalledWith(
            "/api/v1/album/301",
            expect.objectContaining({
                id: 301,
                title: "Album Added",
                monitored: true,
            })
        );

        addArtistSpy.mockRestore();
        waitSpy.mockRestore();
    });

    it("getCalendar returns empty list without client", async () => {
        const svc = lidarrService as any;
        svc.client = null;

        const calendar = await lidarrService.getCalendar(
            new Date("2026-02-01"),
            new Date("2026-02-28")
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
        mockAxiosGet.mockResolvedValueOnce({
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
        mockAxiosDelete.mockResolvedValue({});

        const result = await cleanStuckDownloads(
            "http://lidarr:8686",
            "api-key"
        );
        expect(result).toEqual({ removed: 1, items: ["Terminal Import Failed"] });
        expect(mockAxiosDelete).toHaveBeenCalledTimes(1);
    });

    it("initializes a Lidarr client from environment config during construction", () => {
        const constructedClient = createClientMock();
        mockedConfig.lidarr = {
            enabled: true,
            url: "http://constructor-lidarr:8686",
            apiKey: "constructor-key",
        };
        mockAxiosCreate.mockReturnValue(constructedClient);

        const ServiceClass = (lidarrService as any).constructor;
        const freshService = new ServiceClass();

        expect(mockAxiosCreate).toHaveBeenCalledWith({
            baseURL: "http://constructor-lidarr:8686",
            timeout: 30000,
            headers: {
                "X-Api-Key": "constructor-key",
            },
        });
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
                "artist-timeout"
            )
        ).resolves.toBeNull();

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Timeout reached after 60s")
        );

        addArtistSpy.mockRestore();
        setTimeoutSpy.mockRestore();
    });

    it("addAlbum matches album title using exact normalized comparison", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const artist = {
            id: 55,
            artistName: "Exact Match Band",
            foreignArtistId: "artist-exact",
            monitored: true,
        };

        const album = {
            id: 901,
            title: "Exact Match Album (Deluxe Edition)",
            foreignAlbumId: "album-exact",
            artistId: 55,
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

        client.put.mockResolvedValue({ data: { ...album, monitored: true } });
        client.post.mockResolvedValue({ data: { id: 9101 } });

        const waitSpy = jest
            .spyOn(lidarrService as any, "waitForCommand")
            .mockResolvedValue({
                status: "completed",
                message: "Search completed with 1 report",
            });

        await expect(
            lidarrService.addAlbum(
                "different-mbid",
                "Exact Match Band",
                "Exact Match Album",
                "/music",
                "artist-exact"
            )
        ).resolves.toEqual(
            expect.objectContaining({
                id: 901,
                foreignAlbumId: "album-exact",
            })
        );

        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining('Matched exact normalized: "Exact Match Album (Deluxe Edition)"')
        );

        waitSpy.mockRestore();
    });

    it("addAlbum matches album title using strict partial normalized comparison", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        const artist = {
            id: 66,
            artistName: "Partial Band",
            foreignArtistId: "artist-partial",
            monitored: true,
        };

        const album = {
            id: 902,
            title: "Partial Match Album Remastered",
            foreignAlbumId: "album-partial",
            artistId: 66,
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
                "different-mbid",
                "Partial Band",
                "Partial Match Album",
                "/music",
                "artist-partial"
            )
        ).resolves.toEqual(
            expect.objectContaining({
                id: 902,
                foreignAlbumId: "album-partial",
            })
        );

        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining('Matched partial (contained): "Partial Match Album Remastered"')
        );

        waitSpy.mockRestore();
    });

    it("getOrCreateDiscoveryTag returns null when tag discovery fails", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        const getTagsSpy = jest
            .spyOn(lidarrService as any, "getTags")
            .mockRejectedValueOnce(new Error("tag lookup failed"));
        (lidarrService as any).discoveryTagId = null;

        await expect(lidarrService.getOrCreateDiscoveryTag()).resolves.toBeNull();
        expect(getTagsSpy).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(
            "[LIDARR] Failed to get/create discovery tag:",
            "tag lookup failed"
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
            lidarrService.removeDiscoveryTagByMbid("artist-without-tag-id")
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
        client.delete.mockRejectedValueOnce({ response: { status: 500 }, message: "delete failed" });

        await expect(
            lidarrService.blocklistAndRemove("remove-fail")
        ).resolves.toBe(false);
        expect(logger.error).toHaveBeenCalledWith(
            "[LIDARR] Failed to blocklist:",
            "delete failed"
        );
    });

    it("rescanLibrary throws when Lidarr is disabled", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(lidarrService.rescanLibrary()).rejects.toThrow("Lidarr not enabled");
    });

    it("checks album availability with generic Lidarr failures", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockRejectedValueOnce(new Error("album query failed"));

        await expect(lidarrService.isAlbumAvailable("album-failure")).resolves.toBe(false);
        expect(logger.error).toHaveBeenCalledWith(
            "Lidarr album check error:",
            "album query failed"
        );
    });

    it("checks artist existence with fallback false on Lidarr errors", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockRejectedValueOnce(new Error("artist fetch failed"));

        await expect(
            lidarrService.isArtistInLidarr("artist-failure")
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
            .mockRejectedValueOnce(new Error("release lookup failed"));

        await expect(
            lidarrService.getAlbumReleases(12)
        ).resolves.toEqual([
            expect.objectContaining({ id: 2 }),
            expect.objectContaining({ id: 3 }),
            expect.objectContaining({ id: 1 }),
        ]);

        const emptyReleases = await lidarrService.getAlbumReleases(13);
        expect(emptyReleases).toEqual([]);
        expect(logger.error).toHaveBeenCalledWith(
            "[LIDARR] Failed to fetch releases:",
            "release lookup failed"
        );
    });

    it("returns null for findQueueItemByDownloadId when client is unavailable", async () => {
        const svc = lidarrService as any;
        svc.initialized = true;
        svc.enabled = false;
        svc.client = null;

        await expect(
            (lidarrService as any).findQueueItemByDownloadId("dl-disabled")
        ).resolves.toBeNull();
    });

    it("findQueueItemByDownloadId returns null when queue lookup fails", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockRejectedValueOnce(new Error("queue down"));

        await expect(
            (lidarrService as any).findQueueItemByDownloadId("dl-down")
        ).resolves.toBeNull();
        expect(logger.error).toHaveBeenCalledWith(
            "[LIDARR] Failed to find queue item:",
            "queue down"
        );
    });

    it("getMonitoredArtists returns empty list on fetch failures", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockRejectedValueOnce(new Error("monitored artists unavailable"));

        await expect(lidarrService.getMonitoredArtists()).resolves.toEqual([]);
        expect(logger.error).toHaveBeenCalledWith(
            "[LIDARR] Failed to fetch monitored artists:",
            "monitored artists unavailable"
        );
    });

    it("returns empty snapshot when reconciliation snapshot enrichment fails", async () => {
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

        const snapshot = await lidarrService.getReconciliationSnapshot();

        expect(snapshot.queue.size).toBe(0);
        expect(snapshot.albumsByMbid.size).toBe(0);
        expect(snapshot.albumsByTitle.size).toBe(0);
        expect(logger.error).toHaveBeenCalledWith(
            "[LIDARR] Failed to create reconciliation snapshot:",
            expect.any(String)
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
                "artist-base-fallback"
            )
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
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 1,
                        title: "Album One",
                        statusMessages: [
                            { title: "msg", messages: ["No files found are eligible for import"] },
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
        mockAxiosDelete.mockResolvedValue({});

        const result = await cleanStuckDownloads("http://lidarr:8686", "api-key");
        expect(result.removed).toBe(3);
        expect(result.items).toEqual(["Album One", "Album Two", "Album Three"]);
        expect(mockAxiosDelete).toHaveBeenCalledTimes(3);
    });

    it("filters recent completed downloads from history", async () => {
        const now = Date.now();
        mockAxiosGet.mockResolvedValueOnce({
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
            5
        );
        expect(records).toHaveLength(1);
        expect(records[0].id).toBe(1);
    });

    it("returns queue count with safe fallback on errors", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: { totalRecords: 17 },
        });
        await expect(getQueueCount("http://lidarr:8686", "api-key")).resolves.toBe(
            17
        );

        mockAxiosGet.mockRejectedValueOnce(new Error("queue down"));
        await expect(getQueueCount("http://lidarr:8686", "api-key")).resolves.toBe(0);
    });

    it("returns queue and active download status from settings", async () => {
        mockAxiosGet
            .mockResolvedValueOnce({
                data: {
                    records: [{ id: 11, downloadId: "dl-11", status: "downloading" }],
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

        expect(queue).toEqual([{ id: 11, downloadId: "dl-11", status: "downloading" }]);
        expect(active).toEqual({
            active: true,
            status: "downloading",
            progress: 75,
        });
        expect(missing).toEqual({ active: false, status: "not_found" });
    });

    it("marks warning-tracked downloads as inactive even when still downloading", async () => {
        mockAxiosGet.mockResolvedValueOnce({
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

    it("continues cleanup when queue removal returns 404 and does not count it as removed", async () => {
        mockAxiosGet.mockResolvedValueOnce({
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
        mockAxiosDelete.mockRejectedValueOnce({
            response: { status: 404 },
            message: "not found",
        });

        await expect(
            cleanStuckDownloads("http://lidarr:8686", "api-key")
        ).resolves.toEqual({ removed: 0, items: [] });
        expect(mockAxiosDelete).toHaveBeenCalledTimes(1);
    });

    it("logs non-404 cleanup failures and continues without counting removed items", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 77,
                        title: "Sticky item",
                        statusMessages: [
                            {
                                title: "msg",
                                messages: ["No files found are eligible for import"],
                            },
                        ],
                        trackedDownloadStatus: "warning",
                        trackedDownloadState: "importPending",
                    },
                ],
            },
        });
        mockAxiosDelete.mockRejectedValueOnce({
            response: { status: 500 },
            message: "delete failed",
        });

        await expect(
            cleanStuckDownloads("http://lidarr:8686", "api-key")
        ).resolves.toEqual({ removed: 0, items: [] });
        expect(mockAxiosDelete).toHaveBeenCalledTimes(1);
    });

    it("bubbles queue cleanup fetch failures", async () => {
        mockAxiosGet.mockRejectedValueOnce(new Error("queue unavailable"));

        await expect(
            cleanStuckDownloads("http://lidarr:8686", "api-key")
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
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 77,
                        title: "Healthy item",
                        statusMessages: [{ title: "ok", messages: ["all good"] }],
                        trackedDownloadStatus: "ok",
                        trackedDownloadState: "downloading",
                    },
                ],
            },
        });

        const result = await cleanStuckDownloads("http://lidarr:8686", "api-key");
        expect(result).toEqual({ removed: 0, items: [] });
        expect(mockAxiosDelete).not.toHaveBeenCalled();
    });

    it("returns empty queue when queue fetch fails", async () => {
        mockAxiosGet.mockRejectedValueOnce(new Error("queue down"));
        await expect(getQueue()).resolves.toEqual([]);
    });

    it("returns inactive status when active-check fetch fails", async () => {
        mockAxiosGet.mockRejectedValueOnce(new Error("queue down"));
        await expect(isDownloadActive("dl-11")).resolves.toEqual({ active: false });
    });

    it("propagates recent-completed-download failures from Lidarr history", async () => {
        mockAxiosGet.mockRejectedValueOnce(new Error("history down"));

        await expect(
            getRecentCompletedDownloads("http://lidarr:8686", "api-key", 5)
        ).rejects.toThrow("history down");
    });
});
