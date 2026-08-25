const mockWikidataArtistInfo = jest.fn();
const mockFanartArtistImage = jest.fn();
const mockDeezerArtistImage = jest.fn();
const mockLastFmArtistInfo = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSetEx = jest.fn();

jest.mock("../../wikidata", () => ({
    wikidataService: { getArtistInfo: mockWikidataArtistInfo },
}));

jest.mock("../../fanart", () => ({
    fanartService: { getArtistImage: mockFanartArtistImage },
}));

jest.mock("../../deezer", () => ({
    deezerService: { getArtistImage: mockDeezerArtistImage },
}));

jest.mock("../../lastfm", () => ({
    lastFmService: { getArtistInfo: mockLastFmArtistInfo },
}));

jest.mock("../../../utils/redis", () => ({
    redisClient: {
        get: mockRedisGet,
        setEx: mockRedisSetEx,
    },
}));

jest.mock("../../../utils/logger", () => ({
    logger: {
        child: jest.fn().mockReturnValue({
            debug: jest.fn(),
            warn: jest.fn(),
        }),
    },
}));

import { resolveArtistImage } from "../artistImageResolver";

const REAL_MBID = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3";
const INPUT = { artistName: "Radiohead", mbid: REAL_MBID };

describe("resolveArtistImage", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue(undefined);
        mockWikidataArtistInfo.mockResolvedValue({});
        mockFanartArtistImage.mockResolvedValue(null);
        mockDeezerArtistImage.mockResolvedValue(null);
        mockLastFmArtistInfo.mockResolvedValue(null);
    });

    it("runs the canonical ladder in order and short-circuits on Deezer", async () => {
        const calls: string[] = [];
        mockWikidataArtistInfo.mockImplementation(async () => {
            calls.push("wikidata");
            return {};
        });
        mockFanartArtistImage.mockImplementation(async () => {
            calls.push("fanart");
            return null;
        });
        mockDeezerArtistImage.mockImplementation(async () => {
            calls.push("deezer");
            return "https://deezer.example/artist.jpg";
        });
        mockLastFmArtistInfo.mockImplementation(async () => {
            calls.push("lastfm");
            return null;
        });

        await expect(resolveArtistImage(INPUT)).resolves.toEqual({
            url: "https://deezer.example/artist.jpg",
            source: "deezer",
        });
        expect(calls).toEqual(["wikidata", "fanart", "deezer"]);
        expect(mockFanartArtistImage).toHaveBeenCalledWith(REAL_MBID, {
            preference: "square",
        });
        expect(mockLastFmArtistInfo).not.toHaveBeenCalled();
    });

    it.each([undefined, null, "temp-artist", "invalid-mbid"])(
        "skips MBID-gated rungs for %p",
        async (mbid) => {
            mockLastFmArtistInfo.mockResolvedValue({
                image: [
                    {
                        size: "extralarge",
                        "#text": "https://lastfm.example/artist.jpg",
                    },
                ],
            });

            await expect(
                resolveArtistImage({ artistName: "No MBID", mbid }),
            ).resolves.toEqual({
                url: "https://lastfm.example/artist.jpg",
                source: "lastfm",
            });
            expect(mockWikidataArtistInfo).not.toHaveBeenCalled();
            expect(mockFanartArtistImage).not.toHaveBeenCalled();
            expect(mockDeezerArtistImage).toHaveBeenCalledWith("No MBID");
        },
    );

    it("filters the Last.fm placeholder hash in the resolver", async () => {
        mockLastFmArtistInfo.mockResolvedValue({
            image: [
                {
                    size: "extralarge",
                    "#text":
                        "https://lastfm.example/2a96cbd8b46e442fc41c2b86b821562f.png",
                },
            ],
        });

        await expect(resolveArtistImage(INPUT)).resolves.toBeNull();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "metadata:artist-image:radiohead",
            24 * 60 * 60,
            JSON.stringify({ status: "miss" }),
        );
    });

    it("uses a negative cache entry without re-hitting providers", async () => {
        mockRedisGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(JSON.stringify({ status: "miss" }));

        await expect(resolveArtistImage(INPUT)).resolves.toBeNull();
        await expect(resolveArtistImage(INPUT)).resolves.toBeNull();

        expect(mockWikidataArtistInfo).toHaveBeenCalledTimes(1);
        expect(mockFanartArtistImage).toHaveBeenCalledTimes(1);
        expect(mockDeezerArtistImage).toHaveBeenCalledTimes(1);
        expect(mockLastFmArtistInfo).toHaveBeenCalledTimes(1);
    });

    it("caches successful resolutions for seven days", async () => {
        mockWikidataArtistInfo.mockResolvedValue({
            heroUrl: "https://wikidata.example/artist.jpg",
        });

        await resolveArtistImage(INPUT);

        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "metadata:artist-image:radiohead",
            7 * 24 * 60 * 60,
            JSON.stringify({
                status: "hit",
                value: {
                    url: "https://wikidata.example/artist.jpg",
                    source: "wikidata",
                },
            }),
        );
    });

    it("stops later rungs when the shared budget expires", async () => {
        jest.useFakeTimers();
        mockWikidataArtistInfo.mockReturnValue(new Promise(() => undefined));

        try {
            const pending = resolveArtistImage(INPUT);
            await jest.advanceTimersByTimeAsync(8_000);
            await expect(pending).resolves.toBeNull();
            expect(mockFanartArtistImage).not.toHaveBeenCalled();
            expect(mockDeezerArtistImage).not.toHaveBeenCalled();
            expect(mockLastFmArtistInfo).not.toHaveBeenCalled();
            expect(mockRedisSetEx).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });

    it("does not poison the negative cache after a transient provider error", async () => {
        mockDeezerArtistImage.mockRejectedValue(new Error("Deezer timeout"));

        await expect(resolveArtistImage(INPUT)).resolves.toBeNull();
        await expect(resolveArtistImage(INPUT)).resolves.toBeNull();

        expect(mockDeezerArtistImage).toHaveBeenCalledTimes(2);
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("deduplicates concurrent resolution for the same normalized artist", async () => {
        let finishWikidata: ((value: { heroUrl: string }) => void) | undefined;
        mockWikidataArtistInfo.mockReturnValue(
            new Promise((resolve) => {
                finishWikidata = resolve;
            }),
        );

        const first = resolveArtistImage(INPUT);
        const second = resolveArtistImage({
            artistName: "  RADIOHEAD  ",
            mbid: REAL_MBID,
        });
        await Promise.resolve();
        finishWikidata?.({ heroUrl: "https://wikidata.example/deduped.jpg" });

        await expect(Promise.all([first, second])).resolves.toEqual([
            {
                url: "https://wikidata.example/deduped.jpg",
                source: "wikidata",
            },
            {
                url: "https://wikidata.example/deduped.jpg",
                source: "wikidata",
            },
        ]);
        expect(mockWikidataArtistInfo).toHaveBeenCalledTimes(1);
    });
});
