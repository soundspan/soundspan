const DEFAULT_SERVER_BACKEND_URL = "http://127.0.0.1:3006";
const DEFAULT_BROWSER_BACKEND_PORT = "3006";

/** Browser API routing mode: automatic, forced same-origin proxy, or forced direct backend. */
export type ApiPathMode = "auto" | "proxy" | "direct";

/** Minimal browser location shape used by API base URL resolution. */
export interface BrowserLocationLike {
    protocol: string;
    hostname: string;
    port: string;
}

/** Inputs required to resolve the frontend API base URL at runtime. */
export interface ResolveApiBaseUrlOptions {
    isServer: boolean;
    backendUrl?: string;
    configuredApiUrl?: string;
    apiPathMode?: string;
    browserLocation?: BrowserLocationLike;
}

const normalizeBaseUrl = (value?: string): string | null => {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    return trimmed.replace(/\/+$/, "");
};

const parseApiPathMode = (value?: string): ApiPathMode => {
    const normalized = value?.trim().toLowerCase();
    if (
        normalized === "auto" ||
        normalized === "proxy" ||
        normalized === "direct"
    ) {
        return normalized;
    }
    return "auto";
};

const getBrowserDefaultBackendUrl = (location: BrowserLocationLike): string => {
    return `${location.protocol}//${location.hostname}:${DEFAULT_BROWSER_BACKEND_PORT}`;
};

/**
 * Resolves the frontend API base URL for both server and browser contexts.
 */
export const resolveApiBaseUrl = (
    options: ResolveApiBaseUrlOptions
): string => {
    if (options.isServer) {
        return (
            normalizeBaseUrl(options.backendUrl) ?? DEFAULT_SERVER_BACKEND_URL
        );
    }

    const mode = parseApiPathMode(options.apiPathMode);
    if (mode === "proxy") {
        return "";
    }

    const configuredApiUrl = normalizeBaseUrl(options.configuredApiUrl);
    if (mode === "direct") {
        if (configuredApiUrl) {
            return configuredApiUrl;
        }
        if (!options.browserLocation) {
            return "";
        }
        return getBrowserDefaultBackendUrl(options.browserLocation);
    }

    if (configuredApiUrl) {
        return configuredApiUrl;
    }
    return "";
};
