const logger = {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};
jest.mock("../../utils/logger", () => ({
    logger,
}));

const mockNormalizeQuotes = jest.fn((value: string) => value);
const mockNormalizeFullwidth = jest.fn((value: string) => value);
jest.mock("../../utils/stringNormalization", () => ({
    normalizeQuotes: (value: string) => mockNormalizeQuotes(value),
    normalizeFullwidth: (value: string) => mockNormalizeFullwidth(value),
}));

const rateLimiter = {
    execute: jest.fn(),
};
jest.mock("../rateLimiter", () => ({
    rateLimiter,
}));

const mockAxiosGet = jest.fn();
const mockAxiosIsAxiosError = jest.fn();
jest.mock("axios", () => ({
    __esModule: true,
    default: {
        get: (...args: any[]) => mockAxiosGet(...args),
        isAxiosError: (...args: any[]) => mockAxiosIsAxiosError(...args),
    },
    get: (...args: any[]) => mockAxiosGet(...args),
    isAxiosError: (...args: any[]) => mockAxiosIsAxiosError(...args),
}));

const lastFmService = {
    getArtistInfo: jest.fn(),
};
jest.mock("../lastfm", () => ({
    lastFmService,
}));

const mockDeezerGetAlbumCover = jest.fn();
jest.mock("../deezer", () => ({
    deezerService: {
        getAlbumCover: (...args: any[]) => mockDeezerGetAlbumCover(...args),
    },
}));

import { ImageProviderService } from "../imageProvider";

