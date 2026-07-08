/**
 * Lidarr Webhook Handler (Refactored)
 *
 * Handles Lidarr webhooks for download tracking and Discovery Weekly integration.
 * Uses the stateless simpleDownloadManager for all operations.
 */

import { Router } from "express";
import { scanQueue } from "../workers/queues";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { queueCleaner } from "../jobs/queueCleaner";
import { getSystemSettings } from "../utils/systemSettings";
import { webhookLimiter } from "../middleware/rateLimiter";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { BRAND_SLUG } from "../config/brand";
import { timingSafeCompare } from "../utils/timingSafe";

const router = Router();
const LEGACY_SERVICE_ALIASES = [BRAND_SLUG];

/**
 * @openapi
 * /api/webhooks/lidarr/verify:
 *   get:
 *     summary: Verify webhook endpoint is reachable
 *     tags: [Webhooks]
 *     responses:
 *       200:
 *         description: Webhook service status and version
 */
// GET /webhooks/lidarr/verify - Webhook verification endpoint
router.get("/lidarr/verify", (req, res) => {
    logger.debug("[WEBHOOK] Verification request received");
    res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        service: BRAND_SLUG,
        legacyServiceAliases: LEGACY_SERVICE_ALIASES,
        version: process.env.npm_package_version || "unknown",
    });
});

/**
 * @openapi
 * /api/webhooks/lidarr:
 *   post:
 *     summary: Handle incoming Lidarr webhook events
 *     tags: [Webhooks]
 *     parameters:
 *       - in: header
 *         name: x-webhook-secret
 *         required: false
 *         schema:
 *           type: string
 *         description: Webhook secret for authentication (if configured)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               eventType:
 *                 type: string
 *                 description: "Lidarr event type (Grab, Download, Test, etc.)"
 *     responses:
 *       200:
 *         description: Webhook processed successfully
 *       202:
 *         description: Webhook ignored (Lidarr disabled)
 *       401:
 *         description: Invalid webhook secret
 */
// POST /webhooks/lidarr - Handle Lidarr webhooks
router.post("/lidarr", webhookLimiter, async (req, res) => {
    try {
        // Check if Lidarr is enabled before processing any webhooks
        const settings = await getSystemSettings();
        if (
            !settings?.lidarrEnabled ||
            !settings?.lidarrUrl ||
            !settings?.lidarrApiKey
        ) {
            logger.debug(
                `[WEBHOOK] Lidarr webhook received but Lidarr is disabled. Ignoring.`
            );
            return res.status(202).json({
                success: true,
                ignored: true,
                reason: "lidarr-disabled",
            });
        }

        // Verify webhook secret if configured (fail-closed when present).
        // Note: settings.lidarrWebhookSecret is already decrypted by getSystemSettings()
        if (settings.lidarrWebhookSecret) {
            const providedSecret = req.headers["x-webhook-secret"] as string;

            if (!providedSecret || !timingSafeCompare(providedSecret, settings.lidarrWebhookSecret)) {
                logger.debug(
                    `[WEBHOOK] Lidarr webhook received with invalid or missing secret`
                );
                return res.status(401).json({
                    error: "Unauthorized - Invalid webhook secret",
                });
            }
        } else {
            // No secret configured: the endpoint is unauthenticated. We don't
            // hard-fail (that would silently break existing Lidarr integrations
            // that have no secret yet), but the request is rate-limited and the
            // operator is strongly nudged to set one. See docs/UPGRADING.md.
            logger.warn(
                "[WEBHOOK] Lidarr webhook accepted WITHOUT authentication — set a webhook secret in System Settings and Lidarr's connection (x-webhook-secret) to secure this endpoint."
            );
        }

        const eventType = req.body.eventType;
        logger.debug(`[WEBHOOK] Lidarr event: ${eventType}`);

        // Log payload in debug mode only (avoid verbose logs in production)
        if (process.env.DEBUG_WEBHOOKS === "true") {
            logger.debug(`   Payload:`, JSON.stringify(req.body, null, 2));
        }

        switch (eventType) {
            case "Grab":
                await handleGrab(req.body);
                break;

            case "Download":
            case "AlbumDownload":
            case "TrackRetag":
            case "Rename":
                await handleDownload(req.body);
                break;

            case "ImportFailure":
            case "DownloadFailed":
            case "DownloadFailure":
                await handleImportFailure(req.body);
                break;

            case "Health":
            case "HealthIssue":
            case "HealthRestored":
                // Ignore health events
                break;

            case "Test":
                logger.debug("   Lidarr test webhook received");
                break;

            default:
                logger.debug(`   Unhandled event: ${eventType}`);
        }

        res.json({ success: true });
    } catch (error: any) {
        logger.error("Webhook error:", error.message);
        res.status(500).json({ error: "Webhook processing failed" });
    }
});

