import { createLastFmApiSignature } from "../../scrobbleSigning";

describe("createLastFmApiSignature", () => {
    it("matches a fixed MD5 signing vector and excludes response-only fields", () => {
        expect(
            createLastFmApiSignature(
                {
                    method: "track.scrobble",
                    artist: "Cher",
                    track: "Believe",
                    timestamp: "1234567890",
                    api_key: "abc123",
                    sk: "session",
                    format: "json",
                },
                "shared-secret",
            ),
        ).toBe("f97846aec4f81783807d1068596b3811"); // gitleaks:allow — md5 test vector
    });
});
