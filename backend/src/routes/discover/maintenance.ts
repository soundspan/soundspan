import type { Request, Response } from "express";
import { sendCleanupLidarrFailure, sendFixTaggingFailure } from "./shared";

/** Rejects legacy-only Lidarr cleanup in recommendation mode. */
export async function handleModernCleanupLidarr(
    _req: Request,
    res: Response,
): Promise<Response> {
    try {
        return res.status(410).json({
            error: "Lidarr cleanup is only available in legacy discovery mode",
        });
    } catch (error) {
        sendCleanupLidarrFailure(res, error);
        return res;
    }
}

/** Rejects legacy-only tagging repair in recommendation mode. */
export async function handleModernFixTagging(
    _req: Request,
    res: Response,
): Promise<Response> {
    try {
        return res.status(410).json({
            error: "Tagging repair is only available in legacy discovery mode",
        });
    } catch (error) {
        sendFixTaggingFailure(res, error);
        return res;
    }
}
