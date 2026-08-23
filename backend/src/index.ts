import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { config } from "./config";
import { redisClient } from "./utils/redis";
import { prisma } from "./utils/db";
import { logger } from "./utils/logger";
import { isOriginAllowed } from "./utils/cors";
import {
    getRuntimeDrainState,
    setRuntimeDrainState,
} from "./utils/runtimeLifecycle";

// BigInt values from Prisma (e.g. Audiobook.size) must be serialisable to JSON.
// Without this polyfill, JSON.stringify throws "Do not know how to serialize a BigInt".
(BigInt.prototype as any).toJSON = function () {
    return Number(this);
};

import authRoutes from "./routes/auth";
import onboardingRoutes from "./routes/onboarding";
import libraryRoutes from "./routes/library";
import playsRoutes from "./routes/plays";
import settingsRoutes from "./routes/settings";
import socialRoutes from "./routes/social";
import systemSettingsRoutes from "./routes/systemSettings";
import listeningStateRoutes from "./routes/listeningState";
import playbackStateRoutes from "./routes/playbackState";
import offlineRoutes from "./routes/offline";
import playlistsRoutes from "./routes/playlists";
import shareLinkRoutes from "./routes/shareLinks";
import searchRoutes from "./routes/search";
import downloadsRoutes from "./routes/downloads";
import webhooksRoutes from "./routes/webhooks";
import audiobooksRoutes from "./routes/audiobooks";
import podcastsRoutes from "./routes/podcasts";
import artistsRoutes from "./routes/artists";
import soulseekRoutes from "./routes/soulseek";
import apiKeysRoutes from "./routes/apiKeys";
import enrichmentRoutes from "./routes/enrichment";
import metadataRoutes from "./routes/metadata";
import homepageRoutes from "./routes/homepage";
import deviceLinkRoutes from "./routes/deviceLink";
import notificationsRoutes from "./routes/notifications";
import browseRoutes from "./routes/browse";
import adminRoutes from "./routes/admin";
import libraryHealthDashboardRoutes from "./routes/libraryHealthDashboard";
import releasesRoutes from "./routes/releases";
import systemRoutes from "./routes/system";
import ytMusicRoutes from "./routes/youtubeMusic";
import youtubeRoutes from "./routes/youtube";
import tidalStreamingRoutes from "./routes/tidalStreaming";
import trackMappingsRoutes from "./routes/trackMappings";
import playlistImportRoutes from "./routes/playlistImport";
import streamingRoutes from "./routes/streaming";
import lyricsRoutes from "./routes/lyrics";
import listenTogetherRoutes from "./routes/listenTogether";
import subsonicRoutes from "./routes/subsonic";
import {
    setupListenTogetherSocket,
    stopListenTogetherSocketIntake,
    shutdownListenTogetherSocket,
} from "./services/listenTogetherSocket";
import {
    startPersistLoop,
    stopPersistLoop,
    persistAllGroups,
} from "./services/listenTogether";
import { createServer } from "http";
import type { Socket } from "net";
import { errorHandler } from "./middleware/errorHandler";
import { createFeatureDisabledHandler } from "./utils/featureGate";
import { requireAuth, requireAdmin } from "./middleware/auth";
import { createDependencyReadinessTracker } from "./utils/dependencyReadiness";
import { isSecretsDbOnlyEnabled } from "./config/secretsPolicy";
import {
    authLimiter,
    refreshLimiter,
    adminSurfaceLimiter,
    apiLimiter,
    lyricsLimiter,
    shareLinkLimiter,
} from "./middleware/rateLimiter";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./config/swagger";
import { BRAND_API_DOCS_TITLE, BRAND_NAME } from "./config/brand";
import {
    httpMetricsMiddleware,
    initializeFederationMetrics,
    metricsRegistry,
} from "./metrics";
import { createMetricsRouter } from "./metrics/endpoint";
import { registerQueueMetrics } from "./metrics/queueMetrics";
import { backfillFederationOutboundTokens } from "./services/federationCredentials";
import { warnIfLegacyDiscoveryMode } from "./utils/legacyDiscoveryDeprecation";

const app = express();

// Express 5 changed the default query parser from "extended" to "simple".
// Restore "extended" (qs) so nested/bracketed query strings keep parsing the
// way they did on Express 4 (and to match the ParsedQs typing of req.query).
app.set("query parser", "extended");

