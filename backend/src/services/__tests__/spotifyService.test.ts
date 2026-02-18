import axios from "axios";
import { spotifyService } from "../spotify";
import { deezerService } from "../deezer";

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
const mockDeezerTrackAlbum = deezerService.getTrackAlbum as jest.Mock;

function makeTokenResponse(token: string) {
    return {
        data: {
            accessToken: token,
        },
    };
}

describe("spotifyService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        const svc = spotifyService as any;
        svc.anonymousToken = null;
        svc.tokenExpiry = 0;
        svc.tokenRefreshPromise = null;
    });

    it("coalesces concurrent anonymous token refreshes", async () => {
        const svc = spotifyService as any;
        const refreshSpy = jest.spyOn(svc, "performTokenRefresh");

        let resolveToken: (value: string | null) => void = () => undefined;
        const pending = new Promise<string | null>((resolve) => {
            resolveToken = resolve;
        });
        refreshSpy.mockReturnValue(pending);

        const first = svc.getAnonymousToken();
        const second = svc.getAnonymousToken();

        expect(refreshSpy).toHaveBeenCalledTimes(1);

        resolveToken("shared-token");
        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult).toBe("shared-token");
        expect(secondResult).toBe("shared-token");

        refreshSpy.mockRestore();
    });

    it("returns cached anonymous token when not expired", async () => {
        const svc = spotifyService as any;
        svc.anonymousToken = "cached-token";
        svc.tokenExpiry = Date.now() + 10 * 60 * 1000;
        const refreshSpy = jest.spyOn(svc, "performTokenRefresh");

        await expect(svc.getAnonymousToken()).resolves.toBe("cached-token");
        expect(refreshSpy).not.toHaveBeenCalled();

        refreshSpy.mockRestore();
    });

    it("tries alternate token endpoints before failing", async () => {
        const svc = spotifyService as any;
        mockAxiosGet
            .mockRejectedValueOnce(new Error("transport down"))
            .mockResolvedValueOnce(makeTokenResponse("fallback-token"));

        const token = await svc.performTokenRefresh();

        expect(mockAxiosGet).toHaveBeenCalledTimes(2);
        expect(token).toBe("fallback-token");
        expect(svc.anonymousToken).toBe("fallback-token");
    });

    it("returns null when all token endpoints fail", async () => {
        const svc = spotifyService as any;
        mockAxiosGet.mockRejectedValue(new Error("all down"));

        const token = await svc.performTokenRefresh();

        expect(mockAxiosGet).toHaveBeenCalledTimes(2);
        expect(token).toBeNull();
    });

    it("refreshes a token when the cached token is inside the safety window", async () => {
        const svc = spotifyService as any;
        svc.anonymousToken = "cached-token";
        svc.tokenExpiry = Date.now() + 30 * 1000;
        mockAxiosGet.mockResolvedValueOnce(makeTokenResponse("refreshed-token"));

        const token = await svc.getAnonymousToken();

        expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        expect(token).toBe("refreshed-token");
    });

    it("retries token acquisition after a concurrent refresh attempt returns null", async () => {
        const svc = spotifyService as any;
        mockAxiosGet
            .mockRejectedValueOnce(new Error("transport down"))
            .mockRejectedValueOnce(new Error("embed down"))
            .mockResolvedValueOnce(makeTokenResponse("recovered-token"));

        const [first, second] = await Promise.all([
            svc.getAnonymousToken(),
            svc.getAnonymousToken(),
        ]);

        expect(first).toBeNull();
        expect(second).toBeNull();
        expect(mockAxiosGet).toHaveBeenCalledTimes(2);

        const third = await svc.getAnonymousToken();
        expect(third).toBe("recovered-token");
        expect(mockAxiosGet).toHaveBeenCalledTimes(3);
    });

    it("falls back to the secondary token endpoint when the first does not return an access token", async () => {
        const svc = spotifyService as any;
        mockAxiosGet
            .mockResolvedValueOnce({ data: {} })
            .mockResolvedValueOnce(makeTokenResponse("fallback-token"));

        const token = await svc.performTokenRefresh();

        expect(mockAxiosGet).toHaveBeenCalledTimes(2);
        expect(token).toBe("fallback-token");
    });

    it("parses Spotify URLs and returns null for unsupported formats", () => {
        expect(
            spotifyService.parseUrl(
                "https://open.spotify.com/playlist/37i9dQZF1DX4dyzvuaRJ0n"
            )
        ).toEqual({
            type: "playlist",
            id: "37i9dQZF1DX4dyzvuaRJ0n",
        });
        expect(
            spotifyService.parseUrl("spotify:album:6JWc4iAiJ9FjyK0B59ABb4")
        ).toEqual({
            type: "album",
            id: "6JWc4iAiJ9FjyK0B59ABb4",
        });
        expect(
            spotifyService.parseUrl("spotify:track:4uLU6hMCjMI75M1A2tKUQC")
        ).toEqual({
            type: "track",
            id: "4uLU6hMCjMI75M1A2tKUQC",
        });
        expect(spotifyService.parseUrl("https://example.com/not-spotify")).toBeNull();
    });

    it("rejects non-playlist URLs passed to getPlaylist", async () => {
        await expect(
            spotifyService.getPlaylist("https://open.spotify.com/album/6JWc4iAiJ9FjyK0B59ABb4")
        ).rejects.toThrow("Expected playlist URL, got album");
    });

    it("fetches playlist via anonymous API and enriches unknown albums from page scrape", async () => {
        const nextData = JSON.stringify({
            props: {
                pageProps: {
                    state: {
                        data: {
                            entity: {
                                trackList: [
                                    {
                                        track: {
                                            uri: "spotify:track:track-1",
                                            album: {
                                                name: "Recovered Album",
                                                uri: "spotify:album:album-1",
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    },
                },
            },
        });
        const playlistHtml = `<html><script id="__NEXT_DATA__" type="application/json">${nextData}</script></html>`;

        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-1"))
            .mockResolvedValueOnce({
                data: {
                    id: "playlist-1",
                    name: "Recovered Playlist",
                    description: "desc",
                    owner: { display_name: "Owner" },
                    images: [{ url: "https://images.example/p.jpg" }],
                    public: true,
                    tracks: {
                        total: 1,
                        items: [
                            {
                                track: {
                                    id: "track-1",
                                    name: "Track One",
                                    artists: [{ id: "artist-1", name: "Artist One" }],
                                    album: {
                                        id: "album-empty",
                                        name: "Unknown Album",
                                        images: [{ url: "https://images.example/a.jpg" }],
                                    },
                                    duration_ms: 123000,
                                    track_number: 1,
                                    preview_url: null,
                                    external_ids: { isrc: "ISRC1" },
                                },
                            },
                        ],
                    },
                },
            })
            .mockResolvedValueOnce({ data: playlistHtml });

        const playlist = await spotifyService.getPlaylist(
            "https://open.spotify.com/playlist/playlist-1"
        );

        expect(playlist).not.toBeNull();
        expect(playlist!.trackCount).toBe(1);
        expect(playlist!.tracks[0].album).toBe("Recovered Album");
        expect(playlist!.tracks[0].albumId).toBe("album-1");
    });

    it("falls back to embed HTML when playlist API fails", async () => {
        const embedData = JSON.stringify({
            props: {
                pageProps: {
                    state: {
                        data: {
                            entity: {
                                name: "Embed Playlist",
                                description: "from embed",
                                trackList: [
                                    {
                                        title: "Embed Track",
                                        subtitle: "Embed Artist, Secondary Artist",
                                        uri: "spotify:track:embed-track",
                                        albumName: "Embed Album",
                                        duration: 99000,
                                    },
                                ],
                            },
                        },
                    },
                },
            },
        });
        const embedHtml = `<html><script id="__NEXT_DATA__" type="application/json">${embedData}</script></html>`;

        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-embed"))
            .mockRejectedValueOnce(new Error("primary API failed"))
            .mockResolvedValueOnce({ data: embedHtml });

        const playlist = await spotifyService.getPlaylist("playlist-embed");

        expect(playlist).not.toBeNull();
        expect(playlist!.name).toBe("Embed Playlist");
        expect(playlist!.tracks).toHaveLength(1);
        expect(playlist!.tracks[0].artist).toBe("Embed Artist");
        expect(playlist!.tracks[0].album).toBe("Embed Album");
    });

    it("returns featured playlists from official API when available", async () => {
        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-featured"))
            .mockResolvedValueOnce({
                data: {
                    playlists: {
                        items: [
                            {
                                id: "feat-1",
                                name: "Top Mix",
                                description: "top",
                                owner: { display_name: "Spotify" },
                                images: [{ url: "https://images.example/feat.jpg" }],
                                tracks: { total: 42 },
                            },
                        ],
                    },
                },
            });

        const featured = await spotifyService.getFeaturedPlaylists(5);

        expect(featured).toEqual([
            {
                id: "feat-1",
                name: "Top Mix",
                description: "top",
                owner: "Spotify",
                imageUrl: "https://images.example/feat.jpg",
                trackCount: 42,
            },
        ]);
    });

    it("falls back to search for featured playlists when official endpoint fails", async () => {
        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-fallback"))
            .mockRejectedValueOnce(new Error("featured endpoint down"))
            .mockResolvedValueOnce({
                data: {
                    playlists: {
                        items: [
                            {
                                id: "search-1",
                                name: "Today's Top Hits",
                                description: "desc",
                                owner: { display_name: "Spotify" },
                                images: [{ url: "https://images.example/s1.jpg" }],
                                tracks: { total: 50 },
                            },
                            null,
                        ],
                    },
                },
            })
            .mockResolvedValueOnce({
                data: {
                    playlists: {
                        items: [
                            {
                                id: "search-2",
                                name: "Hot Hits",
                                description: null,
                                owner: { display_name: "Spotify Editorial" },
                                images: [],
                                tracks: { total: 40 },
                            },
                        ],
                    },
                },
            })
            .mockResolvedValueOnce({
                data: {
                    playlists: {
                        items: [
                            {
                                id: "search-3",
                                name: "Viral Hits",
                                description: null,
                                owner: { display_name: "Another Owner" },
                                images: [],
                                tracks: { total: 39 },
                            },
                        ],
                    },
                },
            });

        const featured = await spotifyService.getFeaturedPlaylists(10);

        expect(featured.map((p) => p.id)).toEqual(["search-1", "search-2"]);
    });

    it("returns category playlists and category list mappings", async () => {
        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-cat"))
            .mockResolvedValueOnce({
                data: {
                    playlists: {
                        items: [
                            {
                                id: "cat-play-1",
                                name: "Category Playlist",
                                description: null,
                                owner: { display_name: "Spotify" },
                                images: [{ url: "https://images.example/cat.jpg" }],
                                tracks: { total: 12 },
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
                                id: "pop",
                                name: "Pop",
                                icons: [{ url: "https://images.example/pop.jpg" }],
                            },
                        ],
                    },
                },
            });

        const categoryPlaylists = await spotifyService.getCategoryPlaylists("pop", 10);
        const categories = await spotifyService.getCategories(10);

        expect(categoryPlaylists).toEqual([
            {
                id: "cat-play-1",
                name: "Category Playlist",
                description: null,
                owner: "Spotify",
                imageUrl: "https://images.example/cat.jpg",
                trackCount: 12,
            },
        ]);
        expect(categories).toEqual([
            {
                id: "pop",
                name: "Pop",
                imageUrl: "https://images.example/pop.jpg",
            },
        ]);
    });

    it("retries playlist search after a 401 by refreshing the anonymous token", async () => {
        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-old"))
            .mockRejectedValueOnce({ response: { status: 401 } })
            .mockResolvedValueOnce(makeTokenResponse("token-new"))
            .mockResolvedValueOnce({
                data: {
                    playlists: {
                        items: [
                            {
                                id: "retry-1",
                                name: "Retry Playlist",
                                description: "retried",
                                owner: { display_name: "Spotify" },
                                images: [{ url: "https://images.example/retry.jpg" }],
                                tracks: { total: 21 },
                            },
                        ],
                    },
                },
            });

        const results = await spotifyService.searchPlaylists("retry me", 5);

        expect(results).toEqual([
            {
                id: "retry-1",
                name: "Retry Playlist",
                description: "retried",
                owner: "Spotify",
                imageUrl: "https://images.example/retry.jpg",
                trackCount: 21,
            },
        ]);
    });

    it("retries playlist search on 401 and returns [] when the retry request also fails", async () => {
        const svc = spotifyService as any;
        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-old"))
            .mockRejectedValueOnce({ response: { status: 401 } })
            .mockResolvedValueOnce(makeTokenResponse("token-new"))
            .mockRejectedValueOnce({ response: { status: 502 } });

        const results = await svc.searchPlaylists("transient auth issue", 5);

        expect(results).toEqual([]);
        expect(mockAxiosGet).toHaveBeenCalledTimes(4);
        expect(svc.anonymousToken).toBe("token-new");
    });

    it("returns [] when playlist search fails with non-401 error", async () => {
        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-search"))
            .mockRejectedValueOnce({ response: { status: 500 }, message: "server down" });

        const results = await spotifyService.searchPlaylists("chill", 3);

        expect(results).toEqual([]);
    });

    it("filters null playlist search results and still returns valid rows", async () => {
        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-filtered"))
            .mockResolvedValueOnce({
                data: {
                    playlists: {
                        items: [
                            null,
                            {
                                id: "search-filter-1",
                                name: "Filtered Playlist",
                                description: "test",
                                owner: { display_name: "Curator" },
                                images: [{ url: "https://images.example/search-filtered.jpg" }],
                                tracks: { total: 11 },
                            },
                        ],
                    },
                },
            });

        const results = await spotifyService.searchPlaylists("filter", 5);

        expect(results).toEqual([
            {
                id: "search-filter-1",
                name: "Filtered Playlist",
                description: "test",
                owner: "Curator",
                imageUrl: "https://images.example/search-filtered.jpg",
                trackCount: 11,
            },
        ]);
    });

    it("returns [] when token refresh after 401 also fails", async () => {
        const svc = spotifyService as any;
        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-old"))
            .mockRejectedValueOnce({ response: { status: 401 } })
            .mockRejectedValueOnce(new Error("token refresh down"));

        const results = await svc.searchPlaylists("retry failure", 5);

        expect(results).toEqual([]);
        expect(mockAxiosGet).toHaveBeenCalledTimes(4);
    });

    it("gracefully returns empty when Apollo cache payload cannot be parsed", () => {
        const html = `<script>window.__APOLLO_STATE__ = {"Track:spotify:track:track-xyz":{"album":"Album:spotify:album:album-xyz"},"Album:spotify:album:album-xyz":{"name":"Apollo Album"}};</script>`;

        const extracted = (spotifyService as any).extractTracksFromApolloCache(html);

        expect(extracted).toEqual([]);
    });

    it("extracts tracks from Apollo cache when structure is valid", () => {
        const html = `<script>window.__APOLLO_STATE__ = {"Track:spotify:track:track-123":{"album":"Album:spotify:album:album-123"},"Album:spotify:album:album-123":{"name":"Apollo Album"}}<\/script>`;

        const extracted = (spotifyService as any).extractTracksFromApolloCache(html);

        expect(extracted).toEqual([
            {
                trackId: "track-123",
                albumName: "Apollo Album",
                albumId: "album-123",
            },
        ]);
    });

    it("extracts tracks from Apollo cache when album data is nested as object", () => {
        const html = `<script>window.__APOLLO_STATE__ = {"Track:spotify:track:track-object":{"albumOfTrack":{"name":"Apollo Object Album","uri":"spotify:album:album-object"}}}<\/script>`;

        const extracted = (spotifyService as any).extractTracksFromApolloCache(html);

        expect(extracted).toEqual([
            {
                trackId: "track-object",
                albumName: "Apollo Object Album",
                albumId: "album-object",
            },
        ]);
    });

    it("scrapes playlist pages via Apollo fallback when __NEXT_DATA__ is missing", async () => {
        const svc = spotifyService as any;
        const apolloState = {
            "Track:spotify:track:apollo-track": {
                albumOfTrack: {
                    name: "Apollo Album",
                    uri: "spotify:album:apollo-album",
                },
            },
        };
        const html = `<html><script>window.__APOLLO_STATE__ = ${JSON.stringify(apolloState)}</script></html>`;
        mockAxiosGet.mockResolvedValueOnce({ data: html });

        const albums = await svc.scrapePlaylistPageForAlbums("apollo-playlist");

        expect(albums.get("apollo-track")).toEqual({
            album: "Apollo Album",
            albumId: "apollo-album",
        });
    });

    it("scrapes playlist pages via HTML row fallback when structured data is absent", async () => {
        const svc = spotifyService as any;
        const html = `
            <div role="row" aria-rowindex="1">
                <a href="/track/htmltrack123">Track Link</a>
                <div aria-colindex="3">
                    <a href="/album/htmlalbum456">Html Album</a>
                </div>
            </div>
            <div data-testid="bottom-sentinel"></div>
        `;
        mockAxiosGet.mockResolvedValueOnce({ data: html });

        const albums = await svc.scrapePlaylistPageForAlbums("html-playlist");

            expect(albums.get("htmltrack123")).toEqual({
                album: "Html Album",
                albumId: "htmlalbum456",
            });
        });

    it("uses tracks.items from embed payload when trackList is missing", async () => {
        const embedData = JSON.stringify({
            props: {
                pageProps: {
                    state: {
                        data: {
                            name: "Tracks Items Playlist",
                            ownerV2: {
                                data: {
                                    name: "Owner V2",
                                },
                            },
                            images: {
                                items: [
                                    {
                                        sources: [{ url: "https://images.example/playlist-owner.jpg" }],
                                    },
                                ],
                            },
                            tracks: {
                                items: [
                                    {
                                        track: {
                                            uri: "spotify:track:track-items",
                                            name: "Track Items",
                                            artists: [{ id: "artist-1", name: "Artist One" }],
                                            album: {
                                                name: "Album Items",
                                                uri: "spotify:album:album-items",
                                                images: [{ url: "https://images.example/album-items.jpg" }],
                                            },
                                            duration: 120000,
                                        },
                                    },
                                ],
                            },
                        },
                    },
                },
            },
        });
        const embedHtml = `<html><script id="__NEXT_DATA__" type="application\/json">${embedData}</script></html>`;

        mockAxiosGet.mockResolvedValueOnce({ data: embedHtml });

        const playlist = await (spotifyService as any).fetchPlaylistViaEmbedHtml("embed-tracks-items");

        expect(playlist).toEqual({
            id: "embed-tracks-items",
            name: "Tracks Items Playlist",
            description: null,
            owner: "Owner V2",
            imageUrl: "https://images.example/playlist-owner.jpg",
            trackCount: 1,
            tracks: [
                {
                    spotifyId: "track-items",
                    title: "Track Items",
                    artist: "Artist One",
                    artistId: "artist-1",
                    album: "Album Items",
                    albumId: "album-items",
                    isrc: null,
                    durationMs: 120000,
                    trackNumber: 0,
                    previewUrl: null,
                    coverUrl: "https://images.example/album-items.jpg",
                },
            ],
            isPublic: true,
        });
    });

    it("scrapes track pages and extracts album names from og metadata", async () => {
        const timeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((cb: (...args: any[]) => void) => {
                cb();
                return 0 as any;
            }) as any);

        mockAxiosGet
            .mockResolvedValueOnce({
                data: `<meta property="og:description" content="Artist One · Album One · Track One · 2020">`,
            })
            .mockResolvedValueOnce({
                data: `<meta property="og:description" content="Artist Two · Album Two · Track Two · 2021">`,
            });

        const albums = await (spotifyService as any).scrapeTrackPagesForAlbums([
            { spotifyId: "track-1", title: "Track One", artist: "Artist One" },
            { spotifyId: "track-2", title: "Track Two", artist: "Artist Two" },
        ]);

        expect(albums.get("track-1")).toEqual({
            album: "Album One",
            albumId: "",
        });
        expect(albums.get("track-2")).toEqual({
            album: "Album Two",
            albumId: "",
        });
        expect(mockAxiosGet).toHaveBeenCalledWith(
            "https://open.spotify.com/track/track-1",
            expect.objectContaining({
                timeout: 10000,
            })
        );
        timeoutSpy.mockRestore();
    });

    it("scrapes track pages via __NEXT_DATA__ when og metadata is missing", async () => {
        const timeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((cb: (...args: any[]) => void) => {
                cb();
                return 0 as any;
            }) as any);

        const nextData = JSON.stringify({
            props: {
                pageProps: {
                    state: {
                        data: {
                            entity: {
                                album: {
                                    name: "Next Album",
                                    uri: "spotify:album:next-album",
                                },
                            },
                        },
                    },
                },
            },
        });

        mockAxiosGet.mockResolvedValueOnce({
            data: `<script id="__NEXT_DATA__" type="application/json">${nextData}</script>`,
        });

        const albums = await (spotifyService as any).scrapeTrackPagesForAlbums([
            { spotifyId: "next-track", title: "Next Track", artist: "Artist Next" },
        ]);

        expect(albums.get("next-track")).toEqual({
            album: "Next Album",
            albumId: "next-album",
        });
        timeoutSpy.mockRestore();
    });

    it("resolves albums through Deezer fallback and skips failures", async () => {
        mockDeezerTrackAlbum
            .mockResolvedValueOnce({ albumName: "Deezer Album", albumId: 42 })
            .mockRejectedValueOnce(new Error("rate limited"));

        const albums = await (spotifyService as any).resolveAlbumsViaDeezer([
            { spotifyId: "sp-1", title: "Track A", artist: "Artist A" },
            { spotifyId: "sp-2", title: "Track B", artist: "Artist B" },
        ]);

        expect(albums.get("sp-1")).toEqual({
            album: "Deezer Album",
            albumId: "deezer:42",
        });
        expect(albums.has("sp-2")).toBe(false);
    });

    it("returns null from embed parsing when __NEXT_DATA__ is missing", async () => {
        mockAxiosGet.mockResolvedValueOnce({ data: "<html>No data</html>" });

        const playlist = await (spotifyService as any).fetchPlaylistViaEmbedHtml(
            "embed-missing"
        );
        expect(playlist).toBeNull();
    });

    it("returns empty arrays when token acquisition fails for browse APIs", async () => {
        mockAxiosGet.mockRejectedValue(new Error("token endpoint down"));

        const search = await spotifyService.searchPlaylists("x", 3);
        const categories = await spotifyService.getCategories(3);
        const categoryPlaylists = await spotifyService.getCategoryPlaylists("pop", 3);
        const featured = await spotifyService.getFeaturedPlaylists(3);

        expect(search).toEqual([]);
        expect(categories).toEqual([]);
        expect(categoryPlaylists).toEqual([]);
        expect(featured).toEqual([]);
    });

    it("falls back to embed parsing when anonymous token cannot be acquired", async () => {
        mockAxiosGet
            .mockRejectedValueOnce(new Error("token down"))
            .mockRejectedValueOnce(new Error("token endpoint down"))
            .mockResolvedValueOnce({
                data: `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
                    props: { pageProps: {} },
                })}</script></html>`,
            })
            .mockRejectedValueOnce(new Error("token down"))
            .mockRejectedValueOnce(new Error("token endpoint down"))
            .mockResolvedValueOnce({
                data: `<html><script id="__NEXT_DATA__" type="application/json">{not valid json}</script></html>`,
            });

        const missingDataPlaylist = await spotifyService.getPlaylist("playlist-missing-data");
        const malformedPayloadPlaylist = await spotifyService.getPlaylist("playlist-invalid-json");

        expect(missingDataPlaylist).toEqual({
            id: "playlist-missing-data",
            name: "Unknown Playlist",
            description: null,
            owner: "Unknown",
            imageUrl: null,
            trackCount: 0,
            tracks: [],
            isPublic: true,
        });
        expect(malformedPayloadPlaylist).toBeNull();
    });

    it("handles invalid playlist page payloads without throwing", async () => {
        const svc = spotifyService as any;

        mockAxiosGet.mockResolvedValueOnce({
            data: `<html><script id="__NEXT_DATA__" type="application/json">{not valid json}</script></html>`,
        });

        const albums = await svc.scrapePlaylistPageForAlbums("playlist-invalid-next-data");
        const apolloTracks = svc.extractTracksFromApolloCache(
            `<script>window.__APOLLO_STATE__ = {not valid json}</script>`
        );

        expect(albums.size).toBe(0);
        expect(apolloTracks).toEqual([]);
    });

    it("enriches Unknown Album tracks in embed output from playlist page scraping", async () => {
        const nextData = JSON.stringify({
            props: {
                pageProps: {
                    state: {
                        data: {
                        entity: {
                            name: "Embed Playlist",
                            description: "from embed",
                            trackList: [
                                {
                                    uri: "spotify:track:htmltrack123",
                                    title: "Embed Track",
                                    subtitle: "Embed Artist",
                                    albumName: "Unknown Album",
                                    duration: 99000,
                                },
                                ],
                            },
                        },
                    },
                },
            },
        });
        const embedHtml = `<html><script id="__NEXT_DATA__" type="application/json">${nextData}</script></html>`;
        const playlistHtml = `
            <div role="row" aria-rowindex="1">
                <a href="/track/htmltrack123">Track Link</a>
                <div aria-colindex="3">
                    <a href="/album/htmlalbum456">Html Album</a>
                </div>
            </div>
            <div data-testid="bottom-sentinel"></div>
        `;

        mockAxiosGet
            .mockResolvedValueOnce({ data: embedHtml })
            .mockResolvedValueOnce({ data: playlistHtml });

        const playlist = await (spotifyService as any).fetchPlaylistViaEmbedHtml("embed-scrape-playlist");

        expect(playlist).not.toBeNull();
        expect(playlist!.tracks).toHaveLength(1);
        expect(playlist!.tracks[0].album).toBe("Html Album");
        expect(playlist!.tracks[0].albumId).toBe("htmlalbum456");
    });

    it("falls back to track-page scraping when playlist page scraping fails", async () => {
        const timeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((cb: (...args: any[]) => void) => {
                cb();
                return 0 as any;
            }) as any);

        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-unknown"))
            .mockResolvedValueOnce({
                data: {
                    id: "playlist-unknown",
                    name: "Unknown Album Playlist",
                    description: null,
                    owner: { display_name: "Owner" },
                    images: [{ url: "https://images.example/unknown.jpg" }],
                    public: true,
                    tracks: {
                        total: 1,
                        items: [
                            {
                                track: {
                                    id: "track-unknown",
                                    name: "Track One",
                                    artists: [{ id: "artist-1", name: "Artist One" }],
                                    album: {
                                        id: "album-empty",
                                        name: "Unknown Album",
                                        images: [{ url: "https://images.example/unknown-album.jpg" }],
                                    },
                                    duration_ms: 120000,
                                    track_number: 1,
                                    preview_url: null,
                                    external_ids: { isrc: "ISRC1" },
                                },
                            },
                        ],
                    },
                },
            })
            .mockRejectedValueOnce(new Error("playlist scrape failed"))
            .mockResolvedValueOnce({
                data: `<meta property="og:description" content="Artist One · Recovered Album · Track One · 2024">`,
            });

        const playlist = await spotifyService.getPlaylist("https://open.spotify.com/playlist/playlist-unknown");

        expect(playlist).not.toBeNull();
        expect(playlist!.tracks[0].album).toBe("Recovered Album");
        expect(playlist!.tracks[0].albumId).toBe("");

        timeoutSpy.mockRestore();
    });

    it("falls back to Deezer when embed parsing cannot determine album metadata", async () => {
        const timeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((cb: (...args: any[]) => void) => {
                cb();
                return 0 as any;
            }) as any);

        const embedData = JSON.stringify({
            props: {
                pageProps: {
                    state: {
                        data: {
                            entity: {
                                name: "Embed Deezer Playlist",
                                description: "deezer fallback",
                                ownerV2: {
                                    data: {
                                        name: "Owner",
                                    },
                                },
                                images: {
                                    items: [
                                        {
                                            sources: [{ url: "https://images.example/owner.jpg" }],
                                        },
                                    ],
                                },
                                trackList: [
                                    {
                                        uri: "spotify:track:embed-track",
                                        title: "Deezer Track",
                                        subtitle: "Deezer Artist",
                                        albumName: "Unknown Album",
                                        duration: 99000,
                                    },
                                ],
                            },
                        },
                    },
                },
            },
        });
        const embedHtml = `<html><script id="__NEXT_DATA__" type="application/json">${embedData}</script></html>`;

        mockAxiosGet
            .mockRejectedValueOnce(new Error("token down"))
            .mockRejectedValueOnce(new Error("token endpoint down"))
            .mockResolvedValueOnce({ data: embedHtml })
            .mockResolvedValueOnce({ data: "<html></html>" })
            .mockResolvedValueOnce({ data: "<html><meta property=\"og:description\" content=\"Deezer Artist · Unknown Album · Deezer Track · 2024\"></html>" });

        mockDeezerTrackAlbum.mockResolvedValueOnce({
            albumName: "Deezer Resolved Album",
            albumId: 99,
        });

        const playlist = await spotifyService.getPlaylist("https://open.spotify.com/playlist/playlist-deezer-fallback");

        expect(playlist).not.toBeNull();
        expect(playlist!.tracks[0].album).toBe("Deezer Resolved Album");
        expect(playlist!.tracks[0].albumId).toBe("deezer:99");

        timeoutSpy.mockRestore();
    });

    it("handles browse API failures including featured, category, and search fallback paths", async () => {
        const svc = spotifyService as any;

        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("search-token"))
            .mockRejectedValueOnce({ response: { status: 401 }, message: "expired" })
            .mockResolvedValueOnce(makeTokenResponse("search-token-2"))
            .mockRejectedValueOnce(new Error("retry search failed"));

        const retryResult = await svc.searchPlaylists("retry case", 5);
        expect(retryResult).toEqual([]);

        svc.anonymousToken = null;
        svc.tokenExpiry = 0;
        const searchSpy = jest
            .spyOn(svc, "searchPlaylists")
            .mockRejectedValue(new Error("search API down"));

        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("browse-token"))
            .mockRejectedValueOnce(new Error("featured failed"))
            .mockRejectedValueOnce(new Error("category playlists failed"))
            .mockRejectedValueOnce(new Error("categories failed"));

        try {
            const featured = await svc.getFeaturedPlaylists(5);
            const categoryPlaylists = await spotifyService.getCategoryPlaylists("pop", 5);
            const categories = await spotifyService.getCategories(5);

            expect(featured).toEqual([]);
            expect(categoryPlaylists).toEqual([]);
            expect(categories).toEqual([]);
        } finally {
            searchSpy.mockRestore();
        }
    });

    it("skips tracks without IDs and falls back to Deezer after unknown-album scraping failures", async () => {
        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("token-fallback"))
            .mockResolvedValueOnce({
                data: {
                    id: "playlist-deezer",
                    name: "Deezer Fallback Playlist",
                    description: null,
                    owner: { display_name: "Owner" },
                    images: [{ url: "https://images.example/fallback.jpg" }],
                    public: true,
                    tracks: {
                        total: 2,
                        items: [
                            { track: null },
                            {
                                track: {
                                    id: "track-deezer",
                                    name: "Track One",
                                    artists: [{ id: "artist-1", name: "Artist One" }],
                                    album: {
                                        id: "album-empty",
                                        name: "Unknown Album",
                                        images: [{ url: "https://images.example/deezer-a.jpg" }],
                                    },
                                    duration_ms: 123000,
                                    track_number: 1,
                                    preview_url: null,
                                    external_ids: { isrc: "ISRC1" },
                                },
                            },
                        ],
                    },
                },
            })
            .mockResolvedValueOnce({ data: "<html></html>" })
            .mockRejectedValueOnce(new Error("track scrape down"));

        mockDeezerTrackAlbum.mockResolvedValueOnce({ albumName: "Deezer Album", albumId: 42 });

        const playlist = await spotifyService.getPlaylist("playlist-deezer");

        expect(playlist).not.toBeNull();
        expect(playlist!.tracks).toHaveLength(1);
        expect(playlist!.tracks[0].spotifyId).toBe("track-deezer");
        expect(playlist!.tracks[0].album).toBe("Deezer Album");
        expect(playlist!.tracks[0].albumId).toBe("deezer:42");
    });

    it("returns [] when featured, category, search, and browse category APIs fail", async () => {
        mockAxiosGet.mockImplementation((url: string) => {
            if (url.includes("clientcredentials.googleapis.com")) {
                return Promise.resolve(makeTokenResponse("token-browse"));
            }

            if (url.includes("/v1/browse/featured-playlists")) {
                return Promise.reject(new Error("featured playlists down"));
            }

            if (url.includes("/v1/search")) {
                return Promise.reject(new Error("search down"));
            }

            if (url.includes("/v1/browse/categories/") && url.includes("/playlists")) {
                return Promise.reject(new Error("category playlists down"));
            }

            if (url.includes("/v1/browse/categories")) {
                return Promise.reject(new Error("categories down"));
            }

            return Promise.reject(new Error(`unexpected url: ${url}`));
        });

        const featured = await spotifyService.getFeaturedPlaylists(5);
        const search = await spotifyService.searchPlaylists("x", 5);
        const categoryPlaylists = await spotifyService.getCategoryPlaylists("pop", 5);
        const categories = await spotifyService.getCategories(5);

        expect(featured).toEqual([]);
        expect(search).toEqual([]);
        expect(categoryPlaylists).toEqual([]);
        expect(categories).toEqual([]);
    });

    it("returns null from embed parsing when playlist payload is missing", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: `<html><script id="__NEXT_DATA__" type="application/json">{}</script></html>`,
        });

        const playlist = await (spotifyService as any).fetchPlaylistViaEmbedHtml("embed-without-payload");

        expect(playlist).toBeNull();
    });

    it("handles playlist pages with NEXT_DATA__ but no track items", async () => {
        const svc = spotifyService as any;
        const nextData = JSON.stringify({
            props: {
                pageProps: {
                    state: {
                        data: {
                            entity: {},
                        },
                    },
                },
            },
        });
        const html = `<html><script id="__NEXT_DATA__" type="application/json">${nextData}</script></html>`;

        mockAxiosGet.mockResolvedValueOnce({ data: html });

        const albums = await svc.scrapePlaylistPageForAlbums("playlist-empty-next-data");

        expect(albums.size).toBe(0);
    });

    it("returns [] from Apollo extraction when HTML is not a string", () => {
        const tracks = (spotifyService as any).extractTracksFromApolloCache(
            null as unknown as string
        );

        expect(tracks).toEqual([]);
    });

    it("enriches unknown albums via track-page scraping in embed fallback", async () => {
        const svc = spotifyService as any;
        const embedData = JSON.stringify({
            props: {
                pageProps: {
                    state: {
                        data: {
                            trackList: [
                                {
                                    uri: "spotify:track:track-1",
                                    title: "Track One",
                                    subtitle: "Artist One",
                                    albumName: "Unknown Album",
                                },
                            ],
                        },
                    },
                },
            },
        });
        const embedHtml = `<html><script id="__NEXT_DATA__" type="application/json">${embedData}</script></html>`;

        const scrapePlaylistPageSpy = jest
            .spyOn(svc, "scrapePlaylistPageForAlbums")
            .mockResolvedValue(new Map());

        const scrapeTrackPagesSpy = jest
            .spyOn(svc, "scrapeTrackPagesForAlbums")
            .mockResolvedValue(new Map([["track-1", { album: "Recovered Album", albumId: "album-1" }]]));

        mockAxiosGet.mockResolvedValueOnce({ data: embedHtml });

        const playlist = await svc.fetchPlaylistViaEmbedHtml("playlist-track-fallback");

        expect(playlist).not.toBeNull();
        expect(playlist!.tracks[0].album).toBe("Recovered Album");
        expect(playlist!.tracks[0].albumId).toBe("album-1");
        expect(scrapePlaylistPageSpy).toHaveBeenCalledWith("playlist-track-fallback");
        expect(scrapeTrackPagesSpy).toHaveBeenCalledTimes(1);

        scrapePlaylistPageSpy.mockRestore();
        scrapeTrackPagesSpy.mockRestore();
    });

    it("filters non-Spotify owners from featured playlist fallback search", async () => {
        mockAxiosGet
            .mockResolvedValueOnce(makeTokenResponse("featured-token"))
            .mockRejectedValueOnce(new Error("featured endpoint unavailable"))
            .mockResolvedValueOnce({
                data: {
                    playlists: {
                        items: [
                            {
                                id: "ignore-me",
                                name: "Indie Mix",
                                description: null,
                                owner: { display_name: "Community" },
                                images: [],
                                tracks: { total: 5 },
                            },
                            {
                                id: "spotify-owned",
                                name: "Top Picks",
                                description: "Official",
                                owner: { display_name: "Spotify" },
                                images: [],
                                tracks: { total: 21 },
                            },
                        ],
                    },
                },
            })
            .mockResolvedValueOnce({
                data: {
                    playlists: {
                        items: [
                            {
                                id: "curator-owned",
                                name: "Curated by Spotify",
                                description: "Editorial",
                                owner: { display_name: "Spotify Editorial" },
                                images: [],
                                tracks: { total: 19 },
                            },
                        ],
                    },
                },
            });

        const featured = await spotifyService.getFeaturedPlaylists(2);

        expect(featured.map((playlist) => playlist.id)).toEqual([
            "spotify-owned",
            "curator-owned",
        ]);
        expect(featured).toHaveLength(2);
    });

    it("returns null when embed HTML has malformed NEXT_DATA JSON", async () => {
        const svc = spotifyService as any;

        mockAxiosGet.mockResolvedValueOnce({
            data: `<html><script id="__NEXT_DATA__" type="application/json">{not valid json}</script></html>`,
        });

        const playlist = await svc.fetchPlaylistViaEmbedHtml("malformed-next-data");

        expect(playlist).toBeNull();
    });

    it("returns an empty map when resolving Deezer albums for an empty track list", async () => {
        const svc = spotifyService as any;

        const albums = await svc.resolveAlbumsViaDeezer([]);

        expect(albums.size).toBe(0);
        expect(mockDeezerTrackAlbum).not.toHaveBeenCalled();
    });
});
