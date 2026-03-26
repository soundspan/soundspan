import { Router } from "express";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

const router = Router();

router.use(requireAuth, requireAdmin);

function isPrismaRecordNotFound(error: unknown): error is { code: string } {
    return Boolean(
        error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "P2025"
    );
}

/**
 * @openapi
 * /api/admin/library-health:
 *   get:
 *     summary: List library health records
 *     tags: [Admin]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Library health records returned successfully
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
router.get("/library-health", async (_req, res) => {
    try {
        const [records, total] = await Promise.all([
            prisma.libraryHealthRecord.findMany({
                include: {
                    track: {
                        select: {
                            id: true,
                            title: true,
                            album: {
                                select: {
                                    title: true,
                                    artist: {
                                        select: {
                                            name: true,
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                orderBy: {
                    updatedAt: "desc",
                },
            }),
            prisma.libraryHealthRecord.count(),
        ]);

        res.json({ records, total });
    } catch (error) {
        logger.error("Get library health error:", error);
        res.status(500).json({ error: "Failed to load library health records" });
    }
});

/**
 * @openapi
 * /api/admin/library-health/{recordId}:
 *   delete:
 *     summary: Dismiss a library health record
 *     tags: [Admin]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: recordId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Record dismissed successfully
 *       404:
 *         description: Library health record not found
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
router.delete("/library-health/:recordId", async (req, res) => {
    try {
        await prisma.libraryHealthRecord.delete({
            where: {
                id: req.params.recordId,
            },
        });

        res.json({ success: true });
    } catch (error) {
        if (isPrismaRecordNotFound(error)) {
            return res.status(404).json({ error: "Library health record not found" });
        }

        logger.error("Dismiss library health record error:", error);
        res.status(500).json({ error: "Failed to dismiss library health record" });
    }
});

export default router;
