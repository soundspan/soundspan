import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";
import { EnvFileSyncSkippedError, writeEnvFile } from "../utils/envWriter";
import { invalidateSystemSettingsCache } from "../utils/systemSettings";
import { schedulerQueue } from "../workers/queues";
import { encrypt, decrypt } from "../utils/encryption";
import { ENCRYPTED_SETTINGS_COLUMNS } from "../utils/encryptedColumns";
import { BRAND_NAME, BRAND_SLUG } from "../config/brand";
import { normalizeSafeOutboundUrl } from "../services/outboundUrlSafety";
import { sendInternalRouteError, sendRouteError } from "./routeErrorResponse";
import { config } from "../config";

const router = Router();
const WEBHOOK_NAME_ALIASES = [BRAND_NAME];
const WEBHOOK_URL_ALIASES = [BRAND_SLUG];
const QUEUE_CLEANER_JOB_NAME = "download-reconciliation-cycle";
const QUEUE_CLEANER_JOB_ID = "scheduler:reconciliation:on-demand";
const queueCleanerLog = logger.child("SystemSettingsQueueCleaner");
// Shared validation message for admin outbound connection-test URLs.
const ADMIN_TEST_URL_ERROR = "URL must be a valid public HTTP(S) URL";

type QueueCleanerWorkerStatus = {
    running: boolean;
    queued: boolean;
    state: string;
    jobId: string | null;
    workerOwned: true;
};

function idleQueueCleanerWorkerStatus(): QueueCleanerWorkerStatus {
    return {
        running: false,
        queued: false,
        state: "idle",
        jobId: null,
        workerOwned: true,
    };
}

async function getQueueCleanerWorkerStatus(
    job: Awaited<ReturnType<typeof schedulerQueue.getJob>>,
): Promise<QueueCleanerWorkerStatus> {
    if (!job) return idleQueueCleanerWorkerStatus();

    const state = await job.getState();
    return {
        running: state === "active",
        queued: ["waiting", "delayed", "paused"].includes(state),
        state,
        jobId: String(job.id),
        workerOwned: true,
    };
}

async function enqueueQueueCleanerWorkerJob() {
    return schedulerQueue.add(
        QUEUE_CLEANER_JOB_NAME,
        { mode: "repeat", source: "system-settings" },
        {
            jobId: QUEUE_CLEANER_JOB_ID,
            removeOnComplete: true,
            removeOnFail: 10,
        },
    );
}

async function cancelQueuedQueueCleanerWorkerJob(): Promise<
    "absent" | "active" | "cancelled"
> {
    const job = await schedulerQueue.getJob(QUEUE_CLEANER_JOB_ID);
    if (!job) return "absent";

    const status = await getQueueCleanerWorkerStatus(job);
    if (status.running) return "active";

    await job.remove();
    return "cancelled";
}

function normalizeAdminTestUrl(url: string): string | null {
    // Deliberately the STRING check only (no DNS resolution): admin connection
    // tests legitimately target Docker-network and LAN hostnames
    // (http://lidarr:8686 resolves to 172.16/12 in the documented compose
    // deployment), the endpoints are admin-only, and an admin probing their own
    // integrations is not the SSRF vector the DNS-resolving guard exists for.
    const normalizedUrl = normalizeSafeOutboundUrl(url);

    return normalizedUrl ? normalizedUrl.replace(/\/+$/, "") : null;
}

/**
 * Safely decrypt a field, returning null if decryption fails
 */
function safeDecrypt(value: string | null): string | null {
    if (!value) return null;
    try {
        return decrypt(value);
    } catch (error) {
        logger.warn("[Settings Route] Failed to decrypt field, returning null");
        return null;
    }
}

// Only admins can access system settings
router.use(requireAuth);
router.use(requireAdmin);

