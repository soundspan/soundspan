import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

const router = Router();

const playlistItemInclude = {
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
    trackTidal: true,
    trackYtMusic: true,
} as const;

const shareResourceTypeSchema = z.enum(["playlist", "album", "track"]);

const createShareLinkSchema = z.object({
    resourceType: shareResourceTypeSchema,
    resourceId: z.string().trim().min(1),
    expiresAt: z.string().datetime().optional(),
    maxPlays: z.number().int().positive().optional(),
});

const shareLinkIdSchema = z.object({
    id: z.string().trim().min(1),
});

const shareTokenSchema = z.object({
    token: z.string().trim().min(1),
});

function isExpired(expiresAt: Date | null): boolean {
    if (!expiresAt) return false;
    return expiresAt.getTime() <= Date.now();
}

async function resolveSharedResource(resourceType: string, resourceId: string) {
    if (resourceType === "playlist") {
        return prisma.playlist.findUnique({
            where: { id: resourceId },
            include: {
                user: {
                    select: {
                        username: true,
                    },
                },
                items: {
                    include: playlistItemInclude,
                    orderBy: { sort: "asc" },
                },
                pendingTracks: {
                    orderBy: { sort: "asc" },
                },
            },
        });
    }

    if (resourceType === "album") {
        return prisma.album.findUnique({
            where: { id: resourceId },
            include: {
                artist: {
                    select: {
                        id: true,
                        name: true,
                        mbid: true,
                    },
                },
                tracks: {
                    orderBy: [{ discNo: "asc" }, { trackNo: "asc" }],
                    include: {
                        album: {
                            include: {
                                artist: {
                                    select: {
                                        id: true,
                                        name: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });
    }

    return prisma.track.findUnique({
        where: { id: resourceId },
        include: {
            album: {
                include: {
                    artist: {
                        select: {
                            id: true,
                            name: true,
                        },
                    },
                },
            },
        },
    });
}

/**
 * @openapi
 * /api/share-links:
 *   post:
 *     summary: Create a share link for a playlist, album, or track
 *     tags: [Share Links]
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
 *               - resourceType
 *               - resourceId
 *             properties:
 *               resourceType:
 *                 type: string
 *                 enum: [playlist, album, track]
 *               resourceId:
 *                 type: string
 *               expiresAt:
 *                 type: string
 *                 format: date-time
 *               maxPlays:
 *                 type: integer
 *                 minimum: 1
 *     responses:
 *       200:
 *         description: Created share link with access path
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Resource not found
 */
router.post("/", requireAuth, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        const data = createShareLinkSchema.parse(req.body);
        const userId = req.user.id;
        const role = req.user.role;
        const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;

        if (data.resourceType === "playlist") {
            const playlist = await prisma.playlist.findUnique({
                where: { id: data.resourceId },
                select: { id: true, userId: true },
            });
            if (!playlist) {
                return res.status(404).json({ error: "Resource not found" });
            }
            if (playlist.userId !== userId && role !== "admin") {
                return res.status(403).json({ error: "Access denied" });
            }
        } else if (data.resourceType === "album") {
            const album = await prisma.album.findUnique({
                where: { id: data.resourceId },
                select: { id: true },
            });
            if (!album) {
                return res.status(404).json({ error: "Resource not found" });
            }
        } else {
            const track = await prisma.track.findUnique({
                where: { id: data.resourceId },
                select: { id: true },
            });
            if (!track) {
                return res.status(404).json({ error: "Resource not found" });
            }
        }

        const token = crypto.randomBytes(32).toString("hex");
        const shareLink = await prisma.shareLink.create({
            data: {
                token,
                userId,
                resourceType: data.resourceType,
                resourceId: data.resourceId,
                expiresAt,
                maxPlays: data.maxPlays,
            },
        });

        res.json({
            ...shareLink,
            accessPath: `/api/share-links/access/${shareLink.token}`,
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.errors });
        }
        logger.error("Create share link error:", error);
        res.status(500).json({ error: "Failed to create share link" });
    }
});

/**
 * @openapi
 * /api/share-links:
 *   get:
 *     summary: List non-revoked share links for the current user
 *     tags: [Share Links]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Share links for current user
 *       401:
 *         description: Not authenticated
 */
router.get("/", requireAuth, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        const userId = req.user.id;
        const links = await prisma.shareLink.findMany({
            where: {
                userId,
                revoked: false,
            },
            orderBy: { createdAt: "desc" },
        });

        res.json(
            links.map((link) => ({
                ...link,
                accessPath: `/api/share-links/access/${link.token}`,
            }))
        );
    } catch (error) {
        logger.error("List share links error:", error);
        res.status(500).json({ error: "Failed to list share links" });
    }
});

/**
 * @openapi
 * /api/share-links/{id}:
 *   delete:
 *     summary: Revoke a share link owned by the current user
 *     tags: [Share Links]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Share link ID
 *     responses:
 *       200:
 *         description: Share link revoked
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Share link not found
 */
router.delete("/:id", requireAuth, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        const { id } = shareLinkIdSchema.parse(req.params);
        const userId = req.user.id;

        const existing = await prisma.shareLink.findFirst({
            where: {
                id,
                userId,
            },
            select: { id: true },
        });

        if (!existing) {
            return res.status(404).json({ error: "Share link not found" });
        }

        await prisma.shareLink.update({
            where: { id },
            data: { revoked: true },
        });

        res.json({ success: true });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.errors });
        }
        logger.error("Revoke share link error:", error);
        res.status(500).json({ error: "Failed to revoke share link" });
    }
});

/**
 * @openapi
 * /api/share-links/access/{token}:
 *   get:
 *     summary: Access a shared playlist, album, or track by token
 *     tags: [Share Links]
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *         description: Share token
 *     responses:
 *       200:
 *         description: Shared resource payload
 *       404:
 *         description: Share link not found
 */
router.get("/access/:token", async (req, res) => {
    try {
        const { token } = shareTokenSchema.parse(req.params);
        const now = new Date();

        const shareLink = await prisma.shareLink.findUnique({
            where: { token },
        });

        if (!shareLink) {
            return res.status(404).json({ error: "Share link not found" });
        }

        if (shareLink.revoked) {
            return res.status(404).json({ error: "Share link not found" });
        }

        if (isExpired(shareLink.expiresAt)) {
            return res.status(404).json({ error: "Share link not found" });
        }

        if (
            shareLink.maxPlays !== null &&
            shareLink.playCount >= shareLink.maxPlays
        ) {
            return res.status(404).json({ error: "Share link not found" });
        }

        const resource = await resolveSharedResource(
            shareLink.resourceType,
            shareLink.resourceId
        );
        if (!resource) {
            return res.status(404).json({ error: "Share link not found" });
        }

        const incrementResult = await prisma.shareLink.updateMany({
            where: {
                id: shareLink.id,
                revoked: false,
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                ...(shareLink.maxPlays !== null
                    ? {
                          playCount: {
                              lt: shareLink.maxPlays,
                          },
                      }
                    : {}),
            },
            data: {
                playCount: {
                    increment: 1,
                },
            },
        });

        if (incrementResult.count === 0) {
            return res.status(404).json({ error: "Share link not found" });
        }

        res.json({
            resourceType: shareLink.resourceType,
            resource,
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.errors });
        }
        logger.error("Access share link error:", error);
        res.status(500).json({ error: "Failed to access share link" });
    }
});

export default router;
