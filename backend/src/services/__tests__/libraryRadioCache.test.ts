const redisClient = {
    get: jest.fn(),
    setEx: jest.fn(),
};
const getSearchCacheVersion = jest.fn();
const trackFindMany = jest.fn();
const queryRaw = jest.fn();
const findSimilarTracks = jest.fn();

jest.mock("../../utils/redis", () => ({ redisClient }));
jest.mock("../../utils/db", () => ({
    prisma: {
        track: { findMany: trackFindMany },
        $queryRaw: queryRaw,
    },
}));
jest.mock("../searchCacheVersion", () => ({ getSearchCacheVersion }));
jest.mock("../hybridSimilarity", () => ({ findSimilarTracks }));
jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn() }) },
}));

import {
    RADIO_ANN_CANDIDATE_LIMIT,
    RADIO_SCALAR_CANDIDATE_LIMIT,
    buildDecadeAggregateQuery,
    buildGenreAggregateQuery,
    loadDecadeRadioAggregates,
    loadGenreRadioAggregates,
    loadRadioIdCandidatePool,
    loadScalarRadioCandidatePool,
    loadVibeRadioCandidateIds,
} from "../libraryRadioCache";

interface SqlFragment {
    strings: readonly string[];
    values: readonly unknown[];
}

function inspectSql(fragment: SqlFragment): {
    text: string;
    values: readonly unknown[];
} {
    return { text: fragment.strings.join("?"), values: fragment.values };
}

const scalarCandidate = {
    id: "candidate-1",
    bpm: 120,
    energy: 0.7,
    valence: 0.6,
    arousal: 0.65,
    danceability: 0.55,
    keyScale: "major",
    moodTags: ["upbeat"],
    lastfmTags: ["rock"],
    essentiaGenres: ["rock"],
    instrumentalness: 0.1,
    moodHappy: 0.8,
    moodSad: 0.1,
    moodRelaxed: 0.2,
    moodAggressive: 0.4,
    moodParty: 0.7,
    moodAcoustic: 0.2,
    moodElectronic: 0.4,
    danceabilityMl: 0.58,
    analysisMode: "enhanced",
    analysisVersion: "2.1b6-enhanced-v3-test",
    origin: "LOCAL",
    dedupOfTrackId: null,
    federationPeer: null,
    dedupOfTrack: null,
    album: { artistId: "artist-1", location: "LIBRARY" },
};

describe("library radio aggregate SQL", () => {
    it("folds artist-name blocking into the genre aggregate query", () => {
        const query = inspectSql(buildGenreAggregateQuery());

        expect(query.text).toContain("NOT EXISTS");
        expect(query.text).toContain(
            "LOWER(blocked_artist.name) = LOWER(g.genre)",
        );
        expect(query.text).toContain(
            'LOWER(blocked_artist."normalizedName") = LOWER(g.genre)',
        );
        expect(query.values).toEqual(expect.arrayContaining([15, 20]));
    });

    it("groups decades by the effective-year expression in PostgreSQL", () => {
        const query = inspectSql(buildDecadeAggregateQuery());

        expect(query.text).toContain(
            'COALESCE(a."displayYear", a."originalYear", a.year)',
        );
        expect(query.text).toContain("GROUP BY decade");
        expect(query.text).toContain("HAVING COUNT(t.id) >=");
        expect(query.values).toContain(15);
    });
});

