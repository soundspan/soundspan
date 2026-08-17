import {
    generateVibeVocabulary,
    requireVibeProviderUrl,
} from "../vibeVocabularyGenerator";

describe("vibe vocabulary generator", () => {
    it("transforms provider embeddings into the existing vocabulary schema", async () => {
        const embed = jest
            .fn<Promise<number[]>, [string]>()
            .mockResolvedValueOnce([1, 0])
            .mockResolvedValueOnce([0, 1]);

        const result = await generateVibeVocabulary({
            termNames: ["ambient", "energetic"],
            definitions: {
                ambient: {
                    type: "genre",
                    featureProfile: { energy: 0.2 },
                    related: ["drone"],
                },
                energetic: {
                    type: "mood",
                    featureProfile: { energy: 0.9 },
                },
            },
            embed,
            generatedAt: "2026-08-16T12:00:00.000Z",
        });

        expect(result).toEqual({
            vocabulary: {
                version: "1.0.0",
                generatedAt: "2026-08-16T12:00:00.000Z",
                terms: {
                    ambient: {
                        name: "ambient",
                        type: "genre",
                        embedding: [1, 0],
                        featureProfile: { energy: 0.2 },
                        related: ["drone"],
                    },
                    energetic: {
                        name: "energetic",
                        type: "mood",
                        embedding: [0, 1],
                        featureProfile: { energy: 0.9 },
                    },
                },
            },
            succeeded: 2,
            failed: [],
        });
    });

    it("keeps successful terms when one provider request fails", async () => {
        const embed = jest
            .fn<Promise<number[]>, [string]>()
            .mockRejectedValueOnce(new Error("provider unavailable"))
            .mockResolvedValueOnce([0, 1]);

        const result = await generateVibeVocabulary({
            termNames: ["ambient", "energetic"],
            definitions: {
                ambient: { type: "genre", featureProfile: {} },
                energetic: { type: "mood", featureProfile: {} },
            },
            embed,
            generatedAt: "2026-08-16T12:00:00.000Z",
        });

        expect(result.succeeded).toBe(1);
        expect(result.failed).toEqual(["ambient"]);
        expect(Object.keys(result.vocabulary.terms)).toEqual(["energetic"]);
    });

    it("requires the provider URL with an operator-facing message", () => {
        expect(() => requireVibeProviderUrl(undefined)).toThrow(
            "VIBE_PROVIDER_URL is required to generate the vibe vocabulary",
        );
    });
});
