const mockResolveSafeOutboundUrl = jest.fn();

jest.mock("../outboundUrlSafety", () => ({
    resolveSafeOutboundUrl: (...args: unknown[]) =>
        mockResolveSafeOutboundUrl(...args),
}));

import {
    isSafeAudiobookCoverPath,
    resolveSafeAudiobookCoverUrl,
} from "../audiobookCoverProxy";

describe("audiobookCoverProxy", () => {
    beforeEach(() => {
        mockResolveSafeOutboundUrl.mockReset();
        mockResolveSafeOutboundUrl.mockImplementation(async (url: string) =>
            url.startsWith("https://") ? url : null,
        );
    });

    describe("isSafeAudiobookCoverPath", () => {
        it.each([
            "items/abc123/cover",
            "items/123e4567-e89b-12d3-a456-426614174000/cover",
        ])("allows the confined ABS cover path %s", (coverPath) => {
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
        ])("rejects unsafe or non-cover path %s", (coverPath) => {
            expect(isSafeAudiobookCoverPath(coverPath)).toBe(false);
        });
    });

    describe("resolveSafeAudiobookCoverUrl", () => {
        it("rejects traversal before building or resolving a URL", async () => {
            await expect(
                resolveSafeAudiobookCoverUrl(
                    "items/../../api/me",
                    "https://abs.example",
                ),
            ).resolves.toBeNull();
            expect(mockResolveSafeOutboundUrl).not.toHaveBeenCalled();
        });

        it("builds and resolves a confined ABS cover URL", async () => {
            await expect(
                resolveSafeAudiobookCoverUrl(
                    "items/abc123/cover",
                    "https://abs.example",
                ),
            ).resolves.toBe("https://abs.example/api/items/abc123/cover");
            expect(mockResolveSafeOutboundUrl).toHaveBeenCalledWith(
                "https://abs.example/api/items/abc123/cover",
            );
        });

        it("rejects a cover URL when the ABS host fails outbound safety", async () => {
            mockResolveSafeOutboundUrl.mockResolvedValueOnce(null);

            await expect(
                resolveSafeAudiobookCoverUrl(
                    "items/abc123/cover",
                    "https://abs.example",
                ),
            ).resolves.toBeNull();
        });
    });
});