type BackendProcessRole = "all" | "api" | "worker";

function isCompressionExcludedPath(path: string): boolean {
    if (!path) return false;

    return (
        (path.startsWith("/api/library/tracks/") && path.endsWith("/stream")) ||
        (path.startsWith("/api/audiobooks/") &&
            (path.endsWith("/stream") || path.endsWith("/cover"))) ||
        (path.startsWith("/api/podcasts/") && path.includes("/stream")) ||
        path.startsWith("/api/library/cover-art/") ||
        path.startsWith("/api/library/image/") ||
        path.startsWith("/api/federation/v1/stream/") ||
        path.startsWith("/api/federation/v1/cover/") ||
        path.startsWith("/rest/stream") ||
        path.startsWith("/rest/download")
    );
}

function resolveBackendProcessRole(): BackendProcessRole {
    const raw = (process.env.BACKEND_PROCESS_ROLE || "all")
        .trim()
        .toLowerCase();
    if (raw === "all" || raw === "api" || raw === "worker") {
        return raw;
    }

    logger.warn(
        `[Startup] Invalid BACKEND_PROCESS_ROLE="${process.env.BACKEND_PROCESS_ROLE}", defaulting to "all"`,
    );
    return "all";
}

const backendProcessRole = resolveBackendProcessRole();
const runApiRole = backendProcessRole === "all" || backendProcessRole === "api";
const runWorkerRole =
    backendProcessRole === "all" || backendProcessRole === "worker";
let workersInitialized = false;
let isStartupComplete = false;
const dependencyReadiness = createDependencyReadinessTracker("api");
const HTTP_SERVER_CLOSE_TIMEOUT_MS = 12_000;

if (backendProcessRole === "worker") {
    logger.error(
        '[Startup] BACKEND_PROCESS_ROLE="worker" is not supported by src/index.ts. Use worker entrypoint: `npx tsx src/worker.ts`.',
    );
    process.exit(1);
}

initializeFederationMetrics(backendProcessRole === "all" ? "all" : "api");

warnIfLegacyDiscoveryMode("API");

