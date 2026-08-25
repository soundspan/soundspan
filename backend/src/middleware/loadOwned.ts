import type { NextFunction, Request, RequestHandler, Response } from "express";
import { prisma } from "../utils/db";
import { sendRouteError } from "../utils/routeErrorResponse";

const OWNED_MODEL_LABELS = {
    downloadJob: "Download job",
    importJob: "Import job",
    musicRequest: "Music request",
    playlist: "Playlist",
    shareLink: "Share link",
    spotifyImportJob: "Import job",
} as const;

export type OwnedModel = keyof typeof OWNED_MODEL_LABELS;

export interface OwnedResource {
    id: string;
    userId: string;
    [key: string]: unknown;
}

interface OwnedDelegate {
    findUnique(args: {
        where: Record<string, string>;
    }): Promise<OwnedResource | null>;
}

function ownedDelegate(model: OwnedModel): OwnedDelegate {
    const delegates = prisma as unknown as Record<OwnedModel, OwnedDelegate>;
    return delegates[model];
}

/** Loads a user-owned Prisma model by route parameter and enforces 404/403 semantics. */
export function loadOwned(model: OwnedModel, param = "id"): RequestHandler {
    return async (
        req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        if (!req.user) {
            sendRouteError(res, 401, "Not authenticated");
            return;
        }
        const resourceId = req.params[param];
        if (typeof resourceId !== "string" || resourceId.length === 0) {
            sendRouteError(res, 400, "Invalid request");
            return;
        }
        const resource = await ownedDelegate(model).findUnique({
            where: { id: resourceId },
        });
        if (!resource) {
            sendRouteError(res, 404, `${OWNED_MODEL_LABELS[model]} not found`);
            return;
        }
        if (resource.userId !== req.user.id) {
            sendRouteError(res, 403, "Access denied");
            return;
        }
        req.owned = resource;
        next();
    };
}
