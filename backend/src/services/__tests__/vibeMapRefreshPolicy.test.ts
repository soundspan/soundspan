import {
    decideVibeMapRefresh,
    VIBE_MAP_REFRESH_MIN_DRIFT,
    VIBE_MAP_REFRESH_MIN_DRIFT_RATIO,
} from "../vibeMapRefreshPolicy";

describe("decideVibeMapRefresh", () => {
    it("refreshes a legacy cached payload with an unknown count", () => {
        expect(
            decideVibeMapRefresh({
                cachedEmbeddedCount: undefined,
                currentEmbeddedCount: 100,
            }),
        ).toBe("count_unknown");
    });

    it.each([
        { cachedEmbeddedCount: 100, currentEmbeddedCount: 149 },
        { cachedEmbeddedCount: 1000, currentEmbeddedCount: 1099 },
        { cachedEmbeddedCount: 1000, currentEmbeddedCount: 901 },
        { cachedEmbeddedCount: 0, currentEmbeddedCount: 49 },
    ])("keeps bounded drift fresh for %o", (input) => {
        expect(decideVibeMapRefresh(input)).toBe("fresh");
    });

    it.each([
        { cachedEmbeddedCount: 100, currentEmbeddedCount: 150 },
        { cachedEmbeddedCount: 1000, currentEmbeddedCount: 1100 },
        { cachedEmbeddedCount: 1000, currentEmbeddedCount: 900 },
        { cachedEmbeddedCount: 0, currentEmbeddedCount: 50 },
    ])("refreshes when both drift boundaries are met for %o", (input) => {
        expect(decideVibeMapRefresh(input)).toBe("count_drift");
    });

    it("exports the decided drift thresholds", () => {
        expect(VIBE_MAP_REFRESH_MIN_DRIFT).toBe(50);
        expect(VIBE_MAP_REFRESH_MIN_DRIFT_RATIO).toBe(0.1);
    });

    it.each([
        { cachedEmbeddedCount: Number.NaN, currentEmbeddedCount: 100 },
        { cachedEmbeddedCount: Infinity, currentEmbeddedCount: 100 },
        { cachedEmbeddedCount: -1, currentEmbeddedCount: 100 },
        { cachedEmbeddedCount: 1.5, currentEmbeddedCount: 100 },
        { cachedEmbeddedCount: undefined, currentEmbeddedCount: Number.NaN },
        { cachedEmbeddedCount: 100, currentEmbeddedCount: Number.NaN },
        { cachedEmbeddedCount: 100, currentEmbeddedCount: Infinity },
        { cachedEmbeddedCount: 100, currentEmbeddedCount: -1 },
        { cachedEmbeddedCount: 100, currentEmbeddedCount: 1.5 },
    ])("fails closed for invalid input %o", (input) => {
        expect(decideVibeMapRefresh(input)).toBe("fresh");
    });
});
