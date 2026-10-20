import { discographyCacheTtlSeconds } from "../discographyCachePolicy";

describe("discography cache policy", () => {
    it("short-caches an empty release-group list", () => {
        expect(discographyCacheTtlSeconds(0)).toBe(120);
    });

    it("caches a non-empty release-group list for one day", () => {
        expect(discographyCacheTtlSeconds(1)).toBe(86_400);
        expect(discographyCacheTtlSeconds(100)).toBe(86_400);
    });

    it.each([-1, Number.NaN, 1.5])(
        "short-caches invalid release-group count %s",
        (releaseGroupCount) => {
            expect(discographyCacheTtlSeconds(releaseGroupCount)).toBe(120);
        },
    );
});
