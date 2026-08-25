const logger = {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};
jest.mock("../../utils/logger", () => ({ logger }));

const mockConfig = {
    secretsDbOnly: false,
    fanart: {
        get apiKey() {
            return process.env.FANART_API_KEY;
        },
    },
};
jest.mock("../../config", () => ({ config: mockConfig }));

const mockGetSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: (...args: unknown[]) => mockGetSystemSettings(...args),
}));

const rateLimiter = { execute: jest.fn() };
jest.mock("../rateLimiter", () => ({ rateLimiter }));

const mockAxiosGet = jest.fn();
const mockAxiosIsAxiosError = jest.fn();
jest.mock("axios", () => ({
    __esModule: true,
    default: {
        get: (...args: unknown[]) => mockAxiosGet(...args),
        isAxiosError: (...args: unknown[]) => mockAxiosIsAxiosError(...args),
    },
}));

const mockDeezerGetAlbumCover = jest.fn();
jest.mock("../deezer", () => ({
    deezerService: {
        getAlbumCover: (...args: unknown[]) => mockDeezerGetAlbumCover(...args),
    },
}));

const mockResolveArtistImage = jest.fn();
jest.mock("../metadata/artistImageResolver", () => ({
    resolveArtistImage: (...args: unknown[]) => mockResolveArtistImage(...args),
}));

import { ImageProviderService } from "../imageProvider";

describe("image provider service behavior", () => {
    const originalFanartApiKey = process.env.FANART_API_KEY;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.FANART_API_KEY = originalFanartApiKey;
        mockConfig.secretsDbOnly = false;
        mockGetSystemSettings.mockResolvedValue(null);
        mockResolveArtistImage.mockResolvedValue(null);
        mockDeezerGetAlbumCover.mockResolvedValue(null);
        mockAxiosGet.mockResolvedValue({ data: {} });
        mockAxiosIsAxiosError.mockReturnValue(false);
        rateLimiter.execute.mockImplementation(
            async (_bucket: string, run: () => Promise<unknown>) => run(),
        );
    });

    afterAll(() => {
        process.env.FANART_API_KEY = originalFanartApiKey;
    });

    it("delegates artist image resolution to the metadata facade", async () => {
        const service = new ImageProviderService();
        mockResolveArtistImage.mockResolvedValueOnce({
            url: "https://wikidata/artist.jpg",
            source: "wikidata",
        });

        await expect(
            service.getArtistImage("Artist Name", "artist-mbid"),
        ).resolves.toEqual({
            url: "https://wikidata/artist.jpg",
            source: "wikidata",
        });
        expect(mockResolveArtistImage).toHaveBeenCalledWith({
            artistName: "Artist Name",
            mbid: "artist-mbid",
        });
    });

    it("preserves the album-cover Deezer, MusicBrainz, Fanart order", async () => {
        process.env.FANART_API_KEY = "fanart-key";
        const service = new ImageProviderService();
        jest.spyOn(service as any, "getAlbumCoverFromDeezer")
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        jest.spyOn(service as any, "getAlbumCoverFromMusicBrainz")
            .mockResolvedValueOnce({
                url: "https://coverart/front.jpg",
                source: "musicbrainz",
            })
            .mockResolvedValueOnce(null);
        jest.spyOn(
            service as any,
            "getAlbumCoverFromFanart",
        ).mockResolvedValueOnce({
            url: "https://fanart/cover.jpg",
            source: "fanart",
        });

        await expect(
            service.getAlbumCover("Artist A", "Album A", "rg-1"),
        ).resolves.toEqual({
            url: "https://coverart/front.jpg",
            source: "musicbrainz",
        });
        await expect(
            service.getAlbumCover("Artist B", "Album B", "rg-2"),
        ).resolves.toEqual({
            url: "https://fanart/cover.jpg",
            source: "fanart",
        });
    });

    it("delegates Deezer album matching to the Deezer service", async () => {
        const service = new ImageProviderService();
        mockDeezerGetAlbumCover.mockResolvedValueOnce(
            "https://deezer/album-xl.jpg",
        );

        await expect(
            (service as any).getAlbumCoverFromDeezer(
                "Artist A",
                "Album One",
                3000,
            ),
        ).resolves.toEqual({
            url: "https://deezer/album-xl.jpg",
            source: "deezer",
            size: "xl",
        });
        expect(mockDeezerGetAlbumCover).toHaveBeenCalledWith(
            "Artist A",
            "Album One",
        );
    });

    it("uses the configured Fanart key for album covers", async () => {
        process.env.FANART_API_KEY = "fanart-key";
        const service = new ImageProviderService();
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
            (service as any).getAlbumCoverFromFanart("rg-mbid", 2000),
        ).resolves.toEqual({
            url: "https://fanart/album-cover.jpg",
            source: "fanart",
        });
        expect(mockAxiosGet).toHaveBeenCalledWith(
            "https://webservice.fanart.tv/v3/music/albums/rg-mbid",
            {
                params: { api_key: "fanart-key" },
                timeout: 2000,
            },
        );
    });

    it("resolves the stored Fanart key in DB-only mode", async () => {
        process.env.FANART_API_KEY = "env-key";
        mockConfig.secretsDbOnly = true;
        mockGetSystemSettings.mockResolvedValue({
            fanartEnabled: true,
            fanartApiKey: "db-key",
        });
        const service = new ImageProviderService();
        mockAxiosGet.mockResolvedValueOnce({ data: {} });

        await expect(
            (service as any).getAlbumCoverFromFanart("rg-mbid", 2000),
        ).resolves.toBeNull();
        expect(mockAxiosGet).toHaveBeenCalledWith(
            "https://webservice.fanart.tv/v3/music/albums/rg-mbid",
            expect.objectContaining({ params: { api_key: "db-key" } }),
        );
    });

    it("handles Cover Art Archive success, 404, and unknown failures", async () => {
        const service = new ImageProviderService();
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                images: [{ image: "https://coverart/front.jpg", front: true }],
            },
        });
        await expect(
            (service as any).getAlbumCoverFromMusicBrainz("rg-1", 1000),
        ).resolves.toEqual({
            url: "https://coverart/front.jpg",
            source: "musicbrainz",
        });

        const notFoundError = { response: { status: 404 } };
        rateLimiter.execute.mockRejectedValueOnce(notFoundError);
        mockAxiosIsAxiosError.mockReturnValueOnce(true);
        await expect(
            (service as any).getAlbumCoverFromMusicBrainz("rg-2", 1000),
        ).resolves.toBeNull();

        rateLimiter.execute.mockRejectedValueOnce(new Error("timeout"));
        await expect(
            (service as any).getAlbumCoverFromMusicBrainz("rg-3", 1000),
        ).rejects.toThrow("timeout");
    });
});
