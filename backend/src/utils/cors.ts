/**
 * Decide whether a CORS request origin is permitted.
 *
 * soundspan is self-hosted, so the default posture is permissive: when no
 * allowlist is configured (`ALLOWED_ORIGINS` unset → `[]`, or `true`), all
 * origins are allowed. But when an operator DOES configure an allowlist, it is
 * enforced — previously an unlisted origin was logged and then allowed anyway,
 * which silently made the `ALLOWED_ORIGINS` knob a no-op while `credentials`
 * was enabled.
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

    // No allowlist configured → self-hosted default allows all.
    return true;
}
