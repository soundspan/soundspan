import axios from "axios";
import { logger } from "../../utils/logger";
import { deezerService } from "../deezer";
import { type SpotifyPlaylist, spotifyService } from "../spotify";

jest.mock("axios");

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../deezer", () => ({
    deezerService: {
        getTrackAlbum: jest.fn(),
    },
}));

jest.mock("../rateLimiter", () => ({
    rateLimiter: {
        execute: jest.fn(async (_bucket: string, fn: () => Promise<unknown>) => fn()),
    },
}));

const mockAxiosGet = axios.get as jest.Mock;
const mockLoggerDebug = logger.debug as jest.Mock;
const mockLoggerWarn = logger.warn as jest.Mock;
const mockLoggerError = logger.error as jest.Mock;
const mockDeezerTrackAlbum = deezerService.getTrackAlbum as jest.Mock;

function makeTokenResponse(token: string) {
    return { data: { accessToken: token } };
}

type SpotifyServiceTestHandle = {
    anonymousToken: string | null;
    tokenExpiry: number;
    tokenRefreshPromise: Promise<string | null> | null;
    lastTokenEndpointFailureLogAt: number;
    getAnonymousToken: () => Promise<string | null>;
    performTokenRefresh: () => Promise<string | null>;
    extractTracksFromApolloCache: (
        html: string
    ) => Array<{ trackId: string; albumName: string; albumId: string }>;
    scrapePlaylistPageForAlbums: (
        playlistId: string
    ) => Promise<Map<string, { album: string; albumId: string }>>;
    scrapeTrackPagesForAlbums: (
        tracks: Array<{ spotifyId: string; title: string; artist: string }>
    ) => Promise<Map<string, { album: string; albumId: string }>>;
    resolveAlbumsViaDeezer: (
        tracks: Array<{ spotifyId: string; title: string; artist: string }>
    ) => Promise<Map<string, { album: string; albumId: string }>>;
    parseEmbedTrackRows: (playlistId: string, html: string) => SpotifyPlaylist | null;
    parseDurationLabelToMs: (label: string) => number;
    fetchPlaylistViaEmbedHtml: (playlistId: string) => Promise<SpotifyPlaylist | null>;
};

function getSvc(): SpotifyServiceTestHandle {
    return spotifyService as unknown as SpotifyServiceTestHandle;
}