// Middleware
app.use(
    helmet({
        crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
);
app.use(
    cors({
        origin: (origin, callback) => {
            // Self-hosted default is permissive (no allowlist → allow all), but
            // when ALLOWED_ORIGINS is explicitly configured it is enforced.
            const allowed = isOriginAllowed(
                origin,
                config.allowedOrigins,
                config.nodeEnv,
            );
            if (!allowed) {
                logger.warn(
                    `[CORS] Origin ${origin} not in ALLOWED_ORIGINS allowlist; denying`,
                );
            }
            callback(null, allowed);
        },
        credentials: true,
    }),
);
app.use(
    compression({
        threshold: 1024,
        filter: (req, res) => {
            if (isCompressionExcludedPath(req.path)) {
                return false;
            }
            const cacheControl = res.getHeader("Cache-Control");
            if (
                typeof cacheControl === "string" &&
                cacheControl.includes("no-transform")
            ) {
                return false;
            }
            return compression.filter(req, res);
        },
    }),
);
app.use(express.json({ limit: "1mb" })); // Increased from 100KB default to support large queue payloads
app.use(httpMetricsMiddleware);
app.use(
    createMetricsRouter({
        registry: metricsRegistry,
        token: config.metrics.token,
        publicAccess: config.metrics.publicAccess,
    }),
);

// Express 5 leaves req.body undefined when no body parser matched (e.g. GET
// requests or non-JSON content types); Express 4's body-parser set {} instead.
// Handlers throughout the routes destructure req.body unconditionally, so
// restore the Express 4 default to keep those returning 400s instead of 500s.
app.use((req, res, next) => {
    if (req.body === undefined) {
        req.body = {};
    }
    next();
});

// When the process is draining, force connection close so clients reconnect to healthy pods quickly.
app.use((req, res, next) => {
    if (getRuntimeDrainState()) {
        res.setHeader("Connection", "close");
    }
    next();
});

// Trust proxy for reverse proxy setups (nginx, traefik, etc.). Defaults to
// trusting all hops; set TRUST_PROXY_HOPS to a numeric depth (usually 1) so a
// client can't spoof X-Forwarded-For to evade per-IP rate limits.
app.set("trust proxy", config.trustProxy);

// Routes - All API routes prefixed with /api for clear separation from frontend
// Apply rate limiting to auth routes
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/refresh", refreshLimiter);
app.use("/api/auth", authRoutes);
// Registration mints the first admin account, so it uses the strict auth limiter;
// the rest of onboarding, including the public status probe, uses the general limiter.
app.use("/api/onboarding/register", authLimiter);
app.use("/api/onboarding", apiLimiter, onboardingRoutes);

// Apply general API rate limiting to all API routes
app.use("/api/api-keys", apiLimiter, apiKeysRoutes);
// device-link/verify is an unauthenticated endpoint that mints full-privilege
// API keys, so it sits on the stricter authLimiter rather than the lenient
// general apiLimiter.
app.use("/api/device-link", authLimiter, deviceLinkRoutes);
// Library routes classify metadata, cover art, and audio into separate limiter tiers.
app.use("/api/library", libraryRoutes);
app.use("/api/plays", apiLimiter, playsRoutes);
app.use("/api/settings", apiLimiter, settingsRoutes);
app.use("/api/social", apiLimiter, socialRoutes);
app.use("/api/system-settings", adminSurfaceLimiter, systemSettingsRoutes);
app.use("/api/listening-state", apiLimiter, listeningStateRoutes);
// Playback-state routes use their dedicated high-volume limiter before auth.
app.use("/api/playback-state", playbackStateRoutes);
app.use("/api/offline", apiLimiter, offlineRoutes);
app.use("/api/playlists", apiLimiter, playlistsRoutes);
app.use("/api/share-links", shareLinkLimiter, shareLinkRoutes);
app.use("/api/search", apiLimiter, searchRoutes);
// Feature-gated routers are required lazily so disabled subsystems skip their
// module side effects entirely; disabled prefixes stay rate limited and
// return a clean 404 payload.
if (config.features.discovery) {
    app.use(
        "/api/recommendations",
        apiLimiter,
        require("./routes/recommendations").default,
    );
} else {
    app.use("/api/recommendations", apiLimiter, createFeatureDisabledHandler());
}
app.use("/api/downloads", apiLimiter, downloadsRoutes);
if (config.features.requests) {
    app.use("/api/requests", apiLimiter, require("./routes/requests").default);
} else {
    logger.info(
        "[Features] Music requests disabled (FEATURE_REQUESTS=false); /api/requests returns 404",
    );
    app.use("/api/requests", apiLimiter, createFeatureDisabledHandler());
}
app.use("/api/notifications", apiLimiter, notificationsRoutes);
app.use("/api/webhooks", webhooksRoutes); // The Lidarr POST has its own webhookLimiter; GET /lidarr/verify stays unthrottled for Lidarr's test probe
// Audiobook routes classify metadata, covers, and audio into separate limiter tiers.
app.use("/api/audiobooks", audiobooksRoutes);
app.use("/api/podcasts", apiLimiter, podcastsRoutes);
app.use("/api/artists", apiLimiter, artistsRoutes);
app.use("/api/soulseek", apiLimiter, soulseekRoutes);
if (config.features.discovery) {
    app.use("/api/discover", apiLimiter, require("./routes/discover").default);
} else {
    logger.info(
        "[Features] Discovery disabled (DISCOVERY_ENABLED=false); /api/discover and /api/recommendations return 404",
    );
    app.use("/api/discover", apiLimiter, createFeatureDisabledHandler());
}
if (config.features.autoPlaylists) {
    app.use("/api/mixes", apiLimiter, require("./routes/mixes").default);
} else {
    logger.info(
        "[Features] Auto playlists disabled (AUTO_PLAYLISTS_ENABLED=false); /api/mixes returns 404",
    );
    app.use("/api/mixes", apiLimiter, createFeatureDisabledHandler());
}
app.use("/api/enrichment", apiLimiter, enrichmentRoutes);
app.use("/api/metadata", apiLimiter, metadataRoutes);
app.use("/api/homepage", apiLimiter, homepageRoutes);
app.use("/api/browse", apiLimiter, browseRoutes);
if (config.features.federation) {
    app.use(
        "/api/federation/v1",
        apiLimiter,
        require("./routes/federation").default,
    );
    app.use(
        "/api/federation/admin",
        adminSurfaceLimiter,
        require("./routes/federationAdmin").default,
    );
} else {
    logger.info(
        "[Features] Federation disabled (FEDERATION_ENABLED=false); federation API and admin routes return 404",
    );
    app.use("/api/federation/v1", apiLimiter, createFeatureDisabledHandler());
    app.use(
        "/api/federation/admin",
        adminSurfaceLimiter,
        createFeatureDisabledHandler(),
    );
}
if (config.features.audioAnalysis) {
    app.use("/api/analysis", apiLimiter, require("./routes/analysis").default);
} else {
    logger.info(
        "[Features] Audio analysis disabled (AUDIO_ANALYSIS_ENABLED=false); /api/analysis and /api/vibe return 404",
    );
    app.use("/api/analysis", apiLimiter, createFeatureDisabledHandler());
}
app.use("/api/admin", adminSurfaceLimiter, adminRoutes);
app.use(
    "/api/library-health",
    adminSurfaceLimiter,
    libraryHealthDashboardRoutes,
);
app.use("/api/releases", apiLimiter, releasesRoutes);
if (config.features.audioAnalysis) {
    app.use("/api/vibe", apiLimiter, require("./routes/vibe").default);
} else {
    app.use("/api/vibe", apiLimiter, createFeatureDisabledHandler());
}
app.use("/api/system", apiLimiter, systemRoutes);
app.use("/api/ytmusic", apiLimiter, ytMusicRoutes);
app.use("/api/youtube", apiLimiter, youtubeRoutes);
app.use("/api/tidal-streaming", apiLimiter, tidalStreamingRoutes);
app.use("/api/track-mappings", apiLimiter, trackMappingsRoutes);
app.use("/api/import", apiLimiter, playlistImportRoutes);
app.use("/api/streaming", apiLimiter, streamingRoutes);
app.use("/api/lyrics", lyricsLimiter, lyricsRoutes);
app.use("/api/listen-together", apiLimiter, listenTogetherRoutes);
app.use(
    "/rest",
    express.urlencoded({ extended: false, limit: "1mb" }),
    subsonicRoutes,
);

function buildHealthPayload() {
    return {
        status: "ok",
        role: backendProcessRole,
        version: process.env.npm_package_version || "unknown",
        uptimeSeconds: Math.floor(process.uptime()),
        startupComplete: isStartupComplete,
        draining: getRuntimeDrainState(),
        dependencies: dependencyReadiness.getSnapshot(),
    };
}

async function isReadyForTraffic(): Promise<boolean> {
    try {
        await dependencyReadiness.probe();
        if (!isStartupComplete || getRuntimeDrainState()) {
            return false;
        }
        return dependencyReadiness.isHealthy();
    } catch (error) {
        logger.error("[Startup] readiness probe failed:", error);
        return false;
    }
}

// Legacy health endpoint (kept for backward compatibility).
app.get("/health", async (req, res) => {
    if (!(await isReadyForTraffic())) {
        return res.status(503).json(buildHealthPayload());
    }
    return res.json(buildHealthPayload());
});
app.get("/api/health", async (req, res) => {
    if (!(await isReadyForTraffic())) {
        return res.status(503).json(buildHealthPayload());
    }
    return res.json(buildHealthPayload());
});

// Dedicated liveness/readiness endpoints for K8s probes.
app.get("/health/live", (req, res) => {
    res.json(buildHealthPayload());
});
app.get("/api/health/live", (req, res) => {
    res.json(buildHealthPayload());
});
app.get("/health/ready", async (req, res) => {
    if (!(await isReadyForTraffic())) {
        return res.status(503).json(buildHealthPayload());
    }
    return res.json(buildHealthPayload());
});
app.get("/api/health/ready", async (req, res) => {
    if (!(await isReadyForTraffic())) {
        return res.status(503).json(buildHealthPayload());
    }
    return res.json(buildHealthPayload());
});

// Swagger API Documentation
// The UI itself is always accessible so HTML/CSS/JS assets load correctly.
// The raw JSON spec requires auth in production unless DOCS_PUBLIC=true.
// Actual API calls from "Try it out" are protected by each endpoint's own auth.
const specMiddleware =
    config.nodeEnv === "production" && !config.docsPublic ? [requireAuth] : [];

app.use(
    "/api/docs",
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
        customCss: ".swagger-ui .topbar { display: none }",
        customSiteTitle: BRAND_API_DOCS_TITLE,
    }),
);

