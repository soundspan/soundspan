import type { Request } from "express";

const MAX_COOKIE_HEADER_LENGTH = 4096;
const MAX_COOKIE_COUNT = 64;

/** Read one cookie by exact name from a bounded Cookie header; null when absent or oversized. */
export function readCookie(req: Request, name: string): string | null {
    const header = req.headers.cookie;
    if (!header || header.length > MAX_COOKIE_HEADER_LENGTH) return null;

    const cookies = header.split(";");
    if (cookies.length > MAX_COOKIE_COUNT) return null;

    for (const rawCookie of cookies) {
        const cookie = rawCookie.trim();
        const separatorIndex = cookie.indexOf("=");
        if (separatorIndex < 0) continue;
        if (cookie.slice(0, separatorIndex) !== name) continue;
        return cookie.slice(separatorIndex + 1);
    }
    return null;
}
