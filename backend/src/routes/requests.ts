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
    getRequestCounts,
    listAllRequests,
    listRequestsForUser,
    MUSIC_REQUEST_STATUSES,
    type RequestConflictReason,
    MusicRequestServiceError,
} from "../services/musicRequestService";
import {
    approvePendingRequestsForUser,
    denyStaleRequests,
    MAX_BULK_APPROVALS,
} from "../services/musicRequestBulkActions";
import { enqueueAlbumDownloadInBackground } from "../services/albumDownloadQueueService";
import { logger } from "../utils/logger";
import {
    sendInternalRouteError,
    sendRouteError,
} from "../utils/routeErrorResponse";

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
const listQuerySchema = z.strictObject({
    status: z.enum(MUSIC_REQUEST_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(10000).default(0),
});
const denyBodySchema = z.strictObject({
    reason: z.string().trim().max(500).optional(),
});
const bulkApproveBodySchema = z.strictObject({
    userId: z.string().trim().min(1).max(64),
});
const bulkDenyStaleBodySchema = z.strictObject({
    olderThanDays: z.number().int().min(1).max(365),
    reason: z.string().trim().max(500).optional(),
});

router.use(requireAuth);

function sendCreateRejection(
    error: MusicRequestServiceError,
    res: Parameters<typeof sendRouteError>[0],
) {
    const status = error.code === "daily_cap" ? 429 : 409;
    return sendRouteError(res, status, error.message, {
        code: error.code,
        ...(error.retryAfter
            ? { retryAfter: error.retryAfter.toISOString() }
            : {}),
    });
}

function sendReviewConflict(
    res: Response,
    reason: RequestConflictReason,
    action: "approved" | "denied",
) {
    const message =
        reason === "open_request_exists"
            ? "This user already has an open request for this album"
            : `Only pending or failed requests can be ${action}`;
    return sendRouteError(res, 409, message, { code: reason });
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
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success)
        return sendRouteError(res, 400, "Invalid request query");
    try {
        return res.json(await listRequestsForUser(req.user!.id, parsed.data));
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
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success)
        return sendRouteError(res, 400, "Invalid request query");
    try {
        return res.json(await listAllRequests(parsed.data));
    } catch (error) {
        log.error("List all music requests failed", { error });
        return sendInternalRouteError(res, "Failed to list music requests");
    }
}

async function handleCounts(_req: Request, res: Response) {
    try {
        return res.json(await getRequestCounts());
    } catch (error) {
        log.error("Count music requests failed", { error });
        return sendInternalRouteError(res, "Failed to count music requests");
    }
}

function dispatchApprovedDownload(dispatch: DownloadDispatch): void {
    enqueueAlbumDownloadInBackground({
        jobId: dispatch.jobId,
        type: dispatch.type,
        mbid: dispatch.mbid,
        subject: dispatch.subject,
        artistName: dispatch.artistName,
        artistMbid: dispatch.artistMbid,
        albumTitle: dispatch.albumTitle,
    });
}

async function handleBulkApprove(req: Request, res: Response) {
    const parsed = bulkApproveBodySchema.safeParse(req.body);
    if (!parsed.success)
        return sendRouteError(res, 400, "Invalid bulk approval request");
    try {
        const result = await approvePendingRequestsForUser(
            req.user!.id,
            parsed.data.userId,
        );
        for (
            let index = 0;
            index < result.dispatches.length && index < MAX_BULK_APPROVALS;
            index += 1
        ) {
            dispatchApprovedDownload(result.dispatches[index]);
        }
        const { dispatches: _dispatches, ...response } = result;
        return res.json(response);
    } catch (error) {
        log.error("Bulk request approval failed", { error });
        return sendInternalRouteError(res, "Failed to bulk approve requests");
    }
}

