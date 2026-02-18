import {
    isPublicCoverArtUrl,
    parseCoverArtSize,
    resolveSubsonicStreamQuality,
    resolveTrackPathWithinRoot,
} from "../subsonicMedia";

describe("subsonicMedia", () => {
    describe("resolveSubsonicStreamQuality", () => {
        it("uses original when maxBitRate is missing", () => {
            expect(resolveSubsonicStreamQuality(undefined, undefined)).toBe("original");
        });

        it("uses original when target format is raw", () => {
            expect(resolveSubsonicStreamQuality("320", "raw")).toBe("original");
        });

        it("maps maxBitRate values to low/medium/high", () => {
            expect(resolveSubsonicStreamQuality("191", undefined)).toBe("low");
            expect(resolveSubsonicStreamQuality("192", undefined)).toBe("medium");
            expect(resolveSubsonicStreamQuality("320", undefined)).toBe("high");
        });

        it("falls back to original for invalid bitrate values", () => {
            expect(resolveSubsonicStreamQuality("nope", undefined)).toBe("original");
            expect(resolveSubsonicStreamQuality("0", undefined)).toBe("original");
        });
    });

    describe("resolveTrackPathWithinRoot", () => {
        it("resolves a normal relative track path", () => {
            const resolved = resolveTrackPathWithinRoot("/music", "artist/track.mp3");
            expect(resolved).toBe("/music/artist/track.mp3");
        });

        it("normalizes windows separators", () => {
            const resolved = resolveTrackPathWithinRoot("/music", "artist\\track.mp3");
            expect(resolved).toBe("/music/artist/track.mp3");
        });

        it("rejects traversal attempts outside root", () => {
            const resolved = resolveTrackPathWithinRoot("/music", "../../etc/passwd");
            expect(resolved).toBeNull();
        });

        it("rejects absolute paths outside root", () => {
            const resolved = resolveTrackPathWithinRoot("/music", "/tmp/track.mp3");
            expect(resolved).toBeNull();
        });

        it("allows absolute paths inside root", () => {
            const resolved = resolveTrackPathWithinRoot("/music", "/music/artist/track.mp3");
            expect(resolved).toBe("/music/artist/track.mp3");
        });
    });

    describe("parseCoverArtSize", () => {
        it("parses valid sizes", () => {
            expect(parseCoverArtSize("512")).toBe(512);
        });

        it("returns undefined for invalid values", () => {
            expect(parseCoverArtSize(undefined)).toBeUndefined();
            expect(parseCoverArtSize("abc")).toBeUndefined();
            expect(parseCoverArtSize("8")).toBeUndefined();
        });

        it("clamps very large values", () => {
            expect(parseCoverArtSize("9999")).toBe(2048);
        });
    });

    describe("isPublicCoverArtUrl", () => {
        it("accepts normal public http/https urls", () => {
            expect(isPublicCoverArtUrl("https://example.com/cover.jpg")).toBe(true);
            expect(isPublicCoverArtUrl("http://covers.example.org/a.png")).toBe(true);
        });

        it("rejects localhost and private network urls", () => {
            expect(isPublicCoverArtUrl("http://localhost:8080/cover.jpg")).toBe(false);
            expect(isPublicCoverArtUrl("http://127.0.0.1/cover.jpg")).toBe(false);
            expect(isPublicCoverArtUrl("http://10.0.0.8/cover.jpg")).toBe(false);
            expect(isPublicCoverArtUrl("http://192.168.1.2/cover.jpg")).toBe(false);
            expect(isPublicCoverArtUrl("http://172.16.1.10/cover.jpg")).toBe(false);
        });

        it("rejects unsupported protocols and invalid URLs", () => {
            expect(isPublicCoverArtUrl("file:///etc/passwd")).toBe(false);
            expect(isPublicCoverArtUrl("not-a-url")).toBe(false);
        });
    });
});
