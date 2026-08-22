import {
    FEDERATION_SCOPE_VALUES,
    parseFederationScopes,
} from "../federationScopes";

describe("federation scopes", () => {
    it("accepts the complete four-scope vocabulary", () => {
        expect(parseFederationScopes([...FEDERATION_SCOPE_VALUES])).toEqual([
            "library:read",
            "stream:read",
            "embeddings:read",
            "social:read",
        ]);
    });

    it("rejects social access without library access", () => {
        expect(parseFederationScopes(["social:read"])).toBeNull();
    });

    it("keeps the legacy three-scope set valid", () => {
        expect(
            parseFederationScopes([
                "library:read",
                "stream:read",
                "embeddings:read",
            ]),
        ).toEqual(["library:read", "stream:read", "embeddings:read"]);
    });
});
