import type { Request, Response } from "express";
import { discoveryRecommendationsService } from "../../services/discovery";
import { sendCurrentPlaylistFailure } from "./shared";

/** Handles the recommendation-mode current discovery playlist. */
export async function handleModernCurrent(
    req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        const playlist =
            await discoveryRecommendationsService.getCurrentPlaylist(
                req.user!.id,
            );
        return res.json(playlist);
    } catch (error) {
        sendCurrentPlaylistFailure(res, error);
    }
}