// Serve raw OpenAPI spec (auth-gated in production)
app.get("/api/docs.json", ...specMiddleware, (req, res) => {
    res.json(swaggerSpec);
});

// Error handler
app.use(errorHandler);

// Health check functions
async function checkPostgresConnection() {
    try {
        await prisma.$queryRaw`SELECT 1`;
        logger.debug("✓ PostgreSQL connection verified");
    } catch (error) {
        logger.error("✗ PostgreSQL connection failed:", {
            error: error instanceof Error ? error.message : String(error),
            databaseUrl: config.databaseUrl?.replace(/:[^:@]+@/, ":***@"), // Hide password
        });
        logger.error("Unable to connect to PostgreSQL. Please ensure:");
        logger.error(
            "  1. PostgreSQL is running on the correct port (default: 5433)",
        );
        logger.error("  2. DATABASE_URL in .env is correct");
        logger.error("  3. Database credentials are valid");
        process.exit(1);
    }
}

async function checkRedisConnection() {
    const MAX_RETRIES = 10;
    const BASE_DELAY_MS = 1_000; // 1 second
    const MAX_DELAY_MS = 15_000; // 15 seconds

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Check if Redis client is actually connected
            if (!redisClient.isReady) {
                throw new Error(
                    "Redis client is not ready - connection failed or still connecting",
                );
            }

            // If connected, verify with ping
            await redisClient.ping();
            logger.debug("✓ Redis connection verified");
            return; // Success – exit the loop
        } catch (error) {
            const errorMsg =
                error instanceof Error ? error.message : String(error);

            if (attempt < MAX_RETRIES) {
                const delay = Math.min(
                    BASE_DELAY_MS * Math.pow(2, attempt - 1),
                    MAX_DELAY_MS,
                );
                logger.warn(
                    `Redis connection attempt ${attempt}/${MAX_RETRIES} failed: ${errorMsg} – retrying in ${delay}ms`,
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
            } else {
                logger.error("✗ Redis connection failed after all retries:", {
                    error: errorMsg,
                    redisUrl: config.redisUrl?.replace(/:[^:@]+@/, ":***@"),
                });
                logger.error("Unable to connect to Redis. Please ensure:");
                logger.error(
                    "  1. Redis is running on the correct port (default: 6379)",
                );
                logger.error("  2. REDIS_URL in .env is correct");
                process.exit(1);
            }
        }
    }
}