const systemSettingsSchema = z.object({
    // Download Services
    lidarrEnabled: z.boolean().optional(),
    lidarrUrl: z.string().url().optional().or(z.literal("")),
    lidarrApiKey: z.string().nullable().optional(),
    lidarrWebhookSecret: z.string().nullable().optional(),

    // AI Services
    openaiEnabled: z.boolean().optional(),
    openaiApiKey: z.string().nullable().optional(),
    openaiModel: z.string().optional(),
    openaiBaseUrl: z.string().nullable().optional(),

    fanartEnabled: z.boolean().optional(),
    fanartApiKey: z.string().nullable().optional(),

    lastfmApiKey: z.string().nullable().optional(),

    // Media Services
    audiobookshelfEnabled: z.boolean().optional(),
    audiobookshelfUrl: z.string().url().optional().or(z.literal("")),
    audiobookshelfApiKey: z.string().nullable().optional(),

    // Soulseek (direct connection via slsk-client)
    soulseekUsername: z.string().nullable().optional(),
    soulseekPassword: z.string().nullable().optional(),

    // Storage Paths
    musicPath: z.string().optional(),
    downloadPath: z.string().optional(),

    // Feature Flags
    autoSync: z.boolean().optional(),
    autoEnrichMetadata: z.boolean().optional(),
    libraryDeletionEnabled: z.boolean().optional(),

    // Advanced Settings
    maxConcurrentDownloads: z.number().optional(),
    downloadRetryAttempts: z.number().optional(),
    transcodeCacheMaxGb: z.number().optional(),
    soulseekConcurrentDownloads: z.number().min(1).max(10).optional(),

    // Download Preferences
    downloadSource: z.enum(["soulseek", "lidarr", "tidal"]).optional(),
    primaryFailureFallback: z
        .enum(["none", "lidarr", "soulseek", "tidal"])
        .optional(),

    // TIDAL — credential fields (tidalAccessToken, tidalRefreshToken,
    // tidalUserId) are deliberately absent: they are managed exclusively
    // by the /tidal-auth device flow. Accepting them here let a stale
    // settings form round-trip wipe the admin download connection.
    tidalEnabled: z.boolean().optional(),
    tidalCountryCode: z.string().nullable().optional(),
    tidalQuality: z
        .enum(["LOW", "HIGH", "LOSSLESS", "HI_RES_LOSSLESS"])
        .optional(),
    tidalFileTemplate: z.string().nullable().optional(),

    // YouTube Music streaming
    ytMusicEnabled: z.boolean().optional(),
    ytMusicClientId: z.string().nullable().optional(),
    ytMusicClientSecret: z.string().nullable().optional(),

    // UI
    showVersion: z.boolean().optional(),
});

type SystemSettingsUpdate = z.infer<typeof systemSettingsSchema>;
type SystemSettingsSecret =
    (typeof ENCRYPTED_SETTINGS_COLUMNS.systemSettings)[number];
type EffectiveSecret = (field: SystemSettingsSecret) => string | null;

function buildEnvironmentUpdate(
    data: SystemSettingsUpdate,
    effectiveSecret: EffectiveSecret,
): Record<string, string | null | undefined> {
    const isSupplied = (field: keyof SystemSettingsUpdate): boolean =>
        Object.prototype.hasOwnProperty.call(data, field) &&
        data[field] !== undefined;

    return {
        LIDARR_ENABLED: isSupplied("lidarrEnabled")
            ? data.lidarrEnabled
                ? "true"
                : "false"
            : undefined,
        LIDARR_URL: isSupplied("lidarrUrl")
            ? data.lidarrUrl || null
            : undefined,
        LIDARR_API_KEY: isSupplied("lidarrApiKey")
            ? effectiveSecret("lidarrApiKey")
            : undefined,
        FANART_API_KEY: isSupplied("fanartApiKey")
            ? effectiveSecret("fanartApiKey")
            : undefined,
        OPENAI_API_KEY: isSupplied("openaiApiKey")
            ? effectiveSecret("openaiApiKey")
            : undefined,
        AUDIOBOOKSHELF_URL: isSupplied("audiobookshelfUrl")
            ? data.audiobookshelfUrl || null
            : undefined,
        AUDIOBOOKSHELF_API_KEY: isSupplied("audiobookshelfApiKey")
            ? effectiveSecret("audiobookshelfApiKey")
            : undefined,
    };
}

