import type { Request, Response } from "express";
import { logger } from "../../utils/logger";
import { sendInternalRouteError } from "../../utils/routeErrorResponse";

/** Rejects legacy-only like requests in recommendation mode. */
export async function handleModernLike(
    _req: Request,
    res: Response,
): Promise<Response> {
    try {
        return res.status(410).json({
            error: "Like/unlike is disabled for recommendation-only discovery",
        });
    } catch (error) {
        logger.error("Like discovery album error:", error);
        return sendInternalRouteError(res, "Failed to like album");
    }
}

/** Rejects legacy-only unlike requests in recommendation mode. */
export async function handleModernUnlike(
    _req: Request,
    res: Response,
): Promise<Response> {
    try {
        return res.status(410).json({
            error: "Like/unlike is disabled for recommendation-only discovery",
        });
    } catch (error) {
        logger.error("Unlike discovery album error:", error);
        return sendInternalRouteError(res, "Failed to unlike album");
    }
}
