import {
    decodeFederationIdentity,
    federationDedupConfidence,
    type FederationDedupIdentity,
} from "../federationDedup";

function identity(
    overrides: Partial<FederationDedupIdentity> = {},
): FederationDedupIdentity {
    return {
        audioHash: null,
        recordingMbid: null,
        isrc: null,
        discNo: 1,
        trackNo: 1,
        albumRgMbid: null,
        ...overrides,
    };
}

describe("federationDedupConfidence", () => {
    it("matches the same release-group position", () => {
        const rgMbid = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3";
        const encoded = Buffer.from(rgMbid, "utf8").toString("base64url");

        expect(
            federationDedupConfidence(
                identity({ albumRgMbid: rgMbid }),
                identity({ albumRgMbid: `federation:peer-1:${encoded}` }),
            ),
        ).toBe(0.8);
    });

    it("never matches by position when an album has no release-group id", () => {
        expect(federationDedupConfidence(identity(), identity())).toBeNull();
        expect(
            federationDedupConfidence(
                identity({ albumRgMbid: "rg-1" }),
                identity(),
            ),
        ).toBeNull();
    });

    it("still matches by content identity without a release-group id", () => {
        expect(
            federationDedupConfidence(
                identity({ isrc: "USRC17607839" }),
                identity({ isrc: "USRC17607839" }),
            ),
        ).toBe(0.9);
    });
});

describe("decodeFederationIdentity", () => {
    it("returns non-federation identities unchanged", () => {
        expect(decodeFederationIdentity("remote:abc")).toBe("remote:abc");
    });
});
