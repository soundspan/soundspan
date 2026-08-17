jest.mock("../../utils/logger", () => ({
    logger: { info: jest.fn() },
}));
jest.mock("../trackEmbeddings", () => ({
    findTracksByTextEmbedding: jest.fn(),
}));
jest.mock("../textEmbedding", () => ({ resolveTextEmbedding: jest.fn() }));
jest.mock("../vibeVocabulary", () => ({
    expandQueryWithVocabulary: jest.fn(),
    getVocabulary: jest.fn(() => null),
    rerankWithFeatures: jest.fn(),
}));

import {
    distanceToSearchSimilarity,
    parseVibeSearchRequest,
} from "../vibeSearch";

describe("vibe search decisions", () => {
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
});