async function checkPasswordReset() {
    const resetPassword = config.adminResetPassword;
    if (!resetPassword) return;

    const bcrypt = await import("bcrypt");
    // Roles are stored lowercase.
    const adminUser = await prisma.user.findFirst({ where: { role: "admin" } });
    if (!adminUser) {
        logger.warn("[Password Reset] No admin user found");
        return;
    }

    const hashedPassword = await bcrypt.hash(resetPassword, 10);
    await prisma.user.update({
        where: { id: adminUser.id },
        data: {
            passwordHash: hashedPassword,
            tokenVersion: { increment: 1 },
            subsonicPassword: null,
        },
    });
    logger.warn(
        "[Password Reset] Admin password has been reset via ADMIN_RESET_PASSWORD env var. Remove this env var and restart.",
    );
}

const httpServer = createServer(app);
const activeHttpConnections = new Set<Socket>();

// Keep the origin open past common 60s reverse-proxy idle timeouts so the proxy
// closes first. headersTimeout must exceed keepAliveTimeout. Do not set
// server.timeout: Node's default 0 preserves backpressured or paused streams.
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 70_000;

httpServer.on("connection", (socket) => {
    socket.setKeepAlive(true, config.socketKeepAliveDelayMs);
    activeHttpConnections.add(socket);
    socket.on("close", () => {
        activeHttpConnections.delete(socket);
    });
});

// Attach Socket.IO for Listen Together
if (runApiRole) {
    setupListenTogetherSocket(httpServer);
}

