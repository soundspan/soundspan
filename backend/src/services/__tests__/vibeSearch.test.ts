const mockFindTracksByTextEmbedding = jest.fn();
const mockResolveTextEmbedding = jest.fn();
const mockExpandQueryWithVocabulary = jest.fn();
const mockGetVocabularyForSpace = jest.fn();
const mockRerankWithFeatures = jest.fn();

jest.mock("../../utils/logger", () => ({
    logger: { info: jest.fn() },
}));
jest.mock("../trackEmbeddings", () => ({
    findTracksByTextEmbedding: (...args: unknown[]) =>
        mockFindTracksByTextEmbedding(...args),
}));
jest.mock("../textEmbedding", () => ({
    resolveTextEmbedding: (...args: unknown[]) =>
        mockResolveTextEmbedding(...args),
}));
jest.mock("../vibeVocabulary", () => ({
    expandQueryWithVocabulary: (...args: unknown[]) =>
        mockExpandQueryWithVocabulary(...args),
    getVocabularyForSpace: (...args: unknown[]) =>
        mockGetVocabularyForSpace(...args),
    rerankWithFeatures: (...args: unknown[]) => mockRerankWithFeatures(...args),
}));

import {
    distanceToSearchSimilarity,
    executeVibeSearch,
    parseVibeSearchRequest,
} from "../vibeSearch";

describe("vibe search decisions", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockFindTracksByTextEmbedding.mockResolvedValue([]);
        mockResolveTextEmbedding.mockResolvedValue({
            embedding: [1, 0],
            spaceId: "space-student",
            family: "student",
            checkpointHash: "student-hash",
        });
        mockGetVocabularyForSpace.mockReturnValue(null);
    });

    it.each([undefined, null, 42, " ", "a"])(
        "rejects an invalid query %p",
        (query) => {
            expect(parseVibeSearchRequest({ query })).toEqual({
                ok: false,
                error: "Query must be at least 2 characters",
            });
        },
    );

    it("normalizes and bounds search controls", () => {
        expect(
            parseVibeSearchRequest({
                query: "  quiet focus  ",
                limit: 500,
                minSimilarity: -2,
            }),
        ).toEqual({
            ok: true,
            value: {
                normalizedQuery: "quiet focus",
                limit: 100,
                similarityThreshold: 0,
            },
        });
    });

    it.each([
        [0, 1],
        [0.7, 0.65],
        [2, 0],
        [3, 0],
    ])("maps distance %s to similarity %s", (distance, similarity) => {
        expect(distanceToSearchSimilarity(distance)).toBe(similarity);
    });

    it("blends a matching space-bound vocabulary into the search query", async () => {
        const vocabulary = { terms: {} };
        const expansion = {
            embedding: [0.8, 0.2],
            genreConfidence: 0.7,
            matchedTerms: [],
            originalQuery: "quiet focus",
        };
        mockGetVocabularyForSpace.mockReturnValue(vocabulary);
        mockExpandQueryWithVocabulary.mockReturnValue(expansion);

        await executeVibeSearch({
            normalizedQuery: "quiet focus",
            limit: 20,
            similarityThreshold: 0.6,
        });

        expect(mockGetVocabularyForSpace).toHaveBeenCalledWith({
            family: "student",
            checkpointHash: "student-hash",
        });
        expect(mockExpandQueryWithVocabulary).toHaveBeenCalledWith(
            [1, 0],
            "quiet focus",
            vocabulary,
        );
        expect(mockFindTracksByTextEmbedding).toHaveBeenCalledWith(
            [0.8, 0.2],
            0.8,
            60,
            "space-student",
        );
    });

    it("uses the provider vector unchanged when vocabulary is incompatible", async () => {
        await executeVibeSearch({
            normalizedQuery: "quiet focus",
            limit: 20,
            similarityThreshold: 0.6,
        });

        expect(mockExpandQueryWithVocabulary).not.toHaveBeenCalled();
        expect(mockFindTracksByTextEmbedding).toHaveBeenCalledWith(
            [1, 0],
            0.8,
            60,
            "space-student",
        );
    });

    it("serializes measured and unmeasured loudness fields", async () => {
        mockFindTracksByTextEmbedding.mockResolvedValueOnce([
            {
                id: "track-measured",
                title: "Measured",
                duration: 183,
                trackNo: 2,
                distance: 0.2,
                albumId: "album-1",
                albumTitle: "Album One",
                albumCoverUrl: null,
                artistId: "artist-1",
                artistName: "Artist One",
                loudnessLufs: -17.3,
                truePeakDb: -1.1,
                albumLoudnessLufs: -18.4,
                albumTruePeakDb: -0.7,
            },
            {
                id: "track-unmeasured",
                title: "Unmeasured",
                duration: 191,
                trackNo: 3,
                distance: 0.3,
                albumId: "album-2",
                albumTitle: "Album Two",
                albumCoverUrl: null,
                artistId: "artist-2",
                artistName: "Artist Two",
                loudnessLufs: null,
                truePeakDb: null,
                albumLoudnessLufs: null,
                albumTruePeakDb: null,
            },
        ]);

        const result = await executeVibeSearch({
            normalizedQuery: "measured focus",
            limit: 20,
            similarityThreshold: 0.6,
        });

        expect(result.tracks).toEqual([
            expect.objectContaining({
                id: "track-measured",
                loudnessLufs: -17.3,
                truePeakDb: -1.1,
                album: expect.objectContaining({
                    albumLoudnessLufs: -18.4,
                    albumTruePeakDb: -0.7,
                }),
            }),
            expect.objectContaining({
                id: "track-unmeasured",
                loudnessLufs: null,
                truePeakDb: null,
                album: expect.objectContaining({
                    albumLoudnessLufs: null,
                    albumTruePeakDb: null,
                }),
            }),
        ]);
    });
});