/**
 * @openapi
 * /api/system-settings:
 *   get:
 *     summary: Get all system settings
 *     tags: [System Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: >
 *           System settings object with decrypted sensitive fields.
 *           TIDAL token material is never included; the boolean
 *           `tidalConnected` reports whether the admin download
 *           connection is established.
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
// GET /system-settings
router.get("/", async (req, res) => {
    try {
        let settings = await prisma.systemSettings.findUnique({
            where: { id: "default" },
        });

        // Create default settings if they don't exist
        if (!settings) {
            settings = await prisma.systemSettings.create({
                data: {
                    id: "default",
                    lidarrEnabled: false,
                    lidarrUrl: "http://localhost:8686",
                    openaiEnabled: false,
                    openaiModel: "gpt-4",
                    fanartEnabled: false,
                    audiobookshelfEnabled: false,
                    audiobookshelfUrl: "http://localhost:13378",
                    musicPath: "/music",
                    downloadPath: "/downloads",
                    autoSync: true,
                    autoEnrichMetadata: true,
                    libraryDeletionEnabled: false,
                    maxConcurrentDownloads: 3,
                    downloadRetryAttempts: 3,
                    transcodeCacheMaxGb: 10,
                },
            });
        }

        // Decrypt sensitive fields before sending to client
        // Use safeDecrypt to handle corrupted encrypted values gracefully.
        // TIDAL tokens are never sent to the client — only a connection
        // flag; the tokens live solely server-side (see /tidal-auth flow).
        const {
            tidalAccessToken: storedTidalAccessToken,
            tidalRefreshToken: storedTidalRefreshToken,
            spotifyClientId: _storedSpotifyClientId,
            spotifyClientSecret: _storedSpotifyClientSecret,
            ...clientSafeSettings
        } = settings;
        const decryptedSettings = {
            ...clientSafeSettings,
            lidarrApiKey: safeDecrypt(settings.lidarrApiKey),
            lidarrWebhookSecret: safeDecrypt(settings.lidarrWebhookSecret),
            openaiApiKey: safeDecrypt(settings.openaiApiKey),
            fanartApiKey: safeDecrypt(settings.fanartApiKey),
            lastfmApiKey: safeDecrypt(settings.lastfmApiKey),
            audiobookshelfApiKey: safeDecrypt(settings.audiobookshelfApiKey),
            soulseekPassword: safeDecrypt(settings.soulseekPassword),
            ytMusicClientSecret: safeDecrypt(settings.ytMusicClientSecret),
            tidalConnected: !!(
                storedTidalAccessToken && storedTidalRefreshToken
            ),
        };

        res.json(decryptedSettings);
    } catch (error) {
        logger.error("Get system settings error:", error);
        sendInternalRouteError(res, "Failed to get system settings");
    }
});

/**
 * @openapi
 * /api/system-settings:
 *   post:
 *     summary: Update system settings
 *     tags: [System Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: >
 *               Partial system settings to update (Lidarr, OpenAI, Fanart,
 *               Last.fm, Audiobookshelf, Soulseek, TIDAL, paths,
 *               feature flags, etc.). Secret fields (API keys, passwords,
 *               client secrets) are write-only with explicit semantics:
 *               a non-empty string replaces the stored secret, an empty
 *               string leaves it unchanged (a form round-trip can never
 *               wipe a credential), and null explicitly clears it. TIDAL
 *               credential fields (tidalAccessToken, tidalRefreshToken,
 *               tidalUserId) are ignored entirely — the admin TIDAL
 *               connection is managed only via the /tidal-auth endpoints.
 *     responses:
 *       200:
 *         description: Settings saved successfully
 *       400:
 *         description: Invalid settings payload
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
// POST /system-settings
router.post("/", async (req, res) => {
    try {
        const data = systemSettingsSchema.parse(req.body);

        logger.debug("[SYSTEM SETTINGS] Saving settings...");
        logger.debug(
            "[SYSTEM SETTINGS] transcodeCacheMaxGb:",
            data.transcodeCacheMaxGb,
        );

        // Encrypt sensitive fields. Secret semantics: non-empty string →
        // encrypt and store; empty string → no change (the settings form
        // round-trips every field, so "" must never overwrite a stored
        // secret); null → explicit clear. Driven by the canonical
        // encrypted-columns list so new secrets can't miss the guard.
        const encryptedData: any = { ...data };

        for (const field of ENCRYPTED_SETTINGS_COLUMNS.systemSettings) {
            const value = (data as Record<string, unknown>)[field];
            if (value === undefined) continue;
            if (value === null) {
                encryptedData[field] = null;
            } else if (value === "") {
                delete encryptedData[field];
            } else {
                encryptedData[field] = encrypt(value as string);
            }
        }

        const settings = await prisma.systemSettings.upsert({
            where: { id: "default" },
            create: {
                id: "default",
                ...encryptedData,
            },
            update: encryptedData,
        });

        invalidateSystemSettingsCache();

        // Effective plaintext secret after the no-change/clear semantics
        // above: a non-empty submitted value wins, an empty string falls
        // back to the (persisted) stored value, null means cleared. Every
        // post-save consumer (.env sync, webhook auto-config) must use
        // this instead of raw payload values, or "" would leak back in
        // as a wipe.
        const effectiveSecret = (
            field: (typeof ENCRYPTED_SETTINGS_COLUMNS.systemSettings)[number],
        ): string | null => {
            const submitted = (data as Record<string, unknown>)[field];
            if (typeof submitted === "string" && submitted !== "")
                return submitted;
            if (submitted === null) return null;
            return safeDecrypt(
                ((settings as Record<string, unknown>)[field] as
                    | string
                    | null) ?? null,
            );
        };

        // Re-read the Last.fm API key from settings (runs on every save —
        // the service reloads its key unconditionally, cheap no-op if same)
        try {
            const { lastFmService } = await import("../services/lastfm");
            await lastFmService.refreshApiKey();
        } catch (err) {
            logger.warn("Failed to refresh Last.fm API key:", err);
        }

        // Disconnect Soulseek if credentials changed. An empty-string
        // password is a no-change round-trip (see the secret semantics
        // above), so it must not bounce the connection; null (explicit
        // clear) and non-empty values are real credential changes.
        if (
            data.soulseekUsername !== undefined ||
            (data.soulseekPassword !== undefined &&
                data.soulseekPassword !== "")
        ) {
            try {
                const { soulseekService } =
                    await import("../services/soulseek");
                soulseekService.disconnect();
                logger.debug(
                    "[SYSTEM SETTINGS] Disconnected Soulseek service due to credential update",
                );
            } catch (err) {
                logger.warn("Failed to disconnect Soulseek service:", err);
            }
        }

        // If Audiobookshelf was disabled, clear all audiobook-related data
        if (data.audiobookshelfEnabled === false) {
            logger.debug(
                "[CLEANUP] Audiobookshelf disabled - clearing all audiobook data from database",
            );
            try {
                const deletedProgress =
                    await prisma.audiobookProgress.deleteMany({});
                logger.debug(
                    `   Deleted ${deletedProgress.count} audiobook progress entries`,
                );
            } catch (clearError) {
                logger.error("Failed to clear audiobook data:", clearError);
                // Don't fail the request
            }
        }

        // Write to .env file for Docker containers
        try {
            await writeEnvFile(buildEnvironmentUpdate(data, effectiveSecret));
            logger.debug(".env file synchronized with database settings");
        } catch (envError) {
            if (envError instanceof EnvFileSyncSkippedError) {
                logger.debug(`.env sync skipped: ${envError.message}`);
            } else {
                logger.error("Failed to write .env file:", envError);
            }
            // Don't fail the request if .env write fails
        }

        // Auto-configure Lidarr webhook if Lidarr is enabled
        const effectiveLidarrApiKey = effectiveSecret("lidarrApiKey");
        if (data.lidarrEnabled && data.lidarrUrl && effectiveLidarrApiKey) {
            try {
                logger.debug("[LIDARR] Auto-configuring webhook...");

                const axios = (await import("axios")).default;
                const lidarrUrl = data.lidarrUrl;
                const apiKey = effectiveLidarrApiKey;

                // In Docker, services communicate via service/network names.
                const callbackHost = config.soundspanCallbackUrl;
                const webhookUrl = `${callbackHost}/api/webhooks/lidarr`;

                logger.debug(`   Webhook URL: ${webhookUrl}`);

                // Check if webhook already exists by compatible name or URL patterns.
                const notificationsResponse = await axios.get(
                    `${lidarrUrl}/api/v1/notification`,
                    {
                        headers: { "X-Api-Key": apiKey },
                        timeout: 10000,
                    },
                );

                // Match current webhook names and URL aliases.
                const existingWebhook = notificationsResponse.data.find(
                    (n: any) => {
                        if (n.implementation !== "Webhook") {
                            return false;
                        }

                        const nameMatch = WEBHOOK_NAME_ALIASES.some(
                            (candidate) =>
                                typeof n.name === "string" &&
                                n.name.toLowerCase() ===
                                    candidate.toLowerCase(),
                        );

                        const urlValue = n.fields?.find(
                            (f: any) => f.name === "url",
                        )?.value;
                        const urlMatch =
                            typeof urlValue === "string" &&
                            (urlValue.includes("webhooks/lidarr") ||
                                WEBHOOK_URL_ALIASES.some((alias) =>
                                    urlValue.includes(alias),
                                ));

                        return nameMatch || urlMatch;
                    },
                );

                if (existingWebhook) {
                    const currentUrl = existingWebhook.fields?.find(
                        (f: any) => f.name === "url",
                    )?.value;
                    logger.debug(
                        `   Found existing webhook: "${existingWebhook.name}" with URL: ${currentUrl}`,
                    );
                    if (currentUrl !== webhookUrl) {
                        logger.debug(
                            `   URL needs updating from: ${currentUrl}`,
                        );
                        logger.debug(
                            `   URL will be updated to: ${webhookUrl}`,
                        );
                    }
                }

                const webhookConfig = {
                    onGrab: true,
                    onReleaseImport: true,
                    onAlbumDownload: true,
                    onDownloadFailure: true,
                    onImportFailure: true,
                    onAlbumDelete: true,
                    onRename: true,
                    onHealthIssue: false,
                    onApplicationUpdate: false,
                    supportsOnGrab: true,
                    supportsOnReleaseImport: true,
                    supportsOnAlbumDownload: true,
                    supportsOnDownloadFailure: true,
                    supportsOnImportFailure: true,
                    supportsOnAlbumDelete: true,
                    supportsOnRename: true,
                    supportsOnHealthIssue: true,
                    supportsOnApplicationUpdate: true,
                    includeHealthWarnings: false,
                    name: BRAND_NAME,
                    implementation: "Webhook",
                    implementationName: "Webhook",
                    configContract: "WebhookSettings",
                    infoLink:
                        "https://wiki.servarr.com/lidarr/supported#webhook",
                    tags: [],
                    fields: [
                        { name: "url", value: webhookUrl },
                        { name: "method", value: 1 }, // 1 = POST
                        { name: "username", value: "" },
                        { name: "password", value: "" },
                    ],
                };

                if (existingWebhook) {
                    // Update existing webhook
                    await axios.put(
                        `${lidarrUrl}/api/v1/notification/${existingWebhook.id}?forceSave=true`,
                        { ...existingWebhook, ...webhookConfig },
                        {
                            headers: { "X-Api-Key": apiKey },
                            timeout: 10000,
                        },
                    );
                    logger.debug("   Webhook updated");
                } else {
                    // Create new webhook (use forceSave to skip test)
                    await axios.post(
                        `${lidarrUrl}/api/v1/notification?forceSave=true`,
                        webhookConfig,
                        {
                            headers: { "X-Api-Key": apiKey },
                            timeout: 10000,
                        },
                    );
                    logger.debug("   Webhook created");
                }

                logger.debug("Lidarr webhook configured automatically\n");
            } catch (webhookError: any) {
                logger.error(
                    "Failed to auto-configure webhook:",
                    webhookError.message,
                );
                if (webhookError.response?.data) {
                    logger.error(
                        "   Lidarr error details:",
                        JSON.stringify(webhookError.response.data, null, 2),
                    );
                }
                logger.debug(
                    " User can configure webhook manually in Lidarr UI\n",
                );
                // Don't fail the request if webhook config fails
            }
        }

        res.json({
            success: true,
            message:
                "Settings saved successfully. Restart Docker containers to apply changes.",
            requiresRestart: true,
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid settings", details: error.issues });
        }
        logger.error("Update system settings error:", error);
        sendInternalRouteError(res, "Failed to update system settings");
    }
});

/**
 * @openapi
 * /api/system-settings/test-lidarr:
 *   post:
 *     summary: Test Lidarr connection
 *     tags: [System Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url, apiKey]
 *             properties:
 *               url:
 *                 type: string
 *               apiKey:
 *                 type: string
 *     responses:
 *       200:
 *         description: Lidarr connection successful
 *       400:
 *         description: URL and API key are required, and URL must be a valid public HTTP(S) URL
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to connect to Lidarr
 */
