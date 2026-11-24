jest.mock("../lastfm", () => ({
    lastFmService: { searchArtists: jest.fn(), searchTracks: jest.fn() },
}));
jest.mock("../deezer", () => ({
    deezerService: { searchArtists: jest.fn(), searchTracks: jest.fn() },
}));
jest.mock("../tidalStreaming", () => ({
    tidalStreamingService: {
        isEnabled: jest.fn(),
        isAvailable: jest.fn(),
        getAuthStatus: jest.fn(),
        search: jest.fn(),
    },
}));
jest.mock("../youtubeMusic", () => ({
    ytMusicService: { isAvailable: jest.fn(), searchCanonical: jest.fn() },
}));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));
jest.mock("../../utils/logger", () => {
    const scoped = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    };
    return { logger: { ...scoped, child: jest.fn(() => scoped) } };
});

import { deezerService } from "../deezer";
import { lastFmService } from "../lastfm";
import { tidalStreamingService } from "../tidalStreaming";
import { ytMusicService } from "../youtubeMusic";
import { getSystemSettings } from "../../utils/systemSettings";
import {
    mergeDiscoverProviderResults,
    resolveUsableSearchProviders,
    searchDiscoverMusic,
    type DiscoverProviderResults,
} from "../discoverMusicSearch";

function artist(source: DiscoverProviderResults["provider"], name: string) {
    return { type: "music" as const, id: `${source}:${name}`, name, source };
}

function track(
    source: DiscoverProviderResults["provider"],
    artistName: string,
    name: string,
) {
    return {
        type: "track" as const,
        id: `${source}:${artistName}:${name}`,
        name,
        artist: artistName,
        album: null,
        source,
    };
}

describe("mergeDiscoverProviderResults", () => {
    it("lists higher-priority providers first and drops their duplicates", () => {
        const merged = mergeDiscoverProviderResults(
            [
                {
                    provider: "deezer",
                    artists: [
                        artist("deezer", "Björk"),
                        artist("deezer", "Air"),
                    ],
                    tracks: [track("deezer", "Björk", "Hyperballad")],
                },
                {
                    provider: "lastfm",
                    artists: [
                        artist("lastfm", "bjork"),
                        artist("lastfm", "Portishead"),
                    ],
                    tracks: [
                        track("lastfm", "Bjork", "Hyperballad"),
                        track("lastfm", "Björk", "Jóga"),
                    ],
                },
            ],
            10,
        );

        expect(merged.artists.map((a) => a.id)).toEqual([
            "deezer:Björk",
            "deezer:Air",
            "lastfm:Portishead",
        ]);
        expect(merged.tracks.map((t) => t.id)).toEqual([
            "deezer:Björk:Hyperballad",
            "lastfm:Björk:Jóga",
        ]);
    });

    it("caps each result type at the limit", () => {
        const merged = mergeDiscoverProviderResults(
            [
                {
                    provider: "lastfm",
                    artists: [artist("lastfm", "A"), artist("lastfm", "B")],
                    tracks: [],
                },
                {
                    provider: "deezer",
                    artists: [artist("deezer", "C")],
                    tracks: [],
                },
            ],
            2,
        );

        expect(merged.artists.map((a) => a.name)).toEqual(["A", "B"]);
    });
});

