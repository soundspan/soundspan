import type { Request, Response } from "express";
import { discoveryRecommendationsService } from "../../services/discovery";
import { sendClearPlaylistFailure } from "./shared";

/** Clears the recommendation-mode discovery playlist. */
export async function handleModernClear(
    req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        const { clearedCount } =
            await discoveryRecommendationsService.clearCurrentPlaylist(
                req.user!.id,
            );
        return res.json({
            success: true,
            message: "Discovery recommendations cleared",
            likedMoved: 0,
            activeDeleted: clearedCount,
            clearedCount,
        });
    } catch (error) {
        sendClearPlaylistFailure(res, error);
    }
}
