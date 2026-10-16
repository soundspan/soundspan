import { RemoteLibraryCapWarningLimiter } from "../capWarningLimiter";

describe("remote library cap warning limiter", () => {
    it("allows one warning per user and provider per hour", () => {
        let now = 1_000;
        const limiter = new RemoteLibraryCapWarningLimiter(() => now);

        expect(limiter.shouldWarn("user-1", "tidal")).toBe(true);
        expect(limiter.shouldWarn("user-1", "tidal")).toBe(false);
        expect(limiter.shouldWarn("user-1", "youtube")).toBe(true);
        expect(limiter.shouldWarn("user-2", "tidal")).toBe(true);
        now += 60 * 60 * 1_000;
        expect(limiter.shouldWarn("user-1", "tidal")).toBe(true);
    });

    it("bounds retained warning keys by evicting the oldest", () => {
        let now = 1_000;
        const limiter = new RemoteLibraryCapWarningLimiter(() => now, 2);

        expect(limiter.shouldWarn("user-1", "tidal")).toBe(true);
        now += 1;
        expect(limiter.shouldWarn("user-2", "tidal")).toBe(true);
        now += 1;
        expect(limiter.shouldWarn("user-3", "tidal")).toBe(true);
        expect(limiter.shouldWarn("user-1", "tidal")).toBe(true);
    });
});
