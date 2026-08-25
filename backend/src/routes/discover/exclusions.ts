import type { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    sendInternalRouteError,
    sendRouteError,
} from "../../utils/routeErrorResponse";

type DiscoverExclusionRow = Prisma.DiscoverExclusionGetPayload<object>;

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

function mapExclusion(exclusion: DiscoverExclusionRow) {
    return {
        id: exclusion.id,
        albumMbid: exclusion.albumMbid,
        artistName: exclusion.artistName || "Unknown Artist",
        albumTitle:
            exclusion.albumTitle || exclusion.albumMbid.slice(0, 8) + "...",
        lastSuggestedAt: exclusion.lastSuggestedAt,
        expiresAt: exclusion.expiresAt,
    };
}

/** Returns active discovery exclusions for the current user. */
export async function handleGetExclusions(
    req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        const exclusions = await prisma.discoverExclusion.findMany({
            where: {
                userId: req.user!.id,
                expiresAt: { gt: new Date() },
            },
            orderBy: { lastSuggestedAt: "desc" },
        });
        return res.json({
            exclusions: exclusions.map(mapExclusion),
            count: exclusions.length,
        });
    } catch (error) {
        const detail = getLooseErrorDetail(error);
        logger.error("Get exclusions error:", detail.message || error);
        logger.error("Stack:", detail.stack);
        res.status(500).json({ error: "Failed to get exclusions" });
    }
}

/** Clears all discovery exclusions for the current user. */
export async function handleClearExclusions(
    req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        const userId = req.user!.id;
        const result = await prisma.discoverExclusion.deleteMany({
            where: { userId },
        });
        logger.debug(
            `[Discovery] Cleared ${result.count} exclusions for user ${userId}`,
        );
        return res.json({
            success: true,
            message: `Cleared ${result.count} exclusions`,
            clearedCount: result.count,
        });
    } catch (error) {
        logger.error("Clear exclusions error:", error);
        sendInternalRouteError(res, "Failed to clear exclusions");
    }
}

/** Removes one discovery exclusion owned by the current user. */
export async function handleRemoveExclusion(
    req: Request<{ id: string }>,
    res: Response,
): Promise<Response | void> {
    try {
        const { id } = req.params;
        const exclusion = await prisma.discoverExclusion.findFirst({
            where: { id, userId: req.user!.id },
        });
        if (!exclusion) {
            return sendRouteError(res, 404, "Exclusion not found");
        }
        await prisma.discoverExclusion.delete({ where: { id } });
        return res.json({ success: true, message: "Exclusion removed" });
    } catch (error) {
        logger.error("Remove exclusion error:", error);
        sendInternalRouteError(res, "Failed to remove exclusion");
    }
}
