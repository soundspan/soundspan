import type { Response } from "express";
import { logger } from "../../utils/logger";

interface LooseErrorDetail {
    message?: unknown;
    stack?: unknown;
}

function getLooseErrorDetail(error: unknown): LooseErrorDetail {
    if (
        (typeof error !== "object" && typeof error !== "function") ||
        error === null
    ) {
        return {};
    }
    return error as LooseErrorDetail;
}

/** Preserves the current-playlist route's established error response. */
export function sendCurrentPlaylistFailure(
    res: Response,
    error: unknown,
): void {
    logger.error("Get current Discover Weekly error:", error);
    res.status(500).json({
        error: "Failed to get Discover Weekly playlist",
    });
}

/** Preserves the clear-playlist route's established error response. */
export function sendClearPlaylistFailure(res: Response, error: unknown): void {
    const detail = getLooseErrorDetail(error);
    logger.error("Clear discovery playlist error:", detail.message || error);
    logger.error("Stack:", detail.stack);
    res.status(500).json({
        error: "Failed to clear discovery playlist",
    });
}

/** Preserves the Lidarr-cleanup route's established error response. */
export function sendCleanupLidarrFailure(res: Response, error: unknown): void {
    const detail = getLooseErrorDetail(error);
    logger.error("[CLEANUP] Lidarr cleanup error:", detail.message || error);
    res.status(500).json({
        error: "Failed to cleanup Lidarr",
    });
}

/** Preserves the tagging-repair route's established error response. */
export function sendFixTaggingFailure(res: Response, error: unknown): void {
    const detail = getLooseErrorDetail(error);
    logger.error("[FIX-TAGGING] Error:", detail.message || error);
    res.status(500).json({
        error: "Failed to fix album tagging",
    });
}
