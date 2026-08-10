import {
    isSafeAudiobookCoverPath,
    buildSafeAudiobookCoverUrl,
} from "../audiobookCoverProxy";

describe("audiobookCoverProxy", () => {
    describe("isSafeAudiobookCoverPath", () => {
        it.each([
            "items/abc123/cover",
            "items/123e4567-e89b-12d3-a456-426614174000/cover",
            "items/covers/book-3.jpg",
            "items/li_abc/cover",
        ])("allows the confined ABS items path %s", (coverPath) => {
            expect(isSafeAudiobookCoverPath(coverPath)).toBe(true);
        });

        it.each([
            "items/../../api/me",
            "../api/me",
            "me",
            "items/x/cover/../../me",
            "/api/me",
            "items\\abc\\cover",
            "items/abc/cover?x=1",
            "items/%2e%2e/api/me",
            "covers/book-2.jpg",
            "",
        ])("rejects unsafe or out-of-namespace path %s", (coverPath) => {
            expect(isSafeAudiobookCoverPath(coverPath)).toBe(false);
        });
    });

    describe("buildSafeAudiobookCoverUrl", () => {
        it("rejects traversal without building a URL", () => {
            expect(
                buildSafeAudiobookCoverUrl(
                    "items/../../api/me",
                    "https://abs.example",
                ),
            ).toBeNull();
        });

        it("builds a confined ABS cover URL for the items namespace", () => {
            expect(
                buildSafeAudiobookCoverUrl(
                    "items/abc123/cover",
                    "https://abs.example",
                ),
            ).toBe("https://abs.example/api/items/abc123/cover");
        });

        it("builds a confined URL against an internal/LAN ABS host", () => {
            expect(
                buildSafeAudiobookCoverUrl(
                    "items/covers/book-3.jpg",
                    "http://audiobookshelf.local",
                ),
            ).toBe("http://audiobookshelf.local/api/items/covers/book-3.jpg");
        });
    });
});