describe("searchDiscoverMusic", () => {
    beforeEach(() => jest.clearAllMocks());

    it("merges providers in the given order and skips one that fails", async () => {
        (deezerService.searchArtists as jest.Mock).mockResolvedValue([
            {
                deezerId: "27",
                name: "Daft Punk",
                fans: 10,
                url: null,
                imageUrl: null,
            },
        ]);
        (deezerService.searchTracks as jest.Mock).mockResolvedValue([]);
        (lastFmService.searchArtists as jest.Mock).mockResolvedValue([
            {
                type: "music",
                id: "mbid-dp",
                name: "Daft Punk",
                mbid: "mbid-dp",
            },
            { type: "music", id: "Justice", name: "Justice" },
        ]);
        (lastFmService.searchTracks as jest.Mock).mockResolvedValue([]);
        (tidalStreamingService.search as jest.Mock).mockRejectedValue(
            new Error("sidecar down"),
        );

        const result = await searchDiscoverMusic({
            query: "daft",
            limit: 10,
            userId: "user-1",
            providers: ["deezer", "tidal", "lastfm"],
        });

        expect(result.artists.map((a) => [a.source, a.name])).toEqual([
            ["deezer", "Daft Punk"],
            ["lastfm", "Justice"],
        ]);
    });

    it("keeps a provider's songs when only its artist search fails", async () => {
        (lastFmService.searchArtists as jest.Mock).mockRejectedValue(
            new Error("artist search down"),
        );
        (lastFmService.searchTracks as jest.Mock).mockResolvedValue([
            { type: "track", id: "t1", name: "Song", artist: "Band" },
        ]);

        const result = await searchDiscoverMusic({
            query: "song",
            limit: 10,
            userId: "user-1",
            providers: ["lastfm"],
        });

        expect(result.artists).toEqual([]);
        expect(result.tracks).toEqual([
            {
                type: "track",
                id: "t1",
                name: "Song",
                artist: "Band",
                source: "lastfm",
            },
        ]);
    });

    it("maps TIDAL and YouTube Music songs with their playable ids", async () => {
        (tidalStreamingService.search as jest.Mock).mockResolvedValue({
            artists: [],
            tracks: [
                {
                    id: 123,
                    title: "One More Time",
                    artist: "Daft Punk",
                    album: { id: 9, title: "Discovery" },
                    duration: 320,
                },
            ],
        });
        (ytMusicService.searchCanonical as jest.Mock).mockResolvedValue({
            results: [
                {
                    providerTrackId: "vid-1",
                    title: "Around the World",
                    artistName: "Daft Punk",
                    albumTitle: "Homework",
                    durationSec: 429,
                    thumbnailUrl: "https://yt.test/thumb.jpg",
                },
            ],
        });

        const result = await searchDiscoverMusic({
            query: "daft",
            limit: 10,
            userId: "user-1",
            providers: ["tidal", "youtube"],
        });

        expect(result.tracks).toEqual([
            expect.objectContaining({
                source: "tidal",
                name: "One More Time",
                album: "Discovery",
                tidalTrackId: 123,
                durationSec: 320,
            }),
            expect.objectContaining({
                source: "youtube",
                name: "Around the World",
                youtubeVideoId: "vid-1",
            }),
        ]);
        expect(ytMusicService.searchCanonical).toHaveBeenCalledWith(
            "user-1",
            "daft",
            "songs",
        );
    });
});

describe("resolveUsableSearchProviders", () => {
    beforeEach(() => jest.clearAllMocks());

    it("keeps TIDAL and YouTube Music only when this user can search them", async () => {
        (tidalStreamingService.isEnabled as jest.Mock).mockResolvedValue(true);
        (tidalStreamingService.isAvailable as jest.Mock).mockResolvedValue(
            true,
        );
        (tidalStreamingService.getAuthStatus as jest.Mock).mockResolvedValue({
            authenticated: false,
        });
        (getSystemSettings as jest.Mock).mockResolvedValue({
            ytMusicEnabled: true,
        });
        (ytMusicService.isAvailable as jest.Mock).mockResolvedValue(true);

        await expect(
            resolveUsableSearchProviders(
                ["youtube", "tidal", "lastfm", "deezer"],
                "user-1",
            ),
        ).resolves.toEqual(["youtube", "lastfm", "deezer"]);
    });

    it("drops the account-backed providers for a signed-out request", async () => {
        await expect(
            resolveUsableSearchProviders(
                ["tidal", "youtube", "lastfm"],
                undefined,
            ),
        ).resolves.toEqual(["lastfm"]);
    });
});