describe("image provider service behavior", () => {
    const originalFanartApiKey = process.env.FANART_API_KEY;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.FANART_API_KEY = originalFanartApiKey;

        rateLimiter.execute.mockImplementation(
            async (_bucket: string, fn: () => Promise<unknown>) => fn()
        );

        mockAxiosGet.mockResolvedValue({ data: {} });
        mockAxiosIsAxiosError.mockReturnValue(false);
        lastFmService.getArtistInfo.mockResolvedValue(null);

        mockNormalizeQuotes.mockImplementation((value: string) => value);
        mockNormalizeFullwidth.mockImplementation((value: string) => value);
    });

    afterAll(() => {
        process.env.FANART_API_KEY = originalFanartApiKey;
    });

    it("returns Deezer artist image first and short-circuits fallback chain", async () => {
        process.env.FANART_API_KEY = "fanart-key";
        const service = new ImageProviderService();

        const deezerSpy = jest
            .spyOn(service as any, "getArtistImageFromDeezer")
            .mockResolvedValueOnce({
                url: "https://deezer/artist-xl.jpg",
                source: "deezer",
                size: "xl",
            });
        const fanartSpy = jest.spyOn(service as any, "getArtistImageFromFanart");
        const mbSpy = jest.spyOn(service as any, "getArtistImageFromMusicBrainz");

        await expect(
            service.getArtistImage("Artist Name", "artist-mbid")
        ).resolves.toEqual({
            url: "https://deezer/artist-xl.jpg",
            source: "deezer",
            size: "xl",
        });

        expect(deezerSpy).toHaveBeenCalledWith("Artist Name", 5000);
        expect(fanartSpy).not.toHaveBeenCalled();
        expect(mbSpy).not.toHaveBeenCalled();
    });

    it("falls back artist image Deezer -> Fanart -> MusicBrainz and then null", async () => {
        process.env.FANART_API_KEY = "fanart-key";
        const service = new ImageProviderService();

        jest.spyOn(service as any, "getArtistImageFromDeezer")
            .mockRejectedValueOnce(new Error("deezer down"))
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        jest.spyOn(service as any, "getArtistImageFromFanart")
            .mockResolvedValueOnce({
                url: "https://fanart/artist.jpg",
                source: "fanart",
            })
            .mockResolvedValueOnce(null);
        jest.spyOn(service as any, "getArtistImageFromMusicBrainz")
            .mockResolvedValueOnce({
                url: "https://coverart/artist.jpg",
                source: "musicbrainz",
            })
            .mockResolvedValueOnce(null);

        await expect(
            service.getArtistImage("Artist One", "mbid-1")
        ).resolves.toEqual({
            url: "https://fanart/artist.jpg",
            source: "fanart",
        });

        await expect(
            service.getArtistImage("Artist Two", "mbid-2")
        ).resolves.toEqual({
            url: "https://coverart/artist.jpg",
            source: "musicbrainz",
        });

        await expect(
            service.getArtistImage("Artist Three", "mbid-3")
        ).resolves.toBeNull();
    });

    it("skips fanart without API key and returns null when no artist sources resolve", async () => {
        delete process.env.FANART_API_KEY;
        const service = new ImageProviderService();

        const fanartSpy = jest.spyOn(service as any, "getArtistImageFromFanart");
        jest.spyOn(service as any, "getArtistImageFromDeezer").mockResolvedValue(
            null
        );
        jest.spyOn(service as any, "getArtistImageFromMusicBrainz").mockResolvedValue(
            null
        );

        await expect(service.getArtistImage("No Key Artist", "mbid")).resolves.toBeNull();
        expect(fanartSpy).not.toHaveBeenCalled();
    });

    it("resolves album covers with Deezer-first ordering and fallbacks", async () => {
        process.env.FANART_API_KEY = "fanart-key";
        const service = new ImageProviderService();

        const deezerSpy = jest
            .spyOn(service as any, "getAlbumCoverFromDeezer")
            .mockResolvedValueOnce({
                url: "https://deezer/cover-xl.jpg",
                source: "deezer",
                size: "xl",
            })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        jest.spyOn(service as any, "getAlbumCoverFromMusicBrainz")
            .mockResolvedValueOnce({
                url: "https://coverart/front.jpg",
                source: "musicbrainz",
            })
            .mockResolvedValueOnce(null);
        jest.spyOn(service as any, "getAlbumCoverFromFanart")
            .mockResolvedValueOnce({
                url: "https://fanart/cover.jpg",
                source: "fanart",
            })
            .mockResolvedValueOnce(null);

        await expect(
            service.getAlbumCover("Artist A", "Album A", "rg-1")
        ).resolves.toEqual({
            url: "https://deezer/cover-xl.jpg",
            source: "deezer",
            size: "xl",
        });

        await expect(
            service.getAlbumCover("Artist B", "Album B", "rg-2")
        ).resolves.toEqual({
            url: "https://coverart/front.jpg",
            source: "musicbrainz",
        });

        await expect(
            service.getAlbumCover("Artist C", "Album C", "rg-3")
        ).resolves.toEqual({
            url: "https://fanart/cover.jpg",
            source: "fanart",
        });

        expect(deezerSpy).toHaveBeenCalledTimes(3);
    });

    it("normalizes lookup values and maps Deezer artist/album responses", async () => {
        const service = new ImageProviderService();
        mockNormalizeQuotes.mockImplementation((value: string) =>
            value.replace(/[“”]/g, "\"")
        );
        mockNormalizeFullwidth.mockImplementation((value: string) =>
            value.replace("Ａ", "A")
        );

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        picture: "https://deezer/artist.jpg",
                        picture_big: "https://deezer/artist-big.jpg",
                        picture_xl: "https://deezer/artist-xl.jpg",
                    },
                ],
            },
        });

        await expect(
            (service as any).getArtistImageFromDeezer("Ａrtist “Name”", 2500)
        ).resolves.toEqual({
            url: "https://deezer/artist-xl.jpg",
            source: "deezer",
            size: "xl",
        });

        expect(mockAxiosGet).toHaveBeenCalledWith(
            "https://api.deezer.com/search/artist",
            {
                params: { q: 'Artist "Name"', limit: 1 },
                timeout: 2500,
            }
        );

        // getAlbumCoverFromDeezer now delegates to deezerService.getAlbumCover()
        mockDeezerGetAlbumCover.mockResolvedValueOnce("https://deezer/album-xl.jpg");
        await expect(
            (service as any).getAlbumCoverFromDeezer(
                "Ａrtist A",
                'Album “One”',
                3000
            )
        ).resolves.toEqual({
            url: "https://deezer/album-xl.jpg",
            source: "deezer",
            size: "xl",
        });
        expect(mockDeezerGetAlbumCover).toHaveBeenCalledWith("Ａrtist A", 'Album “One”');

        mockDeezerGetAlbumCover.mockResolvedValueOnce(null);
        await expect(
            (service as any).getAlbumCoverFromDeezer("No Match", "No Match", 3000)
        ).resolves.toBeNull();
    });

    it("maps fanart artist/album responses and handles missing API key", async () => {
        delete process.env.FANART_API_KEY;
        const noKeyService = new ImageProviderService();
        await expect(
            (noKeyService as any).getArtistImageFromFanart("mbid", 1000)
        ).resolves.toBeNull();
        await expect(
            (noKeyService as any).getAlbumCoverFromFanart("rg-mbid", 1000)
        ).resolves.toBeNull();

        process.env.FANART_API_KEY = "fanart-key";
        const service = new ImageProviderService();

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                artistthumb: [{ url: "https://fanart/artist-thumb.jpg" }],
            },
        });
        await expect(
            (service as any).getArtistImageFromFanart("artist-mbid", 2000)
        ).resolves.toEqual({
            url: "https://fanart/artist-thumb.jpg",
            source: "fanart",
        });

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                albums: {
                    "rg-mbid": {
                        albumcover: [{ url: "https://fanart/album-cover.jpg" }],
                    },
                },
            },
        });
        await expect(
            (service as any).getAlbumCoverFromFanart("rg-mbid", 2000)
        ).resolves.toEqual({
            url: "https://fanart/album-cover.jpg",
            source: "fanart",
        });
    });

    it("handles cover art archive lookup including 404 and unknown failures", async () => {
        const service = new ImageProviderService();

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                images: [
                    { image: "https://coverart/front.jpg", front: true },
                    { image: "https://coverart/other.jpg", front: false },
                ],
            },
        });
        await expect(
            (service as any).getAlbumCoverFromMusicBrainz("rg-1", 1000)
        ).resolves.toEqual({
            url: "https://coverart/front.jpg",
            source: "musicbrainz",
        });

        const notFoundError = { response: { status: 404 } };
        rateLimiter.execute.mockRejectedValueOnce(notFoundError);
        mockAxiosIsAxiosError.mockReturnValueOnce(true);
        await expect(
            (service as any).getAlbumCoverFromMusicBrainz("rg-2", 1000)
        ).resolves.toBeNull();

        const unknownError = new Error("coverart timeout");
        rateLimiter.execute.mockRejectedValueOnce(unknownError);
        mockAxiosIsAxiosError.mockReturnValueOnce(false);
        await expect(
            (service as any).getAlbumCoverFromMusicBrainz("rg-3", 1000)
        ).rejects.toThrow("coverart timeout");
    });

    it("returns null for placeholder MusicBrainz artist image lookup", async () => {
        const service = new ImageProviderService();
        await expect(
            (service as any).getArtistImageFromMusicBrainz("artist-mbid", 1000)
        ).resolves.toBeNull();
    });

    it("maps Last.fm artist images and handles Last.fm failures", async () => {
        const service = new ImageProviderService();

        lastFmService.getArtistInfo.mockResolvedValueOnce({
            image: [
                { size: "small", "#text": "https://lastfm/small.jpg" },
                { size: "mega", "#text": "https://lastfm/mega.jpg" },
            ],
        });
        await expect(
            service.getArtistImageFromLastFm("Artist", "mbid-1")
        ).resolves.toEqual({
            url: "https://lastfm/mega.jpg",
            source: "lastfm",
            size: "mega",
        });

        lastFmService.getArtistInfo.mockResolvedValueOnce({
            image: [{ size: "extralarge", "#text": "" }],
        });
        await expect(service.getArtistImageFromLastFm("Artist")).resolves.toBeNull();

        lastFmService.getArtistInfo.mockRejectedValueOnce(new Error("lastfm down"));
        await expect(service.getArtistImageFromLastFm("Artist")).resolves.toBeNull();
        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("Last.fm failed:")
        );
    });
});
