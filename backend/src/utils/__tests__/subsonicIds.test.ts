import {
    parseSubsonicId,
    SubsonicIdError,
    toSubsonicId,
} from "../subsonicIds";

describe("subsonicIds", () => {
    it("formats IDs with deterministic prefixes", () => {
        expect(toSubsonicId("artist", "abc123")).toBe("ar-abc123");
        expect(toSubsonicId("album", "abc123")).toBe("al-abc123");
        expect(toSubsonicId("track", "abc123")).toBe("tr-abc123");
        expect(toSubsonicId("playlist", "abc123")).toBe("pl-abc123");
    });

    it("parses prefixed IDs", () => {
        expect(parseSubsonicId("ar-artist1", "artist")).toEqual({
            type: "artist",
            id: "artist1",
        });
        expect(parseSubsonicId("al-album1", "album")).toEqual({
            type: "album",
            id: "album1",
        });
    });

    it("accepts raw IDs when expected type is provided", () => {
        expect(parseSubsonicId("cuid_123", "track")).toEqual({
            type: "track",
            id: "cuid_123",
        });
    });

    it("accepts raw IDs containing dashes when expected type is provided", () => {
        expect(parseSubsonicId("legacy-id-with-dashes", "playlist")).toEqual({
            type: "playlist",
            id: "legacy-id-with-dashes",
        });
    });

    it("rejects mismatched prefixed IDs", () => {
        expect(() => parseSubsonicId("al-123", "artist")).toThrow(SubsonicIdError);
    });

    it("requires expected type for unprefixed IDs", () => {
        expect(() => parseSubsonicId("raw-id")).toThrow(SubsonicIdError);
    });
});
