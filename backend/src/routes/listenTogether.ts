/**
 * REST routes for Listen Together.
 *
 * These handle the "cold path": creating groups, joining by code,
 * discovering public groups, leaving, and ending groups.
 *
 * All real-time playback sync goes through Socket.IO (listenTogetherSocket.ts).
 */

import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { logger } from "../utils/logger";
import {
    createGroup,
    joinGroup,
    discoverGroups,
    getActiveGroupCount,
    getMyGroup,
    leaveGroup,
    endGroup,
} from "../services/listenTogether";
import { GroupError } from "../services/listenTogetherManager";

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const createGroupSchema = z.object({
    name: z.string().trim().min(1).max(80).optional(),
    visibility: z.enum(["public", "private"]).optional(),
    queueTrackIds: z.array(z.string().min(1)).max(500).optional(),
    currentTrackId: z.string().min(1).optional(),
    currentTimeMs: z.number().finite().min(0).max(86_400_000).optional(),
    isPlaying: z.boolean().optional(),
});

const joinGroupSchema = z.object({
    joinCode: z.string().min(1).max(64),
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

function handleError(label: string, error: unknown, res: Response) {
    if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid request", details: error.errors });
    }
    if (error instanceof GroupError) {
        const statusMap: Record<string, number> = {
            NOT_FOUND: 404,
            NOT_MEMBER: 403,
            NOT_ALLOWED: 403,
            INVALID: 400,
            CONFLICT: 409,
        };
        return res.status(statusMap[error.code] ?? 500).json({ error: error.message });
    }
    logger.error(`[ListenTogether] ${label} failed:`, error);
    return res.status(500).json({ error: "Internal server error" });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /listen-together:
 *   post:
 *     summary: Create a new Listen Together group
 *     tags: [Listen Together]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       201:
 *         description: Group created
 */
router.post("/", async (req, res) => {
    try {
        const user = req.user!;
        const payload = createGroupSchema.parse(req.body ?? {});
        const snapshot = await createGroup(user.id, user.username, payload);
        return res.status(201).json(snapshot);
    } catch (error) {
        return handleError("create", error, res);
    }
});

/**
 * @openapi
 * /listen-together/join:
 *   post:
 *     summary: Join a Listen Together group by code
 *     tags: [Listen Together]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Joined group
 */
router.post("/join", async (req, res) => {
    try {
        const user = req.user!;
        const payload = joinGroupSchema.parse(req.body ?? {});
        const snapshot = await joinGroup(user.id, user.username, payload.joinCode);
        return res.json(snapshot);
    } catch (error) {
        return handleError("join", error, res);
    }
});

/**
 * @openapi
 * /listen-together/discover:
 *   get:
 *     summary: Discover public Listen Together groups
 *     tags: [Listen Together]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Discoverable groups
 */
router.get("/discover", async (req, res) => {
    try {
        const groups = await discoverGroups(req.user!.id);
        return res.json(groups);
    } catch (error) {
        return handleError("discover", error, res);
    }
});

/**
 * @openapi
 * /listen-together/active-count:
 *   get:
 *     summary: Get the count of active Listen Together groups
 *     tags: [Listen Together]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Count of active groups
 */
router.get("/active-count", async (_req, res) => {
    try {
        const count = await getActiveGroupCount();
        return res.json({ count });
    } catch (error) {
        return handleError("active-count", error, res);
    }
});

/**
 * @openapi
 * /listen-together/mine:
 *   get:
 *     summary: Get the current user's active Listen Together group
 *     tags: [Listen Together]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Active group or null
 */
router.get("/mine", async (req, res) => {
    try {
        const snapshot = await getMyGroup(req.user!.id);
        return res.json(snapshot);
    } catch (error) {
        return handleError("mine", error, res);
    }
});

/**
 * @openapi
 * /listen-together/{groupId}/leave:
 *   post:
 *     summary: Leave a Listen Together group
 *     tags: [Listen Together]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Leave result
 */
router.post("/:groupId/leave", async (req, res) => {
    try {
        const result = await leaveGroup(req.user!.id, req.params.groupId);
        return res.json({ success: true, ...result });
    } catch (error) {
        return handleError("leave", error, res);
    }
});

/**
 * @openapi
 * /listen-together/{groupId}/end:
 *   post:
 *     summary: End a Listen Together group (host only)
 *     tags: [Listen Together]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Group ended
 */
router.post("/:groupId/end", async (req, res) => {
    try {
        await endGroup(req.user!.id, req.params.groupId);
        return res.json({ success: true });
    } catch (error) {
        return handleError("end", error, res);
    }
});

export default router;
