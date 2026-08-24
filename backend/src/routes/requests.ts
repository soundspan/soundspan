import { Request, Response, Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireAdmin, requireAuth } from "../middleware/auth";
import {
    approveRequest,
    cancelOwnRequest,
    createRequest,
    denyRequest,
    type DownloadDispatch,
    getRequestAvailability,
    listAllRequests,
    listRequestsForUser,
    MUSIC_REQUEST_STATUSES,
    MusicRequestServiceError,
} from "../services/musicRequestService";
import { enqueueAlbumDownloadInBackground } from "../services/albumDownloadQueueService";
import { logger } from "../utils/logger";
import { sendInternalRouteError, sendRouteError } from "./routeErrorResponse";

const router = Router();
const log = logger.child("Requests");
const MBID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mbidSchema = z
    .string()
    .trim()
    .regex(MBID_PATTERN)
    .transform((value) => value.toLowerCase());
const requestBodySchema = z.strictObject({
    artistName: z.string().trim().min(1).max(300),
    albumTitle: z.string().trim().min(1).max(300),
    rgMbid: mbidSchema,
    artistMbid: mbidSchema.optional(),
    note: z.string().trim().max(500).optional(),
});
const idParamsSchema = z.strictObject({ id: z.string().trim().min(1) });
const adminQuerySchema = z.strictObject({
    status: z.enum(MUSIC_REQUEST_STATUSES).optional(),
});
const denyBodySchema = z.strictObject({
    reason: z.string().trim().max(500).optional(),
});

router.use(requireAuth);

function sendCreateRejection(
    error: MusicRequestServiceError,
    res: Parameters<typeof sendRouteError>[0],
) {
    const status = error.code === "daily_cap" ? 429 : 409;
    return sendRouteError(res, status, error.message);
}

async function handleAvailability(req: Request, res: Response) {
    try {
        res.json(await getRequestAvailability(req.user!.id));
    } catch (error) {
        log.error("Request availability failed", { error });
        sendInternalRouteError(res, "Failed to check request availability");
    }
}

async function handleCreate(req: Request, res: Response) {
    const parsed = requestBodySchema.safeParse(req.body);
    if (!parsed.success)
        return sendRouteError(res, 400, "Invalid request body");
    try {
        const request = await createRequest(req.user!.id, parsed.data);
        return res.status(201).json(request);
    } catch (error) {
        if (error instanceof MusicRequestServiceError) {
            return sendCreateRejection(error, res);
        }
        log.error("Create music request failed", { error });
        return sendInternalRouteError(res, "Failed to create music request");
    }
}

async function handleMine(req: Request, res: Response) {
    try {
        res.json(await listRequestsForUser(req.user!.id));
    } catch (error) {
        log.error("List own music requests failed", { error });
        sendInternalRouteError(res, "Failed to list music requests");
    }
}

async function handleCancel(req: Request, res: Response) {
    const parsed = idParamsSchema.safeParse(req.params);
    if (!parsed.success) return sendRouteError(res, 400, "Invalid request id");
    try {
        const result = await cancelOwnRequest(req.user!.id, parsed.data.id);
        if (result.kind === "not_found") {
            return sendRouteError(res, 404, "Music request not found");
        }
        if (result.kind === "conflict") {
            return sendRouteError(
                res,
                409,
                "Only pending requests can be cancelled",
            );
        }
        return res.json({ success: true });
    } catch (error) {
        log.error("Cancel music request failed", { error });
        return sendInternalRouteError(res, "Failed to cancel music request");
    }
}

async function handleListAll(req: Request, res: Response) {
    const parsed = adminQuerySchema.safeParse(req.query);
    if (!parsed.success)
        return sendRouteError(res, 400, "Invalid request status");
    try {
        return res.json(await listAllRequests(parsed.data.status));
    } catch (error) {
        log.error("List all music requests failed", { error });
        return sendInternalRouteError(res, "Failed to list music requests");
    }
}

function dispatchApprovedDownload(dispatch: DownloadDispatch): void {
    enqueueAlbumDownloadInBackground({
        jobId: dispatch.jobId,
        type: dispatch.type,
        mbid: dispatch.mbid,
        subject: dispatch.subject,
        artistName: dispatch.artistName,
        albumTitle: dispatch.albumTitle,
    });
}