// POST /system-settings/test-lidarr
router.post("/test-lidarr", async (req, res) => {
    try {
        const { url, apiKey } = req.body;

        logger.debug("[Lidarr Test] Testing connection to:", url);

        if (!url || !apiKey) {
            return res
                .status(400)
                .json({ error: "URL and API key are required" });
        }

        const normalizedUrl = normalizeAdminTestUrl(url);
        if (!normalizedUrl) {
            return res.status(400).json({ error: ADMIN_TEST_URL_ERROR });
        }

        const axios = require("axios");
        const response = await axios.get(
            `${normalizedUrl}/api/v1/system/status`,
            {
                headers: { "X-Api-Key": apiKey },
                timeout: 10000,
            },
        );

        logger.debug(
            "[Lidarr Test] Connection successful, version:",
            response.data.version,
        );

        res.json({
            success: true,
            message: "Lidarr connection successful",
            version: response.data.version,
        });
    } catch (error: any) {
        logger.error("[Lidarr Test] Error:", error.message);
        logger.error(
            "[Lidarr Test] Details:",
            error.response?.data || error.code,
        );

        let details = "Connection test failed";
        if (error.code === "ECONNREFUSED") {
            details =
                "Connection refused - check if Lidarr is running and accessible";
        } else if (error.code === "ENOTFOUND") {
            details = "Host not found - check the URL";
        } else if (error.response?.status === 401) {
            details = "Invalid API key";
        }

        res.status(500).json({
            error: "Failed to connect to Lidarr",
            details,
        });
    }
});

