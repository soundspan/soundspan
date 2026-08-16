import {
    resolveApiBaseUrl,
    type BrowserLocationLike,
} from "@/lib/api-base-url";

const RETURN_TO_VALIDATION_ORIGIN = "https://soundspan.invalid";

/** Inputs used to resolve the browser API base for an OIDC navigation. */
export interface OidcLoginUrlOptions {
    configuredApiUrl?: string;
    apiPathMode?: string;
    browserLocation: BrowserLocationLike;
}

/** Restricts a login destination to the backend-compatible relative-path form. */
export function normalizeLoginReturnTo(value: string | null): string {
    if (!value?.startsWith("/") || value.startsWith("//")) return "/";
    if (value.includes("\\")) return "/";
    try {
        const parsed = new URL(value, RETURN_TO_VALIDATION_ORIGIN);
        return parsed.origin === RETURN_TO_VALIDATION_ORIGIN ? value : "/";
    } catch {
        return "/";
    }
}

/** Builds the full-page OIDC start URL using normal frontend API resolution. */
export function buildOidcLoginUrl(
    returnTo: string | null,
    options: OidcLoginUrlOptions,
): string {
    const apiBaseUrl = resolveApiBaseUrl({
        isServer: false,
        configuredApiUrl: options.configuredApiUrl,
        apiPathMode: options.apiPathMode,
        browserLocation: options.browserLocation,
    });
    const params = new URLSearchParams({
        returnTo: normalizeLoginReturnTo(returnTo),
    });
    return `${apiBaseUrl}/api/auth/oidc/login?${params.toString()}`;
}

/** Maps an OIDC callback error code to safe user-facing text. */
export function getSsoErrorMessage(code: string): string {
    if (code === "invalid_state") {
        return "Your SSO sign-in session expired or was invalid. Please try again.";
    }
    if (code === "account_already_linked") {
        return "This soundspan account is already linked to a different SSO identity.";
    }
    return "SSO sign-in failed. Please try again.";
}
