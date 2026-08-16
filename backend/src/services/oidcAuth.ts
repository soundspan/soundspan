import { z } from "zod";
import { config } from "../config";

type OpenIdClientModule = typeof import("openid-client");
type OidcConfiguration = Awaited<ReturnType<OpenIdClientModule["discovery"]>>;

/** State checks retained between an OIDC authorization request and callback. */
export interface OidcCallbackExpected {
    state: string;
    nonce: string;
    codeVerifier: string;
}

/** Values required to redirect to the configured OIDC provider. */
export interface OidcAuthorizationRequest {
    redirectUrl: string;
    state: string;
    nonce: string;
    codeVerifier: string;
}

/** Validated OIDC claims consumed by account resolution. */
export interface OidcClaims {
    sub: string;
    email: string | null;
    emailVerified: boolean;
    name: string | null;
    preferredUsername: string | null;
    groups: string[];
}

const oidcBaseClaimsSchema = z
    .object({
        sub: z.string().min(1),
        email_verified: z.boolean().optional(),
        preferred_username: z.string().min(1).optional(),
    })
    .loose();
const optionalClaimStringSchema = z.string().trim().min(1);
const groupsClaimSchema = z.array(z.string());
const MAX_CLAIM_PATH_PARTS = 10;
const OIDC_HTTP_TIMEOUT_SECONDS = 10;

const importOpenIdClient = new Function(
    "specifier",
    "return import(specifier)",
) as (specifier: string) => Promise<OpenIdClientModule>;

let oidcClientModule: OpenIdClientModule | null = null;
let oidcConfigurationPromise: Promise<OidcConfiguration> | null = null;

async function loadOpenIdClient(): Promise<OpenIdClientModule> {
    if (!oidcClientModule) {
        oidcClientModule = await importOpenIdClient("openid-client");
    }
    return oidcClientModule;
}

/** Injects the ESM-only openid-client boundary during tests. */
export function __setOpenIdClientForTests(client: OpenIdClientModule): void {
    if (config.nodeEnv !== "test") {
        throw new Error("OIDC client injection is only available in tests");
    }
    oidcClientModule = client;
    oidcConfigurationPromise = null;
}

/** Clears the injected client and cached discovery result during tests. */
export function __resetOpenIdClientForTests(): void {
    if (config.nodeEnv !== "test") {
        throw new Error("OIDC client reset is only available in tests");
    }
    oidcClientModule = null;
    oidcConfigurationPromise = null;
}

async function discoverConfiguration(): Promise<OidcConfiguration> {
    if (!config.oidc.enabled) throw new Error("OIDC is disabled");
    const client = await loadOpenIdClient();
    return client.discovery(
        new URL(config.oidc.issuerUrl),
        config.oidc.clientId,
        config.oidc.clientSecret,
        undefined,
        { timeout: OIDC_HTTP_TIMEOUT_SECONDS },
    );
}

async function getOidcConfiguration(): Promise<OidcConfiguration> {
    if (!oidcConfigurationPromise) {
        oidcConfigurationPromise = discoverConfiguration().catch((error) => {
            oidcConfigurationPromise = null;
            throw error;
        });
    }
    return oidcConfigurationPromise;
}

function readClaim(
    claims: Record<string, unknown>,
    claimName: string,
): unknown {
    const parts = claimName.split(".");
    if (parts.length > MAX_CLAIM_PATH_PARTS) return undefined;
    let current: unknown = claims;
    for (let index = 0; index < MAX_CLAIM_PATH_PARTS; index += 1) {
        const part = parts[index];
        if (part === undefined) return current;
        if (typeof current !== "object" || current === null) return undefined;
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}

function readOptionalString(
    claims: Record<string, unknown>,
    claimName: string,
): string | null {
    const value = readClaim(claims, claimName);
    return value === undefined ? null : optionalClaimStringSchema.parse(value);
}

function parseConsumedClaims(rawClaims: unknown): OidcClaims {
    const claims = oidcBaseClaimsSchema.parse(rawClaims);
    const rawGroups = config.oidc.manageRoles
        ? readClaim(claims, config.oidc.groupsClaim)
        : undefined;
    const groups =
        rawGroups === undefined ? [] : groupsClaimSchema.parse(rawGroups);
    return {
        sub: claims.sub,
        email: readOptionalString(claims, config.oidc.emailClaim),
        emailVerified: claims.email_verified === true,
        name: readOptionalString(claims, config.oidc.nameClaim),
        preferredUsername: claims.preferred_username ?? null,
        groups,
    };
}

/** Returns the stable provider id used by persisted external identities. */
export function getOidcProviderId(): string {
    return `oidc:${config.oidc.issuerUrl}`;
}

/** Builds an Authorization Code request with state, nonce, and S256 PKCE. */
export async function buildAuthorizationRequest(): Promise<OidcAuthorizationRequest> {
    const client = await loadOpenIdClient();
    const discoveredConfig = await getOidcConfiguration();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const redirect = client.buildAuthorizationUrl(discoveredConfig, {
        redirect_uri: config.oidc.redirectUri,
        scope: config.oidc.scopes,
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
    });
    return { redirectUrl: redirect.toString(), state, nonce, codeVerifier };
}

/** Exchanges a callback and returns only Zod-validated consumed claims. */
export async function handleCallback(
    currentUrl: string,
    expected: OidcCallbackExpected,
): Promise<OidcClaims> {
    const client = await loadOpenIdClient();
    const discoveredConfig = await getOidcConfiguration();
    const tokens = await client.authorizationCodeGrant(
        discoveredConfig,
        new URL(currentUrl),
        {
            expectedState: expected.state,
            expectedNonce: expected.nonce,
            pkceCodeVerifier: expected.codeVerifier,
            idTokenExpected: true,
        },
        { redirect_uri: config.oidc.redirectUri },
    );
    return parseConsumedClaims(tokens.claims());
}