/**
 * @openapi
 * /api/system-settings/test-openai:
 *   post:
 *     summary: Test OpenAI connection
 *     tags: [System Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [apiKey]
 *             properties:
 *               apiKey:
 *                 type: string
 *               model:
 *                 type: string
 *     responses:
 *       200:
 *         description: OpenAI connection successful
 *       400:
 *         description: API key is required
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to connect to OpenAI
 */
// POST /system-settings/test-openai
router.post("/test-openai", async (req, res) => {
    try {
        const { apiKey, model } = req.body;

        if (!apiKey) {
            return sendRouteError(res, 400, "API key is required");
        }

        const axios = require("axios");
        const response = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: model || "gpt-3.5-turbo",
                messages: [{ role: "user", content: "Test" }],
                max_tokens: 5,
            },
            {
                headers: { Authorization: `Bearer ${apiKey}` },
                timeout: 10000,
            },
        );

        res.json({
            success: true,
            message: "OpenAI connection successful",
            model: response.data.model,
        });
    } catch (error: any) {
        logger.error("OpenAI test error:", error.message);
        res.status(500).json({
            error: "Failed to connect to OpenAI",
        });
    }
});

/**
 * @openapi
 * /api/system-settings/test-fanart:
 *   post:
 *     summary: Test Fanart.tv connection
 *     tags: [System Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fanartApiKey]
 *             properties:
 *               fanartApiKey:
 *                 type: string
 *     responses:
 *       200:
 *         description: Fanart.tv connection successful
 *       400:
 *         description: API key is required
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to connect to Fanart.tv
 *       502:
 *         description: Invalid Fanart.tv API key
 */
// Test Fanart.tv connection
router.post("/test-fanart", async (req, res) => {
    try {
        const { fanartApiKey } = req.body;

        if (!fanartApiKey) {
            return sendRouteError(res, 400, "API key is required");
        }

        const axios = require("axios");

        // Test with a known artist (The Beatles MBID)
        const testMbid = "b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d";

        const response = await axios.get(
            `https://webservice.fanart.tv/v3/music/${testMbid}`,
            {
                params: { api_key: fanartApiKey },
                timeout: 5000,
            },
        );

        // If we get here, the API key is valid
        res.json({
            success: true,
            message: "Fanart.tv connection successful",
        });
    } catch (error: any) {
        logger.error("Fanart.tv test error:", error.message);
        if (error.response?.status === 401) {
            res.status(502).json({
                error: "Invalid Fanart.tv API key",
            });
        } else {
            res.status(500).json({
                error: "Failed to connect to Fanart.tv",
            });
        }
    }
});

