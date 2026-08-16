const mockConfig = {
    nodeEnv: "test",
    oidc: {
        enabled: true,
        issuerUrl: "https://idp.example/realms/soundspan",
        clientId: "soundspan",
        clientSecret: "oidc-secret",
        redirectUri: "https://music.example/api/auth/oidc/callback",
        scopes: "openid profile email",
        manageRoles: true,
        groupsClaim: "realm.groups",
        emailClaim: "profile.email",
        nameClaim: "profile.name",
    },
};

jest.mock("../../config", () => ({ config: mockConfig }));

const configuration = { timeout: undefined as number | undefined };
const discovery = jest.fn(async () => configuration);
const randomState = jest.fn(() => "state-1");
const randomNonce = jest.fn(() => "nonce-1");
const randomPKCECodeVerifier = jest.fn(() => "verifier-1");
const calculatePKCECodeChallenge = jest.fn(async () => "challenge-1");
const buildAuthorizationUrl = jest.fn(
    () => new URL("https://idp.example/auth?state=state-1"),
);
const authorizationCodeGrant = jest.fn(
    async (): Promise<{ claims: () => unknown }> => ({
        claims: () => ({
            sub: "subject-1",
            preferred_username: "alice",
            email_verified: true,
            profile: { email: "alice@example.com", name: "Alice Example" },
            realm: { groups: ["listeners", "soundspan-admins"] },
        }),
    }),
);

const openIdClient = {
    discovery,
    randomState,
    randomNonce,
    randomPKCECodeVerifier,
    calculatePKCECodeChallenge,
    buildAuthorizationUrl,
    authorizationCodeGrant,
};

import {
    __resetOpenIdClientForTests,
    __setOpenIdClientForTests,
    buildAuthorizationRequest,
    getOidcProviderId,
    handleCallback,
} from "../oidcAuth";

describe("oidcAuth", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockConfig.oidc.enabled = true;
        mockConfig.oidc.manageRoles = true;
        __resetOpenIdClientForTests();
        __setOpenIdClientForTests(
            openIdClient as unknown as Parameters<
                typeof __setOpenIdClientForTests
            >[0],
        );
    });

    it("builds a state, nonce, and S256 PKCE authorization request with bounded discovery", async () => {
        const result = await buildAuthorizationRequest();

        expect(discovery).toHaveBeenCalledWith(
            new URL(mockConfig.oidc.issuerUrl),
            "soundspan",
            "oidc-secret",
            undefined,
            { timeout: 10 },
        );
        expect(buildAuthorizationUrl).toHaveBeenCalledWith(configuration, {
            redirect_uri: mockConfig.oidc.redirectUri,
            scope: mockConfig.oidc.scopes,
            state: "state-1",
            nonce: "nonce-1",
            code_challenge: "challenge-1",
            code_challenge_method: "S256",
        });
        expect(result).toEqual({
            redirectUrl: "https://idp.example/auth?state=state-1",
            state: "state-1",
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
        });
    });

    it("validates callback checks and zod-parses configured claims", async () => {
        const result = await handleCallback(
            "https://music.example/api/auth/oidc/callback?state=state-1&code=abc",
            {
                state: "state-1",
                nonce: "nonce-1",
                codeVerifier: "verifier-1",
            },
        );

        expect(authorizationCodeGrant).toHaveBeenCalledWith(
            configuration,
            new URL(
                "https://music.example/api/auth/oidc/callback?state=state-1&code=abc",
            ),
            {
                expectedState: "state-1",
                expectedNonce: "nonce-1",
                pkceCodeVerifier: "verifier-1",
                idTokenExpected: true,
            },
            { redirect_uri: mockConfig.oidc.redirectUri },
        );
        expect(result).toEqual({
            sub: "subject-1",
            email: "alice@example.com",
            emailVerified: true,
            name: "Alice Example",
            preferredUsername: "alice",
            groups: ["listeners", "soundspan-admins"],
        });
    });

    it("rejects malformed claims before domain use", async () => {
        authorizationCodeGrant.mockResolvedValueOnce({
            claims: () => ({ sub: 42 }),
        });

        await expect(
            handleCallback(
                "https://music.example/api/auth/oidc/callback?state=state-1&code=abc",
                {
                    state: "state-1",
                    nonce: "nonce-1",
                    codeVerifier: "verifier-1",
                },
            ),
        ).rejects.toThrow();
    });

    it("rejects malformed configured email claims", async () => {
        authorizationCodeGrant.mockResolvedValueOnce({
            claims: () => ({ sub: "subject-2", profile: { email: 42 } }),
        });

        await expect(
            handleCallback(
                "https://music.example/api/auth/oidc/callback?state=state-1&code=abc",
                {
                    state: "state-1",
                    nonce: "nonce-1",
                    codeVerifier: "verifier-1",
                },
            ),
        ).rejects.toThrow();
    });

    it("does not consume the groups claim when role management is disabled", async () => {
        mockConfig.oidc.manageRoles = false;
        authorizationCodeGrant.mockResolvedValueOnce({
            claims: () => ({
                sub: "subject-2",
                realm: { groups: "not-an-array" },
            }),
        });

        await expect(
            handleCallback(
                "https://music.example/api/auth/oidc/callback?state=state-1&code=abc",
                {
                    state: "state-1",
                    nonce: "nonce-1",
                    codeVerifier: "verifier-1",
                },
            ),
        ).resolves.toEqual({
            sub: "subject-2",
            email: null,
            emailVerified: false,
            name: null,
            preferredUsername: null,
            groups: [],
        });
    });

    it("caches discovery and returns the issuer-derived provider id", async () => {
        await buildAuthorizationRequest();
        await buildAuthorizationRequest();

        expect(discovery).toHaveBeenCalledTimes(1);
        expect(getOidcProviderId()).toBe(`oidc:${mockConfig.oidc.issuerUrl}`);
    });
});
