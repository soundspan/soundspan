import type { Request, Response } from "express";
import { lastFmService } from "../../services/lastfm";
import { logger } from "../../utils/logger";
import { parseBoundedInt } from "../../utils/queryParams";

function getErrorMessage(error: unknown): unknown {
    if (
        (typeof error !== "object" && typeof error !== "function") ||
        error === null
    ) {
        return undefined;
    }
    return (error as { message?: unknown }).message;
}

/** Returns popular Last.fm artists for discovery configuration. */
export async function handlePopularArtists(
    req: Request,
    res: Response,
): Promise<Response> {
    try {
        const limit = parseBoundedInt(req.query.limit, 20, 1, 100);
        const artists = await lastFmService.getTopChartArtists(limit);
        return res.json({ artists });
    } catch (error) {
        logger.error(
            "[Discover] Get popular artists error:",
            getErrorMessage(error) || error,
        );
        return res.json({ artists: [] });
    }
}