/**
 * @openapi
 * /api/system-settings/test-lastfm:
 *   post:
 *     summary: Test Last.fm connection
 *     tags: [System Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [lastfmApiKey]
 *             properties:
 *               lastfmApiKey:
 *                 type: string
 *     responses:
 *       200:
 *         description: Last.fm connection successful
 *       400:
 *         description: API key is required
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to connect to Last.fm
 *       502:
 *         description: Invalid Last.fm API key
 */
// Test Last.fm connection
router.post("/test-lastfm", async (req, res) => {
    try {
        const { lastfmApiKey } = req.body;

        if (!lastfmApiKey) {
            return sendRouteError(res, 400, "API key is required");
        }

        const axios = require("axios");

        // Test with a known artist (The Beatles)
        const testArtist = "The Beatles";

        const response = await axios.get("http://ws.audioscrobbler.com/2.0/", {
            params: {
                method: "artist.getinfo",
                artist: testArtist,
                api_key: lastfmApiKey,
                format: "json",
            },
            timeout: 5000,
        });

        // If we get here and have artist data, the API key is valid
        if (response.data.artist) {
            res.json({
                success: true,
                message: "Last.fm connection successful",
            });
        } else {
            res.status(500).json({
                error: "Unexpected response from Last.fm",
            });
        }
    } catch (error: any) {
        logger.error("Last.fm test error:", error.message);
        if (
            error.response?.status === 403 ||
            error.response?.data?.error === 10
        ) {
            res.status(502).json({
                error: "Invalid Last.fm API key",
            });
        } else {
            res.status(500).json({
                error: "Failed to connect to Last.fm",
            });
        }
    }
});

/**
 * @openapi
 * /api/system-settings/test-audiobookshelf:
 *   post:
 *     summary: Test Audiobookshelf connection
 *     tags: [System Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url, apiKey]
 *             properties:
 *               url:
 *                 type: string
 *               apiKey:
 *                 type: string
 *     responses:
 *       200:
 *         description: Audiobookshelf connection successful
 *       400:
 *         description: URL and API key are required, and URL must be a valid public HTTP(S) URL
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to connect to Audiobookshelf
 *       502:
 *         description: Invalid Audiobookshelf API key
 */
// Test Audiobookshelf connection
router.post("/test-audiobookshelf", async (req, res) => {
    try {
        const { url, apiKey } = req.body;

        if (!url || !apiKey) {
            return res
                .status(400)
                .json({ error: "URL and API key are required" });
        }

        const normalizedUrl = normalizeAdminTestUrl(url);
        if (!normalizedUrl) {
            return res.status(400).json({ error: ADMIN_TEST_URL_ERROR });
        }

        const axios = require("axios");

        const response = await axios.get(`${normalizedUrl}/api/libraries`, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
            timeout: 5000,
        });

        res.json({
            success: true,
            message: "Audiobookshelf connection successful",
            libraries: response.data.libraries?.length || 0,
        });
    } catch (error: any) {
        logger.error("Audiobookshelf test error:", error.message);
        if (error.response?.status === 401 || error.response?.status === 403) {
            res.status(502).json({
                error: "Invalid Audiobookshelf API key",
            });
        } else {
            res.status(500).json({
                error: "Failed to connect to Audiobookshelf",
            });
        }
    }
});

/**
 * @openapi
 * /api/system-settings/test-soulseek:
 *   post:
 *     summary: Test Soulseek connection
 *     tags: [System Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Soulseek connection successful
 *       400:
 *         description: Username and password are required
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to test Soulseek connection
 *       502:
 *         description: Invalid Soulseek credentials or connection failed
 */
// Test Soulseek connection (direct via slsk-client)
router.post("/test-soulseek", async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                error: "Soulseek username and password are required",
            });
        }

        logger.debug(`[SOULSEEK-TEST] Testing connection as "${username}"...`);

        // Import soulseek service
        const { soulseekService } = await import("../services/soulseek");

        // Temporarily set credentials for test
        // The service will use the provided credentials
        try {
            // Try to connect with the provided credentials
            const slsk = require("slsk-client");

            await new Promise<void>((resolve, reject) => {
                slsk.connect(
                    { user: username, pass: password },
                    (err: Error | null, client: any) => {
                        if (err) {
                            logger.debug(
                                `[SOULSEEK-TEST] Connection failed: ${err.message}`,
                            );
                            return reject(err);
                        }
                        logger.debug(`[SOULSEEK-TEST] Connected successfully`);
                        // We don't need to keep the connection open for the test
                        resolve();
                    },
                );
            });

            res.json({
                success: true,
                message: `Connected to Soulseek as "${username}"`,
                soulseekUsername: username,
                isConnected: true,
            });
        } catch (connectError: any) {
            logger.error(`[SOULSEEK-TEST] Error: ${connectError.message}`);
            res.status(502).json({
                error: "Invalid Soulseek credentials or connection failed",
            });
        }
    } catch (error: any) {
        logger.error("[SOULSEEK-TEST] Error:", error.message);
        res.status(500).json({
            error: "Failed to test Soulseek connection",
        });
    }
});