async function handleApprove(req: Request, res: Response) {
    const parsed = idParamsSchema.safeParse(req.params);
    if (!parsed.success) return sendRouteError(res, 400, "Invalid request id");
    try {
        const result = await approveRequest(req.user!.id, parsed.data.id);
        if (result.kind === "not_found") {
            return sendRouteError(res, 404, "Music request not found");
        }
        if (result.kind === "conflict") {
            return sendRouteError(
                res,
                409,
                "Only pending requests can be approved",
            );
        }
        if (result.dispatch) dispatchApprovedDownload(result.dispatch);
        return res.json(result.request);
    } catch (error) {
        log.error("Approve music request failed", { error });
        return sendInternalRouteError(res, "Failed to approve music request");
    }
}

async function handleDeny(req: Request, res: Response) {
    const params = idParamsSchema.safeParse(req.params);
    const body = denyBodySchema.safeParse(req.body);
    if (!params.success || !body.success) {
        return sendRouteError(res, 400, "Invalid denial request");
    }
    try {
        const result = await denyRequest(
            req.user!.id,
            params.data.id,
            body.data.reason,
        );
        if (result.kind === "not_found") {
            return sendRouteError(res, 404, "Music request not found");
        }
        if (result.kind === "conflict") {
            return sendRouteError(
                res,
                409,
                "Only pending requests can be denied",
            );
        }
        return res.json(result.request);
    } catch (error) {
        log.error("Deny music request failed", { error });
        return sendInternalRouteError(res, "Failed to deny music request");
    }
}

/**
 * @openapi
 * /api/requests/availability:
 *   get:
 *     summary: Check request-queue availability and the caller's rolling quota
 *     tags: [Music Requests]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Feature availability, daily cap, and remaining requests
 *       401:
 *         description: Not authenticated
 */
router.get("/availability", asyncHandler(handleAvailability));

/**
 * @openapi
 * /api/requests:
 *   post:
 *     summary: Submit an album request
 *     tags: [Music Requests]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [artistName, albumTitle, rgMbid]
 *             additionalProperties: false
 *             properties:
 *               artistName: { type: string, maxLength: 300 }
 *               albumTitle: { type: string, maxLength: 300 }
 *               rgMbid: { type: string, format: uuid }
 *               artistMbid: { type: string, format: uuid }
 *               note: { type: string, maxLength: 500 }
 *     responses:
 *       201: { description: Request created }
 *       400: { description: Invalid request body }
 *       401: { description: Not authenticated }
 *       409: { description: Album is owned, requested, or downloading }
 *       429: { description: Daily request cap reached }
 */
router.post("/", asyncHandler(handleCreate));

/**
 * @openapi
 * /api/requests/mine:
 *   get:
 *     summary: List the caller's music requests
 *     tags: [Music Requests]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200: { description: Newest-first request history with nullable albumId and artistId local link fields }
 *       401: { description: Not authenticated }
 */
router.get("/mine", asyncHandler(handleMine));

/**
 * @openapi
 * /api/requests/{id}:
 *   delete:
 *     summary: Cancel the caller's pending request
 *     tags: [Music Requests]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Request cancelled }
 *       401: { description: Not authenticated }
 *       404: { description: Request not found }
 *       409: { description: Request is no longer pending }
 */
router.delete("/:id", asyncHandler(handleCancel));

/**
 * @openapi
 * /api/requests:
 *   get:
 *     summary: List music requests for administrator review
 *     tags: [Music Requests]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, approved, denied, fulfilled, failed, cancelled]
 *     responses:
 *       200: { description: Bounded newest-first request list with nullable albumId and artistId local link fields }
 *       400: { description: Invalid status filter }
 *       401: { description: Not authenticated }
 *       403: { description: Admin access required }
 */
router.get("/", requireAdmin, asyncHandler(handleListAll));

/**
 * @openapi
 * /api/requests/{id}/approve:
 *   post:
 *     summary: Approve a pending request and queue its album download
 *     tags: [Music Requests]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Approved request }
 *       401: { description: Not authenticated }
 *       403: { description: Admin access required }
 *       404: { description: Request not found }
 *       409: { description: Request is no longer pending }
 */
router.post("/:id/approve", requireAdmin, asyncHandler(handleApprove));

/**
 * @openapi
 * /api/requests/{id}/deny:
 *   post:
 *     summary: Deny a pending request
 *     tags: [Music Requests]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             properties:
 *               reason: { type: string, maxLength: 500 }
 *     responses:
 *       200: { description: Denied request }
 *       400: { description: Invalid denial body }
 *       401: { description: Not authenticated }
 *       403: { description: Admin access required }
 *       404: { description: Request not found }
 *       409: { description: Request is no longer pending }
 */
router.post("/:id/deny", requireAdmin, asyncHandler(handleDeny));

export default router;
