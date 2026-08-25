import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/asyncHandler";
import {
    appendRadioPlaylist,
    createRadioPlaylist,
    RADIO_PLAYLIST_DEFAULT_SIZE,
    RADIO_PLAYLIST_MAX_SIZE,
    RadioPlaylistServiceError,
    regenerateRadioPlaylist,
} from "../../services/radioPlaylistService";
import { sendRouteError } from "../../utils/routeErrorResponse";

const valueSchema = z.string().trim().min(1).max(200);
const filterSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("genre"), value: valueSchema }).strict(),
    z
        .object({
            type: z.literal("decade"),
            value: z.string().regex(/^(?:1\d{2}|20\d)0$/),
        })
        .strict(),
    z.object({ type: z.literal("discovery") }).strict(),
    z.object({ type: z.literal("favorites") }).strict(),
    z.object({ type: z.literal("workout") }).strict(),
]);
const batchSizeSchema = z.number().int().min(1).max(RADIO_PLAYLIST_MAX_SIZE);
const createSchema = z
    .object({
        filter: filterSchema,
        size: batchSizeSchema.optional().default(RADIO_PLAYLIST_DEFAULT_SIZE),
    })
    .strict();
const appendSchema = z
    .object({
        count: batchSizeSchema.optional().default(RADIO_PLAYLIST_DEFAULT_SIZE),
    })
    .strict();
const idSchema = z.string().min(1).max(200);

/** Router segment for generated radio playlist routes. */
export const radioPlaylistRouter = Router();

function sendValidationError(res: Response, issues: z.core.$ZodIssue[]) {
    return sendRouteError(res, 400, "Invalid radio playlist request", {
        details: issues,
    });
}

function sendServiceError(res: Response, error: unknown): Response | null {
    if (!(error instanceof RadioPlaylistServiceError)) return null;
    return sendRouteError(
        res,
        error.statusCode,
        error.message,
        error.code ? { code: error.code } : undefined,
    );
}

/** Handles POST /api/library/radio/playlists. */
export async function handleCreateRadioPlaylist(req: Request, res: Response) {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error.issues);
    try {
        const result = await createRadioPlaylist(
            req.user!.id,
            parsed.data.filter,
            parsed.data.size,
        );
        return res.json(result);
    } catch (error) {
        const response = sendServiceError(res, error);
        if (response) return response;
        throw error;
    }
}

/** Handles POST /api/library/radio/playlists/:id/append. */
export async function handleAppendRadioPlaylist(req: Request, res: Response) {
    const id = idSchema.safeParse(req.params.id);
    const body = appendSchema.safeParse(req.body ?? {});
    if (!id.success) return sendValidationError(res, id.error.issues);
    if (!body.success) return sendValidationError(res, body.error.issues);
    try {
        const result = await appendRadioPlaylist(
            req.user!.id,
            id.data,
            body.data.count,
        );
        return res.json(result);
    } catch (error) {
        const response = sendServiceError(res, error);
        if (response) return response;
        throw error;
    }
}

/** Handles POST /api/library/radio/playlists/:id/regenerate. */
export async function handleRegenerateRadioPlaylist(
    req: Request,
    res: Response,
) {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) return sendValidationError(res, id.error.issues);
    try {
        const result = await regenerateRadioPlaylist(req.user!.id, id.data);
        return res.json(result);
    } catch (error) {
        const response = sendServiceError(res, error);
        if (response) return response;
        throw error;
    }
}

/**
 * @openapi
 * /api/library/radio/playlists:
 *   post:
 *     summary: Return or generate a user-scoped radio playlist
 *     tags: [Library]
 *     security: [{ apiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [filter]
 *             properties:
 *               filter:
 *                 discriminator:
 *                   propertyName: type
 *                 oneOf:
 *                   - type: object
 *                     additionalProperties: false
 *                     required: [type, value]
 *                     properties:
 *                       type: { type: string, enum: [genre] }
 *                       value: { type: string, minLength: 1, maxLength: 200 }
 *                   - type: object
 *                     additionalProperties: false
 *                     required: [type, value]
 *                     properties:
 *                       type: { type: string, enum: [decade] }
 *                       value: { type: string, pattern: '^(?:1\d{2}|20\d)0$' }
 *                   - type: object
 *                     additionalProperties: false
 *                     required: [type]
 *                     properties:
 *                       type: { type: string, enum: [discovery] }
 *                   - type: object
 *                     additionalProperties: false
 *                     required: [type]
 *                     properties:
 *                       type: { type: string, enum: [favorites] }
 *                   - type: object
 *                     additionalProperties: false
 *                     required: [type]
 *                     properties:
 *                       type: { type: string, enum: [workout] }
 *               size:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 100
 *                 default: 25
 *     responses:
 *       200: { description: Generated playlist identifier and entries }
 *       400: { description: Invalid filter or size }
 *       401: { description: Not authenticated }
 */
radioPlaylistRouter.post(
    "/radio/playlists",
    asyncHandler(handleCreateRadioPlaylist),
);

/**
 * @openapi
 * /api/library/radio/playlists/{id}/append:
 *   post:
 *     summary: Append deduplicated tracks to a generated radio playlist
 *     tags: [Library]
 *     security: [{ apiKeyAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               count:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 100
 *                 default: 25
 *     responses:
 *       200: { description: Playlist identifier and appended entries }
 *       400: { description: Invalid request }
 *       403: { description: Access denied }
 *       404: { description: Playlist not found }
 *       503:
 *         description: Playlist mutation retries exhausted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [error, code]
 *               properties:
 *                 error: { type: string }
 *                 code: { type: string, enum: [RADIO_PLAYLIST_RETRY_EXHAUSTED] }
 *       401: { description: Not authenticated }
 */
radioPlaylistRouter.post(
    "/radio/playlists/:id/append",
    asyncHandler(handleAppendRadioPlaylist),
);

/**
 * @openapi
 * /api/library/radio/playlists/{id}/regenerate:
 *   post:
 *     summary: Regenerate an owned radio playlist from its stored filter
 *     tags: [Library]
 *     security: [{ apiKeyAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Playlist identifier and replacement entries }
 *       400: { description: Invalid request }
 *       403: { description: Access denied }
 *       404: { description: Playlist not found }
 *       503:
 *         description: Playlist mutation retries exhausted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [error, code]
 *               properties:
 *                 error: { type: string }
 *                 code: { type: string, enum: [RADIO_PLAYLIST_RETRY_EXHAUSTED] }
 *       401: { description: Not authenticated }
 */
radioPlaylistRouter.post(
    "/radio/playlists/:id/regenerate",
    asyncHandler(handleRegenerateRadioPlaylist),
);
