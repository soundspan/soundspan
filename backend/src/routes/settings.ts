import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import { logger } from "../utils/logger";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";
import { staleJobCleanupService } from "../services/staleJobCleanup";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max (matches frontend limit)
});

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

/**
 * @openapi
 * /api/settings:
 *   get:
 *     summary: Get the current user's settings
 *     tags: [User Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: User settings including display name and profile picture status
 *       401:
 *         description: Not authenticated
 */
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
                select: { displayName: true, profilePicture: false },
            }),
        ]);

        // Check if user has a profile picture without loading the blob
        const hasProfilePicture =
            (
                await prisma.$queryRaw<{ count: bigint }[]>`
                    SELECT COUNT(*)::bigint as count FROM "User"
                    WHERE id = ${userId} AND "profilePicture" IS NOT NULL
                `
            )[0]?.count > 0n;

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
            hasProfilePicture,
        });
    } catch (error) {
        logger.error("Get settings error:", error);
        res.status(500).json({ error: "Failed to get settings" });
    }
});

/**
 * @openapi
 * /api/settings:
 *   post:
 *     summary: Update the current user's settings
 *     tags: [User Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               playbackQuality:
 *                 type: string
 *                 enum: [original, high, medium, low]
 *               shareOnlinePresence:
 *                 type: boolean
 *               shareListeningStatus:
 *                 type: boolean
 *               wifiOnly:
 *                 type: boolean
 *               offlineEnabled:
 *                 type: boolean
 *               maxCacheSizeMb:
 *                 type: integer
 *               ytMusicQuality:
 *                 type: string
 *                 enum: [LOW, MEDIUM, HIGH, LOSSLESS]
 *               tidalStreamingQuality:
 *                 type: string
 *                 enum: [LOW, HIGH, LOSSLESS, HI_RES_LOSSLESS]
 *               displayName:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Settings updated successfully
 *       400:
 *         description: Invalid settings
 *       401:
 *         description: Not authenticated
 */
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

/**
 * @openapi
 * /api/settings/cleanup-stale-jobs:
 *   post:
 *     summary: Clean up stale background jobs (admin only)
 *     tags: [User Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Stale jobs cleaned up successfully
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
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

/**
 * @openapi
 * /api/settings/profile-picture:
 *   post:
 *     summary: Upload or update the user's profile picture
 *     tags: [User Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Image file (JPEG, PNG, WebP, or GIF, max 5MB)
 *     responses:
 *       200:
 *         description: Profile picture uploaded successfully
 *       400:
 *         description: No file provided, file too large, or invalid file type
 *       401:
 *         description: Not authenticated
 */
// POST /settings/profile-picture
const ALLOWED_IMAGE_MIMES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
]);

router.post(
    "/profile-picture",
    (req, res, next) => {
        upload.single("file")(req, res, (err) => {
            if (err instanceof multer.MulterError) {
                if (err.code === "LIMIT_FILE_SIZE") {
                    return res.status(400).json({ error: "File too large. Maximum 5MB." });
                }
                return res.status(400).json({ error: err.message });
            }
            if (err) {
                return res.status(400).json({ error: "Upload failed" });
            }
            next();
        });
    },
    async (req, res) => {
        try {
            const userId = req.user!.id;
            const file = req.file;

            if (!file) {
                return res.status(400).json({ error: "No file provided" });
            }

            if (!ALLOWED_IMAGE_MIMES.has(file.mimetype)) {
                return res.status(400).json({
                    error: "Invalid file type. Allowed: JPEG, PNG, WebP, GIF",
                });
            }

            const buffer = await sharp(file.buffer)
                .resize(512, 512, { fit: "cover" })
                .rotate() // auto-rotate based on EXIF
                .jpeg({ quality: 85 })
                .toBuffer();

            await prisma.user.update({
                where: { id: userId },
                data: { profilePicture: new Uint8Array(buffer) },
            });

            return res.json({ success: true });
        } catch (error) {
            logger.error("Profile picture upload error:", error);
            return res
                .status(500)
                .json({ error: "Failed to upload profile picture" });
        }
    }
);

/**
 * @openapi
 * /api/settings/profile-picture:
 *   delete:
 *     summary: Delete the user's profile picture
 *     tags: [User Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Profile picture deleted successfully
 *       401:
 *         description: Not authenticated
 */
// DELETE /settings/profile-picture
router.delete("/profile-picture", async (req, res) => {
    try {
        const userId = req.user!.id;

        await prisma.user.update({
            where: { id: userId },
            data: { profilePicture: null },
        });

        return res.json({ success: true });
    } catch (error) {
        logger.error("Profile picture delete error:", error);
        return res
            .status(500)
            .json({ error: "Failed to delete profile picture" });
    }
});

export default router;
