import type { Response } from "express";
import { logger } from "../utils/logger";
import { sendInternalRouteError, sendRouteError } from "./routeErrorResponse";

const browseLogger = logger.child("Browse");

function getProperty(value: unknown, property: string): unknown {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    return (value as Record<string, unknown>)[property];
}

/** Resolve a valid HTTP status from a YT Music service error. */
export function resolveYtMusicHttpStatus(error: unknown): number | null {
    const response = getProperty(error, "response");
    const status = getProperty(response, "status");
    if (typeof status === "number" && status >= 400 && status <= 599) {
        return status;
    }

    return null;
}

/** Send the public error response for the YT Music library-playlists route. */
export function sendYtMusicMixesErrorResponse(
    res: Response,
    error: unknown,
): Response {
    const status = resolveYtMusicHttpStatus(error);
    if (status === 401) {
        return res.json({ mixes: [], source: "ytmusic" as const });
    }
    if (status === 503) {
        return sendRouteError(
            res,
            503,
            "YouTube Music library playlists are temporarily unavailable",
        );
    }
    if (status === 504) {
        return sendRouteError(
            res,
            504,
            "YouTube Music library playlists request timed out",
        );
    }
    if (status && status < 500) {
        const response = getProperty(error, "response");
        const data = getProperty(response, "data");
        browseLogger.warn("YT Music mixes request rejected:", {
            status,
            detail: getProperty(data, "detail"),
        });
        return res.status(status).json({ error: "Invalid request for mixes" });
    }

    browseLogger.error(
        "YT Music mixes error:",
        getProperty(error, "message") || "unknown",
    );
    return sendInternalRouteError(res, "Failed to fetch YT Music mixes");
}