/**
 * @openapi
 * /api/system-settings/test-spotify:
 *   post:
 *     summary: Test Spotify credentials
 *     tags: [System Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [clientId, clientSecret]
 *             properties:
 *               clientId:
 *                 type: string
 *               clientSecret:
 *                 type: string
 *     responses:
 *       200:
 *         description: Spotify credentials are valid
 *       400:
 *         description: Client ID and Client Secret are required
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to test Spotify credentials
 *       502:
 *         description: Invalid Spotify credentials
 */
// Test Spotify credentials
router.post("/test-spotify", async (req, res) => {
    try {
        const { clientId, clientSecret } = req.body;

        if (!clientId || !clientSecret) {
            return res.status(400).json({
                error: "Client ID and Client Secret are required",
            });
        }

        // Test credentials by trying to get an access token
        const axios = require("axios");
        try {
            const response = await axios.post(
                "https://accounts.spotify.com/api/token",
                "grant_type=client_credentials",
                {
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        Authorization: `Basic ${Buffer.from(
                            `${clientId}:${clientSecret}`,
                        ).toString("base64")}`,
                    },
                    timeout: 10000,
                },
            );

            if (response.data.access_token) {
                res.json({
                    success: true,
                    message: "Spotify credentials are valid",
                });
            } else {
                res.status(502).json({
                    error: "Invalid Spotify credentials",
                });
            }
        } catch (tokenError: any) {
            res.status(502).json({
                error: "Invalid Spotify credentials",
            });
        }
    } catch (error: any) {
        logger.error("Spotify test error:", error.message);
        res.status(500).json({
            error: "Failed to test Spotify credentials",
        });
    }
});

/**
 * @openapi
 * /api/system-settings/test-tidal:
 *   post:
 *     summary: Test TIDAL connection or verify existing session
 *     tags: [System Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: TIDAL session is valid
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       502:
 *         description: No valid TIDAL session
 *       503:
 *         description: TIDAL service is not running
 */
// Test TIDAL connection — initiate device auth or verify existing session
router.post("/test-tidal", async (req, res) => {
    try {
        const { tidalService } = await import("../services/tidal");

        // First check if the sidecar is reachable
        const healthy = await tidalService.isSidecarHealthy();
        if (!healthy) {
            return res.status(503).json({
                error: "TIDAL service is not running",
                details:
                    "The tidal-downloader container is not reachable. Make sure it is running.",
            });
        }

        // Try to verify existing session
        const session = await tidalService.verifySession();
        if (session.valid) {
            return res.json({
                success: true,
                message: `Connected to TIDAL (user: ${session.userId})`,
            });
        }

        // No valid session — return info so the UI can trigger device auth
        return res.status(502).json({
            error: "Not authenticated to TIDAL",
            details:
                "Use the TIDAL settings panel to authenticate via device authorization.",
        });
    } catch (error: any) {
        logger.error("[TIDAL-TEST] Error:", error.message);
        res.status(500).json({
            error: "Failed to test TIDAL connection",
        });
    }
});

/**
 * @openapi
 * /api/system-settings/tidal-auth/device:
 *   post:
 *     summary: Initiate TIDAL device authorization (step 1)
 *     tags: [System Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Device authorization initiated, returns device code and verification URL
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       503:
 *         description: TIDAL service is not running
 */
// TIDAL device auth — Step 1: get device code
router.post("/tidal-auth/device", async (req, res) => {
    try {
        const { tidalService } = await import("../services/tidal");

        const healthy = await tidalService.isSidecarHealthy();
        if (!healthy) {
            return res.status(503).json({
                error: "TIDAL service is not running",
            });
        }

        const deviceAuth = await tidalService.initiateDeviceAuth();
        res.json(deviceAuth);
    } catch (error: any) {
        logger.error("[TIDAL-AUTH] Device auth error:", error.message);
        res.status(500).json({ error: "Failed to initiate TIDAL auth" });
    }
});

/**
 * @openapi
 * /api/system-settings/tidal-auth/token:
 *   post:
 *     summary: Poll for TIDAL device authorization token (step 2)
 *     tags: [System Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [device_code]
 *             properties:
 *               device_code:
 *                 type: string
 *     responses:
 *       200:
 *         description: TIDAL authentication completed successfully
 *       202:
 *         description: Authorization pending, user has not yet approved
 *       400:
 *         description: device_code is required
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to complete TIDAL auth
 */