describe("spotifyService branch coverage", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        const svc = getSvc();
        svc.anonymousToken = null;
        svc.tokenExpiry = 0;
        svc.tokenRefreshPromise = null;
        svc.lastTokenEndpointFailureLogAt = 0;
    });

    it("clears refresh promise when a shared token refresh rejects", async () => {
        const svc = getSvc();
        jest.spyOn(svc, "performTokenRefresh").mockRejectedValueOnce(new Error("refresh boom"));

        await expect(svc.getAnonymousToken()).rejects.toThrow("refresh boom");
        expect(svc.tokenRefreshPromise).toBeNull();
    });

    it("logs endpoint status codes when token endpoint returns HTTP errors", async () => {
        const svc = getSvc();
        mockAxiosGet
            .mockRejectedValueOnce({ response: { status: 429 } })
            .mockRejectedValueOnce({ response: { status: 503 } });

        const token = await svc.performTokenRefresh();

        expect(token).toBeNull();
        expect(mockLoggerDebug).toHaveBeenCalledWith("Spotify: Token endpoint failed (429)");
        expect(mockLoggerDebug).toHaveBeenCalledWith("Spotify: Token endpoint failed (503)");
        expect(mockLoggerWarn).toHaveBeenCalled();
    });

    it("parses play.spotify.com and querystring URL formats", () => {
        expect(
            spotifyService.parseUrl("https://play.spotify.com/playlist/37i9dQZF1DX4dyzvuaRJ0n?si=abc")
        ).toEqual({
            type: "playlist",
            id: "37i9dQZF1DX4dyzvuaRJ0n",
        });

        expect(
            spotifyService.parseUrl("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?utm_source=test")
        ).toEqual({
            type: "track",
            id: "4uLU6hMCjMI75M1A2tKUQC",
        });

        expect(
            spotifyService.parseUrl("spotify:playlist:37i9dQZF1DX4dyzvuaRJ0n")
        ).toEqual({
            type: "playlist",
            id: "37i9dQZF1DX4dyzvuaRJ0n",
        });
    });

    it("handles malformed Spotify ids by extracting only alphanumeric prefix", () => {
        expect(
            spotifyService.parseUrl("https://open.spotify.com/album/abc123___bad")
        ).toEqual({ type: "album", id: "abc123" });
    });

    it("throws for track URLs passed into getPlaylist", async () => {
        await expect(
            spotifyService.getPlaylist("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")
        ).rejects.toThrow("Expected playlist URL, got track");
    });

    it("extracts Apollo cache tracks using album object id fallback", () => {
        const extracted = getSvc().extractTracksFromApolloCache(
            `<script>window.__APOLLO_STATE__ = {"Track:":{"id":"track-id-fallback","albumOfTrack":{"name":"Album Obj","id":"album-id-only"}}}</script>`
        );

        expect(extracted).toEqual([
            {
                trackId: "track-id-fallback",
                albumName: "Album Obj",
                albumId: "album-id-only",
            },
        ]);
    });

    it("scrapes albums from __NEXT_DATA__ playlistV2 path with itemV2 fallbacks", async () => {
        const nextData = JSON.stringify({
            props: {
                pageProps: {
                    state: {
                        data: {
                            playlistV2: {
                                content: {
                                    items: [
                                        {
                                            uid: "uid-track-1",
                                            itemV2: {
                                                data: {
                                                    albumOfTrack: {
                                                        name: "Album V2",
                                                        uri: "spotify:album:album-v2",
                                                    },
                                                },
                                            },
                                        },
                                    ],
                                },
                            },
                        },
                    },
                },
            },
        });

        mockAxiosGet.mockResolvedValueOnce({
            data: `<html><script id="__NEXT_DATA__" type="application/json">${nextData}</script></html>`,
        });

        const albums = await getSvc().scrapePlaylistPageForAlbums("playlist-v2");
        expect(albums.get("uid-track-1")).toEqual({ album: "Album V2", albumId: "album-v2" });
    });

    it("handles track-page scraping branches for short og payloads and trackUnion data", async () => {
        const timeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((handler: Parameters<typeof setTimeout>[0]) => {
                if (typeof handler === "function") {
                    handler();
                }
                return 0 as unknown as ReturnType<typeof setTimeout>;
            }) as typeof setTimeout);

        const nextData = JSON.stringify({
            props: {
                pageProps: {
                    state: {
                        data: {
                            trackUnion: {
                                album: {
                                    title: "TrackUnion Album",
                                    id: "album-trackunion",
                                },
                            },
                        },
                    },
                },
            },
        });

        mockAxiosGet
            .mockResolvedValueOnce({ data: `<meta property="og:description" content="Artist · Album A · Song A · 2024">` })
            .mockResolvedValueOnce({
                data: `<script id="__NEXT_DATA__" type="application/json">${nextData}</script>`,
            });

        const tracks = [
            { spotifyId: "track-a", title: "A", artist: "Artist A" },
            { spotifyId: "track-a", title: "A duplicate", artist: "Artist A" },
            { spotifyId: "track-b", title: "B", artist: "Artist B" },
        ];

        const albums = await getSvc().scrapeTrackPagesForAlbums(tracks);
        expect(albums.get("track-a")).toEqual({ album: "Album A", albumId: "" });
        expect(albums.get("track-b")).toEqual({
            album: "TrackUnion Album",
            albumId: "album-trackunion",
        });

        timeoutSpy.mockRestore();
    });

    it("resolves Deezer fallback with null results and non-Error failures", async () => {
        mockDeezerTrackAlbum
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce("rate limited");

        const albums = await getSvc().resolveAlbumsViaDeezer([
            { spotifyId: "d-1", title: "T1", artist: "A1" },
            { spotifyId: "d-2", title: "T2", artist: "A2" },
        ]);

        expect(albums.size).toBe(0);
    });

    it("logs non-Error failures during track-page scraping and keeps processing", async () => {
        const timeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((handler: Parameters<typeof setTimeout>[0]) => {
                if (typeof handler === "function") {
                    handler();
                }
                return 0 as unknown as ReturnType<typeof setTimeout>;
            }) as typeof setTimeout);

        mockAxiosGet
            .mockRejectedValueOnce("network-string-error")
            .mockResolvedValueOnce({
                data: `<meta property="og:description" content="Artist · Album B · Song B · 2024">`,
            });

        const albums = await getSvc().scrapeTrackPagesForAlbums([
            { spotifyId: "track-fail", title: "Fail", artist: "Artist F" },
            { spotifyId: "track-pass", title: "Pass", artist: "Artist P" },
        ]);

        expect(albums.get("track-pass")).toEqual({ album: "Album B", albumId: "" });
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[Spotify Track Scraper] Failed for track track-fail: network-string-error"
        );

        timeoutSpy.mockRestore();
    });

    it("skips duplicate Deezer ids and enforces 50-track resolution cap", async () => {
        const tracks = Array.from({ length: 52 }, (_, idx) => ({
            spotifyId: idx === 1 ? "dup-id" : idx === 0 ? "dup-id" : `sp-${idx}`,
            title: `Track ${idx}`,
            artist: `Artist ${idx}`,
        }));

        mockDeezerTrackAlbum.mockResolvedValue({ albumName: "Album X", albumId: 123 });

        const albums = await getSvc().resolveAlbumsViaDeezer(tracks);

        expect(mockDeezerTrackAlbum).toHaveBeenCalledTimes(49);
        expect(albums.has("sp-50")).toBe(false);
        expect(albums.has("sp-51")).toBe(false);
        expect(albums.has("dup-id")).toBe(true);
    });

    it("uses unknown metadata fallbacks when embed row metadata is absent", () => {
        const parsed = getSvc().parseEmbedTrackRows(
            "rows-no-metadata",
            `<li data-testid="tracklist-row-0"><h3>Only Song</h3><h4>Only Artist</h4></li>`
        );

        expect(parsed).toEqual(
            expect.objectContaining({
                name: "Unknown Playlist",
                owner: "Unknown",
                imageUrl: null,
                tracks: [expect.objectContaining({ durationMs: 0 })],
            })
        );
    });

    it("falls back to unknown playlist/owner when metadata strips to empty text", () => {
        const parsed = getSvc().parseEmbedTrackRows(
            "rows-empty-metadata",
            `<span>&nbsp;</span><span>·</span><span>&nbsp;</span><li data-testid="tracklist-row-0"><h3>Song</h3><h4>Artist</h4></li>`
        );

        expect(parsed).toEqual(
            expect.objectContaining({
                name: "Unknown Playlist",
                owner: "Unknown",
            })
        );
    });

    it("maps search playlists with owner/image/trackCount defaults on initial success", async () => {
        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-search-defaults"))
            .mockResolvedValueOnce({
                data: {
                    playlists: {
                        items: [
                            {
                                id: "search-defaults",
                                name: "Defaulted Search",
                                description: "",
                                owner: {},
                                images: [],
                                tracks: {},
                            },
                        ],
                    },
                },
            });

        const results = await spotifyService.searchPlaylists("defaults", 2);
        expect(results).toEqual([
            {
                id: "search-defaults",
                name: "Defaulted Search",
                description: null,
                owner: "Unknown",
                imageUrl: null,
                trackCount: 0,
            },
        ]);
    });

    it("maps search retry response with owner/image/trackCount defaults", async () => {
        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-old-retry-defaults"))
            .mockRejectedValueOnce({ response: { status: 401 } })
            .mockResolvedValueOnce(makeTokenResponse("token-new-retry-defaults"))
            .mockResolvedValueOnce({
                data: {
                    playlists: {
                        items: [
                            {
                                id: "retry-defaults",
                                name: "Retry Defaults",
                                description: "",
                                owner: {},
                                images: [],
                                tracks: {},
                            },
                        ],
                    },
                },
            });

        const results = await spotifyService.searchPlaylists("retry-defaults", 2);
        expect(results).toEqual([
            {
                id: "retry-defaults",
                name: "Retry Defaults",
                description: null,
                owner: "Unknown",
                imageUrl: null,
                trackCount: 0,
            },
        ]);
    });

    it("maps category and categories success branches with fallback values", async () => {
        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-category-defaults"))
            .mockResolvedValueOnce({
                data: {
                    playlists: {
                        items: [
                            {
                                id: "cat-default",
                                name: "Category Default",
                                description: "",
                                owner: {},
                                images: [],
                                tracks: {},
                            },
                        ],
                    },
                },
            })
            .mockResolvedValueOnce({
                data: {
                    categories: {
                        items: [
                            {
                                id: "cat-1",
                                name: "Category One",
                                icons: [],
                            },
                        ],
                    },
                },
            });

        const categoryPlaylists = await spotifyService.getCategoryPlaylists("cat", 5);
        const categories = await spotifyService.getCategories(5);

        expect(categoryPlaylists).toEqual([
            {
                id: "cat-default",
                name: "Category Default",
                description: null,
                owner: "Spotify",
                imageUrl: null,
                trackCount: 0,
            },
        ]);
        expect(categories).toEqual([{ id: "cat-1", name: "Category One", imageUrl: null }]);
    });

    it("maps API playlist defaults for sparse payload fields", async () => {
        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-sparse"))
            .mockResolvedValueOnce({
                data: {
                    id: "playlist-sparse",
                    name: "Sparse Playlist",
                    description: null,
                    owner: {},
                    images: [],
                    tracks: {
                        total: 3,
                        items: [
                            { track: null },
                            {
                                track: {
                                    id: "track-sparse-1",
                                    name: "Sparse Track",
                                    artists: [],
                                    album: {
                                        id: "album-sparse",
                                        name: "",
                                        images: [],
                                    },
                                    duration_ms: 0,
                                    track_number: 0,
                                    preview_url: undefined,
                                    external_ids: {},
                                },
                            },
                        ],
                    },
                },
            })
            .mockResolvedValueOnce({ data: "<html></html>" })
            .mockResolvedValueOnce({ data: "<html><meta property=\"og:description\" content=\"x · Unknown Album · y\"></html>" });

        mockDeezerTrackAlbum.mockResolvedValueOnce({
            albumName: "Recovered Via Deezer",
            albumId: 7,
        });

        const playlist = await spotifyService.getPlaylist("playlist-sparse");

        expect(playlist).not.toBeNull();
        if (!playlist) {
            throw new Error("Expected playlist");
        }
        expect(playlist.owner).toBe("Unknown");
        expect(playlist.imageUrl).toBeNull();
        expect(playlist.trackCount).toBe(3);
        expect(playlist.tracks).toHaveLength(1);
        expect(playlist.tracks[0]).toEqual(
            expect.objectContaining({
                artist: "Unknown Artist",
                isrc: null,
                previewUrl: null,
                coverUrl: null,
                album: "Recovered Via Deezer",
                albumId: "deezer:7",
            })
        );
    });

    it("parses embed rows with metadata and image HTML entities", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: `
                <html>
                    <div style="--image-src:url(&#x27;https://images.example/cover&amp;size=300&#x27;)"></div>
                    <span>My &amp; Playlist</span><span>·</span><span>Owner &amp; Co</span>
                    <li data-testid="tracklist-row-0">
                        <h3>Song &amp; One</h3>
                        <h4><span>E</span>Artist &#39;One&#39;</h4>
                        <div data-testid="duration-cell">03:05</div>
                    </li>
                </html>
            `,
        });

        const playlist = await getSvc().fetchPlaylistViaEmbedHtml("embed-entities");

        expect(playlist).toEqual({
            id: "embed-entities",
            name: "My & Playlist",
            description: null,
            owner: "Owner & Co",
            imageUrl: "https://images.example/cover&size=300'",
            trackCount: 1,
            tracks: [
                expect.objectContaining({
                    title: "Song & One",
                    artist: "Artist 'One'",
                    durationMs: 185000,
                }),
            ],
            isPublic: true,
        });
    });

    it("returns null from embed fallback when rows exist but missing title/artist pairs", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: `
                <html>
                    <li data-testid="tracklist-row-0"><h3>Title Only</h3></li>
                    <li data-testid="tracklist-row-1"><h4>Artist Only</h4></li>
                </html>
            `,
        });

        const playlist = await getSvc().fetchPlaylistViaEmbedHtml("embed-invalid-rows");
        expect(playlist).toBeNull();
    });

    it("falls back from featured API empty payload into search and enforces limit", async () => {
        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-featured-branch"))
            .mockResolvedValueOnce({ data: { playlists: { items: [] } } })
            .mockResolvedValueOnce({
                data: {
                    playlists: {
                        items: [
                            {
                                id: "f1",
                                name: "One",
                                description: null,
                                owner: { display_name: "Spotify" },
                                images: [],
                                tracks: { total: 10 },
                            },
                            {
                                id: "f2",
                                name: "Two",
                                description: null,
                                owner: { display_name: "Spotify Editorial" },
                                images: [],
                                tracks: { total: 11 },
                            },
                        ],
                    },
                },
            });

        const featured = await spotifyService.getFeaturedPlaylists(1);

        expect(featured).toHaveLength(1);
        expect(featured[0].id).toBe("f1");
    });

    it("returns 0 duration for invalid and unsupported duration labels", () => {
        const svc = getSvc();

        expect(svc.parseDurationLabelToMs("03:05")).toBe(185000);
        expect(svc.parseDurationLabelToMs("-1:30")).toBe(0);
        expect(svc.parseDurationLabelToMs("aa:30")).toBe(0);
        expect(svc.parseDurationLabelToMs("1:2:3:4")).toBe(0);
    });

    it("skips embed rows when stripped title or artist text is empty", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: `
                <html>
                    <li data-testid="tracklist-row-0">
                        <h3>&nbsp;</h3>
                        <h4>Artist Present</h4>
                    </li>
                    <li data-testid="tracklist-row-1">
                        <h3>Title Present</h3>
                        <h4><span>E</span>&nbsp;</h4>
                    </li>
                </html>
            `,
        });

        const playlist = await getSvc().fetchPlaylistViaEmbedHtml("embed-empty-fields");
        expect(playlist).toBeNull();
    });

    it("returns null when embed fetch throws a network error", async () => {
        mockAxiosGet.mockRejectedValueOnce(new Error("socket hang up"));

        const playlist = await getSvc().fetchPlaylistViaEmbedHtml("embed-network-fail");

        expect(playlist).toBeNull();
        expect(mockLoggerError).toHaveBeenCalledWith("Spotify embed HTML error:", "socket hang up");
    });

    it("returns [] for categories and category playlists on API failures", async () => {
        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-cat-fail"))
            .mockRejectedValueOnce(new Error("category playlist fail"))
            .mockRejectedValueOnce(new Error("categories fail"));

        const categoryPlaylists = await spotifyService.getCategoryPlaylists("focus", 3);
        const categories = await spotifyService.getCategories(3);

        expect(categoryPlaylists).toEqual([]);
        expect(categories).toEqual([]);
        expect(mockLoggerError).toHaveBeenCalled();
    });
});