async function handleBulkDenyStale(req: Request, res: Response) {
    const parsed = bulkDenyStaleBodySchema.safeParse(req.body);
    if (!parsed.success)
        return sendRouteError(res, 400, "Invalid stale denial request");
    try {
        const result = await denyStaleRequests(
            req.user!.id,
            parsed.data.olderThanDays,
            parsed.data.reason,
        );
        return res.json(result);
    } catch (error) {
        log.error("Bulk stale request denial failed", { error });
        return sendInternalRouteError(res, "Failed to deny stale requests");
    }
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
            return sendReviewConflict(res, result.reason, "approved");
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
            return sendReviewConflict(res, result.reason, "denied");
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
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [enabled, remainingToday, dailyCap, deniedCooldownDays]
 *               properties:
 *                 enabled: { type: boolean }
 *                 remainingToday: { type: integer }
 *                 dailyCap: { type: integer }
 *                 deniedCooldownDays: { type: integer }
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
 *       409: { description: Album is owned, requested, downloading, or in a denial cooldown }
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
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [pending, approved, denied, fulfilled, failed, cancelled] } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 50 } }
 *       - { in: query, name: offset, schema: { type: integer, minimum: 0, maximum: 10000, default: 0 } }
 *     responses:
 *       200:
 *         description: Paged request history with total, offset, limit, local links, and downloadStatus
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [requests, total, offset, limit]
 *               properties:
 *                 requests:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       albumId: { type: string, nullable: true }
 *                       artistId: { type: string, nullable: true }
 *                       downloadStatus: { type: string, nullable: true }
 *                 total: { type: integer }
 *                 offset: { type: integer }
 *                 limit: { type: integer }
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
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 50 } }
 *       - { in: query, name: offset, schema: { type: integer, minimum: 0, maximum: 10000, default: 0 } }
 *     responses:
 *       200:
 *         description: Paged request list with total, offset, limit, local links, and downloadStatus
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [requests, total, offset, limit]
 *               properties:
 *                 requests:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       albumId: { type: string, nullable: true }
 *                       artistId: { type: string, nullable: true }
 *                       downloadStatus: { type: string, nullable: true }
 *                       user:
 *                         type: object
 *                         properties:
 *                           id: { type: string }
 *                           username: { type: string }
 *                 total: { type: integer }
 *                 offset: { type: integer }
 *                 limit: { type: integer }
 *       400: { description: Invalid status or paging filter }
 *       401: { description: Not authenticated }
 *       403: { description: Admin access required }
 */
router.get("/", requireAdmin, asyncHandler(handleListAll));

/**
 * @openapi
 * /api/requests/counts:
 *   get:
 *     summary: Count requests by lifecycle status
 *     tags: [Music Requests]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Zero-filled counts for every request status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [pending, approved, denied, fulfilled, failed, cancelled]
 *               properties:
 *                 pending: { type: integer }
 *                 approved: { type: integer }
 *                 denied: { type: integer }
 *                 fulfilled: { type: integer }
 *                 failed: { type: integer }
 *                 cancelled: { type: integer }
 *       401: { description: Not authenticated }
 *       403: { description: Admin access required }
 */
router.get("/counts", requireAdmin, asyncHandler(handleCounts));

/**
 * @openapi
 * /api/requests/bulk/approve:
 *   post:
 *     summary: Approve up to 25 pending requests for one user
 *     tags: [Music Requests]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [userId]
 *             properties:
 *               userId: { type: string, minLength: 1, maxLength: 64 }
 *     responses:
 *       200:
 *         description: Bulk approval outcome counts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [approved, fulfilled, skipped, failed, remaining]
 *               properties:
 *                 approved: { type: integer }
 *                 fulfilled: { type: integer }
 *                 skipped: { type: integer }
 *                 failed: { type: integer }
 *                 remaining: { type: integer }
 *       400: { description: Invalid bulk approval request }
 *       401: { description: Not authenticated }
 *       403: { description: Admin access required }
 */
router.post("/bulk/approve", requireAdmin, asyncHandler(handleBulkApprove));

/**
 * @openapi
 * /api/requests/bulk/deny-stale:
 *   post:
 *     summary: Deny up to 200 stale pending requests without a cooldown
 *     tags: [Music Requests]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [olderThanDays]
 *             properties:
 *               olderThanDays: { type: integer, minimum: 1, maximum: 365 }
 *               reason: { type: string, maxLength: 500 }
 *     responses:
 *       200:
 *         description: Stale denial and remaining counts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [denied, remaining]
 *               properties:
 *                 denied: { type: integer }
 *                 remaining: { type: integer }
 *       400: { description: Invalid stale denial request }
 *       401: { description: Not authenticated }
 *       403: { description: Admin access required }
 */
router.post(
    "/bulk/deny-stale",
    requireAdmin,
    asyncHandler(handleBulkDenyStale),
);

/**
 * @openapi
 * /api/requests/{id}/approve:
 *   post:
 *     summary: Approve or retry a pending or failed request
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
 *       409: { description: Conflict code is not_reviewable or open_request_exists }
 */
router.post("/:id/approve", requireAdmin, asyncHandler(handleApprove));

/**
 * @openapi
 * /api/requests/{id}/deny:
 *   post:
 *     summary: Deny a pending or failed request
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
 *       409: { description: Conflict code is not_reviewable }
 */
router.post("/:id/deny", requireAdmin, asyncHandler(handleDeny));

export default router;
