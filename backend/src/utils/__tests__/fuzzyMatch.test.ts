import {
    normalizeForMatching,
    calculateSimilarity,
    fuzzyMatch,
    matchAlbum,
} from "../fuzzyMatch";

describe("fuzzyMatch utilities", () => {
    it("normalizes strings by removing articles, editions, punctuation, and extra whitespace", () => {
        expect(
            normalizeForMatching("  The Dark Side of the Moon (Deluxe Edition)  ")
        ).toBe("dark side of the moon");
        expect(
            normalizeForMatching("A [Remastered] Track - Anniversary Edition")
        ).toBe("track");
        expect(normalizeForMatching("An! Artist, Name?")).toBe("an artist name");
    });

    it("returns exact match similarity of 1.0 after normalization", () => {
        expect(calculateSimilarity("The Beatles", "beatles")).toBe(1);
    });

    it("returns 0 for empty normalized values", () => {
        expect(calculateSimilarity("", "anything")).toBe(0);
        expect(calculateSimilarity("the", "a")).toBe(0);
    });

    it("scores substring containment by shorter-to-longer length ratio", () => {
        const score = calculateSimilarity("Abbey Road", "The Abbey Road Deluxe");
        expect(score).toBeCloseTo(10 / 17, 4);
    });

    it("scores by word overlap when no direct containment exists", () => {
        const score = calculateSimilarity("Californication RHCP", "RHCP Live");
        expect(score).toBeCloseTo(0.5, 4);
    });

    it("applies threshold logic for fuzzyMatch and combined artist+album matching", () => {
        expect(fuzzyMatch("The Beatles", "Beatles", 0.7)).toBe(true);
        expect(fuzzyMatch("Miles Davis", "Metallica", 0.5)).toBe(false);

        expect(
            matchAlbum(
                "The Beatles",
                "Abbey Road (2019 Remaster)",
                "Beatles",
                "Abbey Road",
                0.7
            )
        ).toBe(true);

        expect(
            matchAlbum(
                "The Beatles",
                "Abbey Road",
                "Miles Davis",
                "Kind of Blue",
                0.8
            )
        ).toBe(false);
    });
});