httpServer.listen(config.port, "0.0.0.0", async () => {
    // Verify database connections before proceeding
    await checkPostgresConnection();
    await backfillFederationOutboundTokens().catch(() => {
        logger.error("Federation outbound token encryption backfill failed");
        process.exit(1);
    });
    await checkRedisConnection();
    if (isSecretsDbOnlyEnabled()) {
        // Lazy import keeps the entrypoint free of the settings/encryption
        // module chain unless the DB-only secrets flag is enabled.
        const { assertSecretsDbOnlyReady } =
            await import("./utils/systemSettings");
        await assertSecretsDbOnlyReady().catch((error) => {
            logger.error(String(error?.message ?? error));
            process.exit(1);
        });
    }
    await dependencyReadiness.probe(true);

    // Check for admin password reset
    await checkPasswordReset();

    logger.info(
        `[Startup] BACKEND_PROCESS_ROLE=${backendProcessRole} (api=${runApiRole}, worker=${runWorkerRole})`,
    );

    if (runApiRole) {
        // Persist Listen Together state from active API process.
        startPersistLoop();
    }

    logger.debug(
        `${BRAND_NAME} API running on port ${config.port} (accessible on all network interfaces)`,
    );

    // Enable slow query monitoring in development
    if (config.nodeEnv === "development") {
        const { enableSlowQueryMonitoring } =
            await import("./utils/queryMonitor");
        enableSlowQueryMonitoring();
    }

    // Initialize music configuration (reads from SystemSettings)
    const { initializeMusicConfig } = await import("./config");
    await initializeMusicConfig();
    if (config.features.federation) {
        const { ensureFederationIdentity } =
            await import("./services/federationPeers");
        await ensureFederationIdentity();
    }

    if (runWorkerRole) {
        // Initialize Bull queue workers
        await import("./workers");
        workersInitialized = true;

        // Note: Native library scanning is now triggered manually via POST /library/scan
        // No automatic sync on startup - user must manually scan their music folder

        // Enrichment worker enabled for OWNED content only
        // - Background enrichment: Genres, MBIDs, similar artists for owned albums/artists
        // - On-demand fetching: Artist images, bios when browsing (cached in Redis 7 days)
        logger.debug(
            "Background enrichment enabled for owned content (genres, MBIDs, etc.)",
        );
        logger.debug(
            "Startup maintenance jobs are queue-claimed (cache warmup, podcast cleanup, audiobook sync, download reconciliation, backfills)",
        );
    }

    if (runApiRole) {
        // Set up Bull Board dashboard
        const { createBullBoard } = await import("@bull-board/api");
        const { BullAdapter } = await import("@bull-board/api/bullAdapter");
        const { ExpressAdapter } = await import("@bull-board/express");
        const { scanQueue, discoverQueue, imageQueue, queues } =
            await import("./workers/queues");

        registerQueueMetrics(metricsRegistry, queues);

        const serverAdapter = new ExpressAdapter();
        serverAdapter.setBasePath("/api/admin/queues");

        createBullBoard({
            queues: [
                new BullAdapter(scanQueue),
                new BullAdapter(discoverQueue),
                new BullAdapter(imageQueue),
            ],
            serverAdapter,
        });

        app.use(
            "/api/admin/queues",
            adminSurfaceLimiter,
            requireAuth,
            requireAdmin,
            serverAdapter.getRouter(),
        );
        logger.debug(
            "Bull Board dashboard available at /api/admin/queues (admin-only)",
        );
    }

    isStartupComplete = true;
    logger.debug("[Startup] Backend marked ready");
});

// Graceful shutdown handling
let isShuttingDown = false;
let healthCheckInterval: NodeJS.Timeout | null = null;

