import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";

const router = Router();

router.use(requireAuth);

const playSchema = z.object({
    trackId: z.string(),
});

const playHistoryRangeSchema = z.enum(["7d", "30d", "365d", "all"]);
type PlayHistoryRange = z.infer<typeof playHistoryRangeSchema>;

const getHistoryRangeStart = (range: Exclude<PlayHistoryRange, "all">): Date => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const lookbackDays = range === "7d" ? 7 : range === "30d" ? 30 : 365;
    return new Date(now - lookbackDays * dayMs);
};

/**
 * @openapi
 * /api/plays/summary:
 *   get:
 *     summary: Get play count summaries across time ranges
 *     tags: [Plays]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Play count summaries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 allTime:
 *                   type: integer
 *                 last7Days:
 *                   type: integer
 *                 last30Days:
 *                   type: integer
 *                 last365Days:
 *                   type: integer
 *       401:
 *         description: Not authenticated
 */
// GET /plays/summary (counts for warning/confirmation UI)
router.get("/summary", async (req, res) => {
    try {
        const userId = req.session.userId!;
        const now = new Date();
        const sevenDaysAgo = getHistoryRangeStart("7d");
        const thirtyDaysAgo = getHistoryRangeStart("30d");
        const yearAgo = getHistoryRangeStart("365d");

        const [allTime, last7Days, last30Days, last365Days] = await Promise.all([
            prisma.play.count({
                where: { userId },
            }),
            prisma.play.count({
                where: {
                    userId,
                    playedAt: { gte: sevenDaysAgo, lte: now },
                },
            }),
            prisma.play.count({
                where: {
                    userId,
                    playedAt: { gte: thirtyDaysAgo, lte: now },
                },
            }),
            prisma.play.count({
                where: {
                    userId,
                    playedAt: { gte: yearAgo, lte: now },
                },
            }),
        ]);

        res.json({
            allTime,
            last7Days,
            last30Days,
            last365Days,
        });
    } catch (error) {
        logger.error("Get play summary error:", error);
        res.status(500).json({ error: "Failed to get play history summary" });
    }
});

/**
 * @openapi
 * /api/plays/history:
 *   delete:
 *     summary: Clear play history for a given time range
 *     tags: [Plays]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: range
 *         schema:
 *           type: string
 *           enum: [7d, 30d, 365d, all]
 *           default: 30d
 *     responses:
 *       200:
 *         description: Play history cleared
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 range:
 *                   type: string
 *                 deletedCount:
 *                   type: integer
 *       400:
 *         description: Invalid range parameter
 *       401:
 *         description: Not authenticated
 */
// DELETE /plays/history?range=7d|30d|365d|all
router.delete("/history", async (req, res) => {
    try {
        const userId = req.session.userId!;
        const parsed = playHistoryRangeSchema.safeParse(
            (req.query.range as string) || "30d"
        );

        if (!parsed.success) {
            return res.status(400).json({
                error: "Invalid range. Expected one of: 7d, 30d, 365d, all",
            });
        }

        const range = parsed.data;
        const where =
            range === "all"
                ? { userId }
                : {
                      userId,
                      playedAt: {
                          gte: getHistoryRangeStart(range),
                          lte: new Date(),
                      },
                  };

        const result = await prisma.play.deleteMany({ where });

        res.json({
            success: true,
            range,
            deletedCount: result.count,
        });
    } catch (error) {
        logger.error("Clear play history error:", error);
        res.status(500).json({ error: "Failed to clear play history" });
    }
});

/**
 * @openapi
 * /api/plays:
 *   post:
 *     summary: Log a new play for a track
 *     tags: [Plays]
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
 *               - trackId
 *             properties:
 *               trackId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Play logged successfully
 *       400:
 *         description: Invalid request body
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Track not found
 */
// POST /plays
router.post("/", async (req, res) => {
    try {
        const userId = req.session.userId!;
        const { trackId } = playSchema.parse(req.body);

        // Verify track exists
        const track = await prisma.track.findUnique({
            where: { id: trackId },
        });

        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        const play = await prisma.play.create({
            data: {
                userId,
                trackId,
            },
        });

        res.json(play);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.errors });
        }
        logger.error("Create play error:", error);
        res.status(500).json({ error: "Failed to log play" });
    }
});

/**
 * @openapi
 * /api/plays:
 *   get:
 *     summary: Get recent plays for the authenticated user
 *     tags: [Plays]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: List of recent plays with track details
 *       401:
 *         description: Not authenticated
 */
// GET /plays (recent plays for user)
router.get("/", async (req, res) => {
    try {
        const userId = req.session.userId!;
        const { limit = "50" } = req.query;

        const plays = await prisma.play.findMany({
            where: { userId },
            orderBy: { playedAt: "desc" },
            take: parseInt(limit as string, 10),
            include: {
                track: {
                    include: {
                        album: {
                            include: {
                                artist: {
                                    select: {
                                        id: true,
                                        name: true,
                                        mbid: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        res.json(plays);
    } catch (error) {
        logger.error("Get plays error:", error);
        res.status(500).json({ error: "Failed to get plays" });
    }
});

export default router;
