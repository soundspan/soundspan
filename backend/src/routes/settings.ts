import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";
import { staleJobCleanupService } from "../services/staleJobCleanup";

const router = Router();

router.use(requireAuth);

const displayNamePattern = /^[A-Za-z0-9 .-]+$/;
const displayNameValidationMessage =
    "Display name may only contain letters, numbers, spaces, periods, and hyphens";

const displayNameSchema = z
    .string()
    .trim()
    .max(80)
    .refine(
        (value) => value.length === 0 || displayNamePattern.test(value),
        { message: displayNameValidationMessage }
    );

const settingsSchema = z.object({
    playbackQuality: z.enum(["original", "high", "medium", "low"]).optional(),
    shareOnlinePresence: z.boolean().optional(),
    shareListeningStatus: z.boolean().optional(),
    wifiOnly: z.boolean().optional(),
    offlineEnabled: z.boolean().optional(),
    maxCacheSizeMb: z.number().int().min(0).optional(),
    // YouTube Music (per-user)
    ytMusicQuality: z.enum(["LOW", "MEDIUM", "HIGH", "LOSSLESS"]).optional(),
    tidalStreamingQuality: z.enum(["LOW", "HIGH", "LOSSLESS", "HI_RES_LOSSLESS"]).optional(),
    displayName: displayNameSchema.nullable().optional(),
});

// GET /settings
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;

        const [existingSettings, user] = await Promise.all([
            prisma.userSettings.findUnique({
                where: { userId },
            }),
            prisma.user.findUnique({
                where: { id: userId },
                select: { displayName: true },
            }),
        ]);

        let settings = existingSettings;

        // Create default settings if they don't exist
        if (!settings) {
            settings = await prisma.userSettings.create({
                data: {
                    userId,
                    playbackQuality: "medium",
                    shareOnlinePresence: false,
                    shareListeningStatus: false,
                    wifiOnly: false,
                    offlineEnabled: false,
                    maxCacheSizeMb: 5120,
                },
            });
        }

        res.json({
            ...settings,
            displayName: user?.displayName ?? null,
        });
    } catch (error) {
        logger.error("Get settings error:", error);
        res.status(500).json({ error: "Failed to get settings" });
    }
});

// POST /settings
router.post("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const data = settingsSchema.parse(req.body);
        const { displayName, ...settingsData } = data;

        const normalizedDisplayName =
            displayName === undefined
                ? undefined
                : displayName === null || displayName.trim().length === 0
                  ? null
                  : displayName.trim();

        const settings = await prisma.userSettings.upsert({
            where: { userId },
            create: {
                userId,
                ...settingsData,
            },
            update: settingsData,
        });

        if (normalizedDisplayName !== undefined) {
            await prisma.user.update({
                where: { id: userId },
                data: { displayName: normalizedDisplayName },
            });
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { displayName: true },
        });

        res.json({
            ...settings,
            displayName: user?.displayName ?? null,
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid settings", details: error.errors });
        }
        logger.error("Update settings error:", error);
        res.status(500).json({ error: "Failed to update settings" });
    }
});

// POST /settings/cleanup-stale-jobs
router.post("/cleanup-stale-jobs", requireAdmin, async (req, res) => {
    try {
        const result = await staleJobCleanupService.cleanupAll();

        res.json({
            success: true,
            cleaned: {
                discoveryBatches: result.discoveryBatches,
                downloadJobs: result.downloadJobs,
                spotifyImportJobs: result.spotifyImportJobs,
                bullQueues: result.bullQueues,
            },
            totalCleaned: result.totalCleaned,
        });
    } catch (error) {
        logger.error("Stale job cleanup error:", error);
        res.status(500).json({ error: "Failed to cleanup stale jobs" });
    }
});

export default router;
