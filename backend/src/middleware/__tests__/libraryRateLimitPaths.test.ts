import { isLibraryMediaPath } from "../libraryRateLimitPaths";

describe("library rate-limit path classification", () => {
    it.each([
        "/cover-art",
        "/cover-art/album-1",
        "/album-cover/release-1",
        "/cover-art-colors",
        "/tracks/track-1/stream",
        "/tracks/track-1/stream/",
        "/tracks/track-1/stream/extra",
        "/COVER-ART/album-1",
        "/Album-Cover/release-1",
        "/TRACKS/track-1/STREAM",
    ])("classifies the mounted media path %s", (path) => {
        expect(isLibraryMediaPath(path)).toBe(true);
    });

    it.each([
        "/api/library/cover-art/album-1",
        "/cover-artificial/album-1",
        "/tracks/track-1/preference",
        "/tracks/track-1",
    ])("does not classify the metadata path %s", (path) => {
        expect(isLibraryMediaPath(path)).toBe(false);
    });
});