// TIDAL device auth — Step 2: poll for token
router.post("/tidal-auth/token", async (req, res) => {
    try {
        const { device_code } = req.body;
        if (!device_code) {
            return sendRouteError(res, 400, "device_code is required");
        }

        const { tidalService } = await import("../services/tidal");
        const tokens = await tidalService.pollDeviceAuth(device_code);

        if (!tokens) {
            // User hasn't authorised yet
            return res.status(202).json({ status: "pending" });
        }

        // Save tokens to database
        await tidalService.saveTokens({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            userId: tokens.user_id,
            countryCode: tokens.country_code,
        });

        res.json({
            success: true,
            user_id: tokens.user_id,
            country_code: tokens.country_code,
            username: tokens.username,
        });
    } catch (error: any) {
        logger.error("[TIDAL-AUTH] Token exchange error:", error.message);
        res.status(500).json({ error: "Failed to complete TIDAL auth" });
    }
});

/**
 * @openapi
 * /api/system-settings/queue-cleaner-status:
 *   get:
 *     summary: Get cluster-wide queue cleaner worker-job status
 *     tags: [System Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Current queue cleaner status
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
// Get queue cleaner worker-job status from the shared scheduler queue.
router.get("/queue-cleaner-status", async (req, res) => {
    try {
        const job = await schedulerQueue.getJob(QUEUE_CLEANER_JOB_ID);
        res.json(await getQueueCleanerWorkerStatus(job));
    } catch (error) {
        queueCleanerLog.error(
            "Failed to read queue cleaner worker status",
            error,
        );
        sendInternalRouteError(res, "Failed to get queue cleaner status");
    }
});

/**
 * @openapi
 * /api/system-settings/queue-cleaner/start:
 *   post:
 *     summary: Enqueue a claimed queue cleaner worker job
 *     tags: [System Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Queue cleaner worker job enqueued
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to start queue cleaner
 */
// Request one coalesced reconciliation cycle from the worker scheduler.
router.post("/queue-cleaner/start", async (req, res) => {
    try {
        const job = await enqueueQueueCleanerWorkerJob();
        res.json({
            success: true,
            message: "Queue cleaner job enqueued",
            status: await getQueueCleanerWorkerStatus(job),
        });
    } catch (error) {
        queueCleanerLog.error(
            "Failed to enqueue queue cleaner worker job",
            error,
        );
        sendInternalRouteError(res, "Failed to start queue cleaner");
    }
});

/**
 * @openapi
 * /api/system-settings/queue-cleaner/stop:
 *   post:
 *     summary: Cancel a queued queue cleaner worker job
 *     tags: [System Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Queued queue cleaner worker job cancelled or absent
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       409:
 *         description: Queue cleaner job is already active
 *       500:
 *         description: Failed to stop queue cleaner
 */
// Cancel a pending cluster-wide request; claimed active work is not interruptible.
router.post("/queue-cleaner/stop", async (req, res) => {
    try {
        const result = await cancelQueuedQueueCleanerWorkerJob();
        if (result === "active") {
            return sendRouteError(
                res,
                409,
                "Queue cleaner job is already active",
            );
        }

        return res.json({
            success: true,
            message:
                result === "cancelled"
                    ? "Queued queue cleaner job cancelled"
                    : "No queued queue cleaner job",
            status: idleQueueCleanerWorkerStatus(),
        });
    } catch (error) {
        queueCleanerLog.error(
            "Failed to cancel queued queue cleaner worker job",
            error,
        );
        return sendInternalRouteError(res, "Failed to stop queue cleaner");
    }
});

/**
 * @openapi
 * /api/system-settings/clear-caches:
 *   post:
 *     summary: Clear all Redis caches (excluding sessions)
 *     tags: [System Settings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Caches cleared successfully
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to clear caches
 */
// Clear all Redis caches
router.post("/clear-caches", async (req, res) => {
    try {
        const { redisClient } = require("../utils/redis");
        const { notificationService } =
            await import("../services/notificationService");

        // Get all keys but exclude session keys
        const allKeys = await redisClient.keys("*");
        const keysToDelete = allKeys.filter(
            (key: string) => !key.startsWith("sess:"),
        );

        if (keysToDelete.length > 0) {
            logger.debug(
                `[CACHE] Clearing ${
                    keysToDelete.length
                } cache entries (excluding ${
                    allKeys.length - keysToDelete.length
                } session keys)...`,
            );
            for (const key of keysToDelete) {
                await redisClient.del(key);
            }
            logger.debug(
                `[CACHE] Successfully cleared ${keysToDelete.length} cache entries`,
            );

            // Send notification to user
            await notificationService.notifySystem(
                req.user!.id,
                "Caches Cleared",
                `Successfully cleared ${keysToDelete.length} cache entries`,
            );

            res.json({
                success: true,
                message: `Cleared ${keysToDelete.length} cache entries`,
                clearedKeys: keysToDelete.length,
            });
        } else {
            await notificationService.notifySystem(
                req.user!.id,
                "Caches Cleared",
                "No cache entries to clear",
            );

            res.json({
                success: true,
                message: "No cache entries to clear",
                clearedKeys: 0,
            });
        }
    } catch (error: any) {
        logger.error("Clear caches error:", error);
        res.status(500).json({
            error: "Failed to clear caches",
        });
    }
});

export default router;
