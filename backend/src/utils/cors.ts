/**
 * Decide whether a CORS request origin is permitted.
 *
 * Because CORS credentials are enabled, production denies cross-origin
 * requests by default when `ALLOWED_ORIGINS` is unset. Operators can configure
 * an explicit allowlist with `ALLOWED_ORIGINS`, or set `CORS_ALLOW_ALL=true` to
 * restore the legacy permissive behavior. Requests without an Origin header
 * and development requests remain allowed.
 *
 * @param origin           The request `Origin` header (undefined for same-origin/curl).
 * @param allowedOrigins   `true` to allow all, or an explicit list of origins.
 * @param nodeEnv          Current `NODE_ENV` (development always allows all).
 */
export function isOriginAllowed(
    origin: string | undefined,
    allowedOrigins: boolean | string[],
    nodeEnv: string
): boolean {
    // Requests with no Origin (same-origin navigations, curl, server-to-server).
    if (!origin) {
        return true;
    }

    // Explicitly allow all, or in development.
    if (allowedOrigins === true || nodeEnv === "development") {
        return true;
    }

    // A configured allowlist is enforced.
    if (Array.isArray(allowedOrigins) && allowedOrigins.length > 0) {
        return allowedOrigins.includes(origin);
    }

    // No allowlist configured → deny cross-origin requests by default.
    return false;
}
