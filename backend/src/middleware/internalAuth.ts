import { Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "crypto";
import { logger } from "../utils/logger";

// Repo-published insecure default that must be rejected.
const KNOWN_DEFAULT_SECRET = "soundspan-internal-secret-change-me";

/**
 * Constant-time string comparison that tolerates differing lengths without
 * leaking them. Both inputs are SHA-256 hashed to fixed-width buffers before
 * the timing-safe compare, so callers can pass arbitrary-length secrets.
 */
function secretsMatch(provided: string, expected: string): boolean {
    const providedHash = createHash("sha256").update(provided).digest();
    const expectedHash = createHash("sha256").update(expected).digest();
    return timingSafeEqual(providedHash, expectedHash);
}

/**
 * Guard for machine-to-machine endpoints authenticated by a shared secret
 * (the `x-internal-secret` header), e.g. the CLAP analyzer callbacks.
 *
 * Fails CLOSED: if `INTERNAL_API_SECRET` is not configured or is left at the
 * repo-published default value, the request is rejected rather than allowed
 * through. A plain `!==` comparison against an unset env var lets a request
 * with no header satisfy `undefined !== undefined` (false), silently bypassing
 * auth — this middleware closes that hole and compares in constant time.
 */
export function requireInternalSecret(
    req: Request,
    res: Response,
    next: NextFunction,
): void {
    const expected = process.env.INTERNAL_API_SECRET;
    if (!expected || expected === KNOWN_DEFAULT_SECRET) {
        logger.error(
            expected === KNOWN_DEFAULT_SECRET
                ? "INTERNAL_API_SECRET is set to the insecure default; rejecting internal request"
                : "INTERNAL_API_SECRET is not configured; rejecting internal request",
        );
        res.status(403).json({ error: "Forbidden" });
        return;
    }

    const provided = req.headers["x-internal-secret"];
    if (typeof provided !== "string" || !secretsMatch(provided, expected)) {
        res.status(403).json({ error: "Forbidden" });
        return;
    }

    next();
}