describe("library radio cache", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getSearchCacheVersion.mockResolvedValue(7);
        redisClient.get.mockResolvedValue(null);
        redisClient.setEx.mockResolvedValue("OK");
        queryRaw.mockResolvedValue([]);
        trackFindMany.mockResolvedValue([]);
        findSimilarTracks.mockResolvedValue([]);
    });

    it("caches validated genre aggregates on a miss", async () => {
        queryRaw.mockResolvedValue([{ genre: "rock", track_count: 27n }]);

        await expect(loadGenreRadioAggregates()).resolves.toEqual([
            { genre: "rock", count: 27 },
        ]);

        expect(redisClient.get).toHaveBeenCalledWith("library:genres:v7");
        expect(queryRaw).toHaveBeenCalledTimes(1);
        expect(redisClient.setEx).toHaveBeenCalledWith(
            "library:genres:v7",
            300,
            JSON.stringify([{ genre: "rock", count: 27 }]),
        );
    });

    it("returns a valid cached decade aggregate without querying PostgreSQL", async () => {
        const cached = [{ decade: 1990, count: 42 }];
        redisClient.get.mockResolvedValue(JSON.stringify(cached));

        await expect(loadDecadeRadioAggregates()).resolves.toEqual(cached);

        expect(queryRaw).not.toHaveBeenCalled();
        expect(redisClient.setEx).not.toHaveBeenCalled();
    });

    it("uses a fresh aggregate namespace after invalidation", async () => {
        getSearchCacheVersion.mockResolvedValueOnce(7).mockResolvedValueOnce(8);
        redisClient.get.mockResolvedValue(null);

        await loadGenreRadioAggregates();
        await loadGenreRadioAggregates();

        expect(redisClient.get).toHaveBeenNthCalledWith(1, "library:genres:v7");
        expect(redisClient.get).toHaveBeenNthCalledWith(2, "library:genres:v8");
        expect(queryRaw).toHaveBeenCalledTimes(2);
    });

    it("bounds a deterministically ordered pool of visible scalar candidates", async () => {
        trackFindMany.mockResolvedValue([scalarCandidate]);

        await expect(loadScalarRadioCandidatePool()).resolves.toEqual([
            expect.objectContaining({
                id: "candidate-1",
                album: { artistId: "artist-1" },
            }),
        ]);

        expect(trackFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    analysisStatus: "completed",
                    removedAt: null,
                    album: {
                        location: {
                            in: ["LIBRARY", "DISCOVER", "REMOTE", "FEDERATED"],
                        },
                    },
                    OR: [
                        { origin: "LOCAL" },
                        {
                            origin: "FEDERATED",
                            OR: [
                                { dedupOfTrackId: null },
                                {
                                    federationPeer: {
                                        showDedupedCopies: true,
                                    },
                                },
                                {
                                    dedupOfTrack: {
                                        removedAt: { not: null },
                                    },
                                },
                            ],
                        },
                    ],
                },
                orderBy: { id: "asc" },
                take: RADIO_SCALAR_CANDIDATE_LIMIT,
            }),
        );
    });

    it("coalesces concurrent misses for the same cache key", async () => {
        let releaseQuery:
            | ((rows: { genre: string; track_count: bigint }[]) => void)
            | undefined;
        let markQueryStarted: (() => void) | undefined;
        const queryStarted = new Promise<void>((resolve) => {
            markQueryStarted = resolve;
        });
        queryRaw.mockImplementationOnce(() => {
            markQueryStarted?.();
            return new Promise((resolve) => {
                releaseQuery = resolve;
            });
        });

        const first = loadGenreRadioAggregates();
        const second = loadGenreRadioAggregates();
        await queryStarted;

        expect(queryRaw).toHaveBeenCalledTimes(1);
        releaseQuery?.([{ genre: "rock", track_count: 27n }]);
        await expect(Promise.all([first, second])).resolves.toEqual([
            [{ genre: "rock", count: 27 }],
            [{ genre: "rock", count: 27 }],
        ]);
        expect(redisClient.setEx).toHaveBeenCalledTimes(1);
    });

    it("caches a bounded ANN id pool under an escaped source key", async () => {
        findSimilarTracks.mockResolvedValue([
            { id: "similar-1" },
            { id: "similar-2" },
        ]);

        await expect(loadVibeRadioCandidateIds("source:/?%")).resolves.toEqual([
            "similar-1",
            "similar-2",
        ]);

        expect(redisClient.get).toHaveBeenCalledWith(
            "library:radio:vibe:v7:source%3A%2F%3F%25",
        );
        expect(findSimilarTracks).toHaveBeenCalledWith(
            "source:/?%",
            RADIO_ANN_CANDIDATE_LIMIT,
        );
    });

    it("caches a reusable radio id pool without caching final shuffle order", async () => {
        const loader = jest.fn().mockResolvedValue(["pool-1", "pool-2"]);

        await expect(
            loadRadioIdCandidatePool("genre:drum/bass:50", loader),
        ).resolves.toEqual(["pool-1", "pool-2"]);

        expect(redisClient.get).toHaveBeenCalledWith(
            "library:radio:ids:v7:genre%3Adrum%2Fbass%3A50",
        );
        expect(loader).toHaveBeenCalledTimes(1);
    });
});