async function closeHttpServerWithTimeout(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            resolve();
        };

        const timeoutId = setTimeout(() => {
            const openConnections = activeHttpConnections.size;
            if (openConnections > 0) {
                logger.warn(
                    `[Shutdown] HTTP server close timed out after ${timeoutMs}ms; forcing ${openConnections} active connection(s) closed`,
                );
            }

            for (const socket of activeHttpConnections) {
                try {
                    socket.destroy();
                } catch {
                    // Ignore socket teardown errors during shutdown.
                }
            }

            const closeAllConnections = (
                httpServer as typeof httpServer & {
                    closeAllConnections?: () => void;
                }
            ).closeAllConnections;
            if (typeof closeAllConnections === "function") {
                closeAllConnections.call(httpServer);
            }

            finish();
        }, timeoutMs);
        timeoutId.unref?.();

        try {
            httpServer.close(() => {
                finish();
            });
        } catch {
            finish();
            return;
        }

        const closeIdleConnections = (
            httpServer as typeof httpServer & {
                closeIdleConnections?: () => void;
            }
        ).closeIdleConnections;
        if (typeof closeIdleConnections === "function") {
            closeIdleConnections.call(httpServer);
        }
    });
}

async function gracefulShutdown(signal: string) {
    if (isShuttingDown) {
        logger.debug("Shutdown already in progress...");
        return;
    }

    isShuttingDown = true;
    setRuntimeDrainState(true);
    logger.debug(`\nReceived ${signal}. Starting graceful shutdown...`);

    try {
        if (healthCheckInterval) {
            clearInterval(healthCheckInterval);
            healthCheckInterval = null;
        }

        // Shutdown Listen Together
        if (runApiRole) {
            stopPersistLoop();
            const mutationDrain = await stopListenTogetherSocketIntake();
            if (!mutationDrain.drained) {
                logger.error(
                    "Listen Together mutation drain failed; final persistence may skip locked groups",
                    { remainingMs: mutationDrain.remainingMs },
                );
            }
            await persistAllGroups({
                deadlineAtMs: mutationDrain.deadlineAtMs,
            });
            shutdownListenTogetherSocket();

            logger.debug("Closing HTTP server...");
            await closeHttpServerWithTimeout(HTTP_SERVER_CLOSE_TIMEOUT_MS);
        }

        const { shutdownUmapProjection } =
            await import("./services/umapProjection");
        await shutdownUmapProjection();

        // Shutdown workers (intervals, crons, queues)
        if (workersInitialized) {
            const { shutdownWorkers } = await import("./workers");
            await shutdownWorkers();
        } else if (runApiRole) {
            const { shutdownSchedulerClaimRedis } =
                await import("./utils/schedulerClaim");
            await shutdownSchedulerClaimRedis();
        }

        // Close Redis connection (node-redis v5+ replaced quit() with close())
        logger.debug("Closing Redis connection...");
        await redisClient.close();

        // Close Prisma connection
        logger.debug("Closing database connection...");
        await prisma.$disconnect();

        logger.debug("Graceful shutdown complete");
        process.exit(0);
    } catch (error) {
        logger.error("Error during shutdown:", error);
        process.exit(1);
    }
}

// Handle termination signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Global error handlers to prevent silent crashes
process.on("unhandledRejection", (reason, promise) => {
    logger.error("Unhandled Promise Rejection:", {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
    });
    // Don't exit - log and continue running
    // This prevents silent crashes from unhandled promises
});

process.on("uncaughtException", (error) => {
    logger.error("Uncaught Exception - initiating graceful shutdown:", {
        message: error.message,
        stack: error.stack,
    });
    // Attempt graceful shutdown for uncaught exceptions
    gracefulShutdown("uncaughtException").catch(() => {
        process.exit(1);
    });
});

// Periodic health check to keep database connections alive and detect issues early
// Runs every 5 minutes to prevent idle connection drops
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;
healthCheckInterval = setInterval(async () => {
    try {
        const dependencySnapshot = await dependencyReadiness.probe(true);
        if (!dependencySnapshot.overallHealthy) {
            logger.error("Readiness dependency check failed:", {
                postgres: dependencySnapshot.postgres,
                redis: dependencySnapshot.redis,
            });

            // Attempt to reconnect Prisma when PostgreSQL is unhealthy.
            if (!dependencySnapshot.postgres.ok) {
                try {
                    await prisma.$disconnect();
                    await prisma.$connect();
                    logger.debug("Database connection recovered");
                    await dependencyReadiness.probe(true);
                } catch (reconnectError) {
                    logger.error(
                        "Failed to recover database connection:",
                        reconnectError,
                    );
                }
            }
        }
    } catch (error) {
        logger.error("Health check failed - connections may be stale:", {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}, HEALTH_CHECK_INTERVAL);
