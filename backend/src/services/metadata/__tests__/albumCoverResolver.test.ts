const mockCoverArtGet = jest.fn();
const mockDeezerAlbumCover = jest.fn();
const mockFanartAlbumCover = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSetEx = jest.fn();

jest.mock("../../coverArt", () => ({
    coverArtService: { getCoverArt: mockCoverArtGet },
}));

jest.mock("../../deezer", () => ({
    deezerService: { getAlbumCover: mockDeezerAlbumCover },
}));

jest.mock("../../fanart", () => ({
    fanartService: { getAlbumCover: mockFanartAlbumCover },
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

import { resolveAlbumCover } from "../albumCoverResolver";

const REAL_RG_MBID = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3";
const INPUT = {
    artistName: "Radiohead",
    albumTitle: "In Rainbows",
    rgMbid: REAL_RG_MBID,
};

describe("resolveAlbumCover", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue(undefined);
        mockCoverArtGet.mockResolvedValue(null);
        mockDeezerAlbumCover.mockResolvedValue(null);
        mockFanartAlbumCover.mockResolvedValue(null);
    });

    it("runs the canonical ladder in order and short-circuits on Deezer", async () => {
        const calls: string[] = [];
        mockCoverArtGet.mockImplementation(async () => {
            calls.push("coverartarchive");
            return null;
        });
        mockDeezerAlbumCover.mockImplementation(async () => {
            calls.push("deezer");
            return "https://deezer.example/album.jpg";
        });
        mockFanartAlbumCover.mockImplementation(async () => {
            calls.push("fanart");
            return null;
        });

        await expect(resolveAlbumCover(INPUT)).resolves.toEqual({
            url: "https://deezer.example/album.jpg",
            source: "deezer",
        });
        expect(calls).toEqual(["coverartarchive", "deezer"]);
        expect(mockCoverArtGet).toHaveBeenCalledWith(REAL_RG_MBID);
        expect(mockDeezerAlbumCover).toHaveBeenCalledWith(
            "Radiohead",
            "In Rainbows",
        );
        expect(mockFanartAlbumCover).not.toHaveBeenCalled();
    });

    it.each([
        undefined,
        null,
        "temp-album",
        "remote:deezer:123",
        "federation:peer:album",
    ])("skips release-group-gated rungs for %p", async (rgMbid) => {
        mockDeezerAlbumCover.mockResolvedValue(
            "https://deezer.example/no-mbid.jpg",
        );

        await expect(
            resolveAlbumCover({
                artistName: "No MBID",
                albumTitle: "Album",
                rgMbid,
            }),
        ).resolves.toEqual({
            url: "https://deezer.example/no-mbid.jpg",
            source: "deezer",
        });
        expect(mockCoverArtGet).not.toHaveBeenCalled();
        expect(mockFanartAlbumCover).not.toHaveBeenCalled();
    });

    it("uses Fanart only after Cover Art Archive and Deezer miss", async () => {
        mockFanartAlbumCover.mockResolvedValue(
            "https://fanart.example/album.jpg",
        );

        await expect(resolveAlbumCover(INPUT)).resolves.toEqual({
            url: "https://fanart.example/album.jpg",
            source: "fanart",
        });
        expect(mockFanartAlbumCover).toHaveBeenCalledWith(REAL_RG_MBID);
    });

    it("uses a negative cache entry without re-hitting providers", async () => {
        mockRedisGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(JSON.stringify({ status: "miss" }));

        await expect(resolveAlbumCover(INPUT)).resolves.toBeNull();
        await expect(resolveAlbumCover(INPUT)).resolves.toBeNull();

        expect(mockCoverArtGet).toHaveBeenCalledTimes(1);
        expect(mockDeezerAlbumCover).toHaveBeenCalledTimes(1);
        expect(mockFanartAlbumCover).toHaveBeenCalledTimes(1);
    });

    it("caches successful resolutions for seven days", async () => {
        mockCoverArtGet.mockResolvedValue(
            "https://coverartarchive.example/front.jpg",
        );

        await resolveAlbumCover(INPUT);

        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "metadata:album-cover:radiohead::in%20rainbows",
            7 * 24 * 60 * 60,
            JSON.stringify({
                status: "hit",
                value: {
                    url: "https://coverartarchive.example/front.jpg",
                    source: "coverartarchive",
                },
            }),
        );
    });

    it("negative-caches permanent misses for one day", async () => {
        await expect(resolveAlbumCover(INPUT)).resolves.toBeNull();

        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "metadata:album-cover:radiohead::in%20rainbows",
            24 * 60 * 60,
            JSON.stringify({ status: "miss" }),
        );
    });

    it("stops later rungs when the shared budget expires", async () => {
        jest.useFakeTimers();
        mockCoverArtGet.mockReturnValue(new Promise(() => undefined));

        try {
            const pending = resolveAlbumCover(INPUT);
            await jest.advanceTimersByTimeAsync(8_000);
            await expect(pending).resolves.toBeNull();
            expect(mockDeezerAlbumCover).not.toHaveBeenCalled();
            expect(mockFanartAlbumCover).not.toHaveBeenCalled();
            expect(mockRedisSetEx).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });

    it("does not poison the negative cache after a transient provider error", async () => {
        mockDeezerAlbumCover.mockRejectedValue(new Error("Deezer timeout"));

        await expect(resolveAlbumCover(INPUT)).resolves.toBeNull();
        await expect(resolveAlbumCover(INPUT)).resolves.toBeNull();

        expect(mockDeezerAlbumCover).toHaveBeenCalledTimes(2);
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("deduplicates concurrent resolution for normalized album identity", async () => {
        let finishCoverArt: ((value: string) => void) | undefined;
        mockCoverArtGet.mockReturnValue(
            new Promise((resolve) => {
                finishCoverArt = resolve;
            }),
        );

        const first = resolveAlbumCover(INPUT);
        const second = resolveAlbumCover({
            artistName: "  RADIOHEAD  ",
            albumTitle: "  IN RAINBOWS  ",
            rgMbid: REAL_RG_MBID,
        });
        await Promise.resolve();
        finishCoverArt?.("https://coverartarchive.example/deduped.jpg");

        await expect(Promise.all([first, second])).resolves.toEqual([
            {
                url: "https://coverartarchive.example/deduped.jpg",
                source: "coverartarchive",
            },
            {
                url: "https://coverartarchive.example/deduped.jpg",
                source: "coverartarchive",
            },
        ]);
        expect(mockCoverArtGet).toHaveBeenCalledTimes(1);
    });
});
