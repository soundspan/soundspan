import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { parseBoundedInt } from "../utils/queryParams";
import { z } from "zod";
import { TRACK_VISIBLE_WHERE } from "../utils/librarySorting";

const router = Router();

router.use(requireAuth);

const listeningStateSchema = z.object({
    kind: z.enum(["music", "book"]),
    entityId: z.string(),
    trackId: z.string().optional(),
    positionMs: z.number().int().min(0),
});

async function filterVisibleTrackStates<
    T extends { kind: string; entityId: string },
>(states: T[]): Promise<T[]> {
    const trackIds = Array.from(
        new Set(
            states
                .filter((state) => state.kind === "music")
                .map((state) => state.entityId),
        ),
    );
    if (trackIds.length === 0) return states;

    const visibleTracks = await prisma.track.findMany({
        where: { ...TRACK_VISIBLE_WHERE, id: { in: trackIds } },
        select: { id: true },
    });
    const visibleTrackIds = new Set(visibleTracks.map((track) => track.id));
    return states.filter(
        (state) =>
            state.kind !== "music" || visibleTrackIds.has(state.entityId),
    );
}

/**
 * @openapi
 * /api/listening-state:
 *   post:
 *     summary: Create or update a listening state for an entity
 *     tags: [Listening State]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - kind
 *               - entityId
 *               - positionMs
 *             properties:
 *               kind:
 *                 type: string
 *                 enum: [music, book]
 *               entityId:
 *                 type: string
 *               trackId:
 *                 type: string
 *               positionMs:
 *                 type: integer
 *                 minimum: 0
 *     responses:
 *       200:
 *         description: Listening state created or updated
 *       400:
 *         description: Invalid request body
 *       401:
 *         description: Not authenticated
 */
// POST /listening-state
router.post("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const data = listeningStateSchema.parse(req.body);

        const state = await prisma.listeningState.upsert({
            where: {
                userId_kind_entityId: {
                    userId,
                    kind: data.kind,
                    entityId: data.entityId,
                },
            },
            create: {
                userId,
                ...data,
            },
            update: {
                trackId: data.trackId,
                positionMs: data.positionMs,
                updatedAt: new Date(),
            },
        });

        res.json(state);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.issues });
        }
        logger.error("Update listening state error:", error);
        res.status(500).json({ error: "Failed to update listening state" });
    }
});

/**
 * @openapi
 * /api/listening-state:
 *   get:
 *     summary: Get listening state for a specific entity
 *     tags: [Listening State]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: kind
 *         required: true
 *         schema:
 *           type: string
 *           enum: [music, book]
 *       - in: query
 *         name: entityId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Listening state for the entity
 *       400:
 *         description: Missing kind or entityId query parameters
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: No listening state found
 */
// GET /listening-state
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { kind, entityId } = req.query;

        if (!kind || !entityId) {
            return res
                .status(400)
                .json({ error: "kind and entityId required" });
        }

        const state = await prisma.listeningState.findUnique({
            where: {
                userId_kind_entityId: {
                    userId,
                    kind: kind as string,
                    entityId: entityId as string,
                },
            },
        });

        if (!state) {
            return res.status(404).json({ error: "No listening state found" });
        }

        res.json(state);
    } catch (error) {
        logger.error("Get listening state error:", error);
        res.status(500).json({ error: "Failed to get listening state" });
    }
});

/**
 * @openapi
 * /api/listening-state/recent:
 *   get:
 *     summary: Get recent listening states for "Continue Listening"
 *     tags: [Listening State]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *           minimum: 1
 *           maximum: 200
 *     responses:
 *       200:
 *         description: List of recent listening states ordered by last update
 *       401:
 *         description: Not authenticated
 */
// GET /listening-state/recent (for "Continue Listening")
router.get("/recent", async (req, res) => {
    try {
        const userId = req.user!.id;
        const limit = parseBoundedInt(req.query.limit, 10, 1, 200);

        const states = await prisma.listeningState.findMany({
            where: { userId },
            orderBy: { updatedAt: "desc" },
            take: limit,
        });

        res.json(await filterVisibleTrackStates(states));
    } catch (error) {
        logger.error("Get recent listening states error:", error);
        res.status(500).json({
            error: "Failed to get recent listening states",
        });
    }
});

export default router;