/**
 * Handle Grab event (download started by Lidarr)
 */
async function handleGrab(payload: any) {
    const downloadId = payload.downloadId;
    const albumMbid =
        payload.albums?.[0]?.foreignAlbumId || payload.albums?.[0]?.mbId;
    const albumTitle = payload.albums?.[0]?.title;
    const artistName = payload.artist?.name;
    const lidarrAlbumId = payload.albums?.[0]?.id;

    logger.debug(`   Album: ${artistName} - ${albumTitle}`);
    logger.debug(`   Download ID: ${downloadId}`);
    logger.debug(`   MBID: ${albumMbid}`);

    if (!downloadId) {
        logger.debug(`   Missing downloadId, skipping`);
        return;
    }

    // Use the download manager's multi-strategy matching
    const result = await simpleDownloadManager.onDownloadGrabbed(
        downloadId,
        albumMbid || "",
        albumTitle || "",
        artistName || "",
        lidarrAlbumId || 0
    );

    if (result.matched) {
        // Start queue cleaner to monitor this download
        queueCleaner.start();
    }
}

/**
 * Handle Download event (download complete + imported)
 */
async function handleDownload(payload: any) {
    const downloadId = payload.downloadId;
    const albumTitle = payload.album?.title || payload.albums?.[0]?.title;
    const artistName = payload.artist?.name;
    const albumMbid =
        payload.album?.foreignAlbumId || payload.albums?.[0]?.foreignAlbumId;
    const lidarrAlbumId = payload.album?.id || payload.albums?.[0]?.id;

    logger.debug(`   Album: ${artistName} - ${albumTitle}`);
    logger.debug(`   Download ID: ${downloadId}`);
    logger.debug(`   Album MBID: ${albumMbid}`);
    logger.debug(`   Lidarr Album ID: ${lidarrAlbumId}`);

    if (!downloadId) {
        logger.debug(`   Missing downloadId, skipping`);
        return;
    }

    // Handle completion through download manager
    const result = await simpleDownloadManager.onDownloadComplete(
        downloadId,
        albumMbid,
        artistName,
        albumTitle,
        lidarrAlbumId
    );

    if (result.jobId) {
        // Find the download job that triggered this webhook to get userId
        const downloadJob = await prisma.downloadJob.findUnique({
            where: { id: result.jobId },
            select: { userId: true, id: true },
        });

        // Trigger scan immediately for this album (incremental scan with enrichment data)
        // Don't wait for batch completion - enrichment should happen per-album
        logger.debug(
            `   Triggering incremental scan for: ${artistName} - ${albumTitle}`
        );
        await scanQueue.add("scan", {
            userId: downloadJob?.userId || null,
            source: "lidarr-webhook",
            artistName: artistName,
            albumMbid: albumMbid,
            downloadId: result.jobId,
        });

        // Discovery batch completion (for playlist building) is handled by download manager
    } else {
        // No matching job — an external download we didn't initiate. The old
        // behavior enqueued an unconditional full-library scan per event: an
        // unauthenticated-reachable DoS, since a stream of unmatched webhooks
        // spammed expensive full scans (F32). But there is no periodic/watcher
        // scan to fall back on, so skipping entirely would strand external
        // Lidarr imports until someone scans manually. Instead, COALESCE: a
        // stable Bull jobId makes concurrent add() calls collapse into one
        // queued scan (same scheme as the YouTube download scan in
        // routes/youtube.ts), bounding a webhook flood to a single queued scan
        // at a time. Edge: an import landing while a scan is already ACTIVE
        // waits for the next scan trigger — acceptable next to the DoS.
        logger.debug(
            `   No matching job for downloadId=${downloadId}; requesting coalesced library scan for the external import.`
        );
        await scanQueue.add(
            "scan",
            {
                userId: null,
                source: "lidarr-webhook-external",
            },
            {
                jobId: "lidarr-external-import-scan",
                removeOnComplete: true,
                removeOnFail: true,
            }
        );
    }
}

/**
 * Handle import failure with automatic retry
 */
async function handleImportFailure(payload: any) {
    const downloadId = payload.downloadId;
    const albumMbid =
        payload.album?.foreignAlbumId || payload.albums?.[0]?.foreignAlbumId;
    const albumTitle = payload.album?.title || payload.release?.title;
    const reason = payload.message || "Import failed";

    logger.debug(`   Album: ${albumTitle}`);
    logger.debug(`   Download ID: ${downloadId}`);
    logger.debug(`   Reason: ${reason}`);

    if (!downloadId) {
        logger.debug(`   Missing downloadId, skipping`);
        return;
    }

    // Handle failure through download manager (handles retry logic)
    await simpleDownloadManager.onImportFailed(downloadId, reason, albumMbid);
}

export default router;
