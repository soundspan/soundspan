import type { CookieOptions } from "express";

const QUEUE_DASHBOARD_COOKIE_BASE_NAME = "soundspan-queues";

function secureCookiesEnabled(): boolean {
    // Resolve lazily so general authentication does not load the full config
    // graph unless the queue-dashboard cookie transport is actually used.
    const { config } = require("../config") as typeof import("../config");
    return config.secureCookies;
}

/** Return the deployment-appropriate queue-dashboard cookie name. */
export function queueDashboardCookieName(): string {
    return secureCookiesEnabled()
        ? `__Secure-${QUEUE_DASHBOARD_COOKIE_BASE_NAME}`
        : QUEUE_DASHBOARD_COOKIE_BASE_NAME;
}

/** Return the complete narrow queue-dashboard cookie contract. */
export function queueDashboardCookieOptions(ttlSeconds: number): CookieOptions {
    const secure = secureCookiesEnabled();
    return {
        httpOnly: true,
        sameSite: "strict",
        secure,
        path: "/api/admin/queues",
        maxAge: ttlSeconds * 1000,
    };
}
