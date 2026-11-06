import type { CookieOptions } from "express";
import {
    secureCookiePrefixedName,
    shouldUseSecureCookie,
    type SecureCookieRequest,
} from "../utils/secureCookies";

const QUEUE_DASHBOARD_COOKIE_BASE_NAME = "soundspan-queues";

function secureCookieForRequest(req: SecureCookieRequest): boolean {
    // Resolve lazily so general authentication does not load the full config
    // graph unless the queue-dashboard cookie transport is actually used.
    const { config } = require("../config") as typeof import("../config");
    return shouldUseSecureCookie(config.secureCookies, req);
}

/** Return the queue-dashboard cookie name for this request's scheme. */
export function queueDashboardCookieName(req: SecureCookieRequest): string {
    return secureCookiePrefixedName(
        QUEUE_DASHBOARD_COOKIE_BASE_NAME,
        "__Secure-",
        secureCookieForRequest(req),
    );
}

/** Return the complete narrow queue-dashboard cookie contract. */
export function queueDashboardCookieOptions(
    req: SecureCookieRequest,
    ttlSeconds: number,
): CookieOptions {
    return {
        httpOnly: true,
        sameSite: "strict",
        secure: secureCookieForRequest(req),
        path: "/api/admin/queues",
        maxAge: ttlSeconds * 1000,
    };
}
