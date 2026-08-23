import rateLimit from "express-rate-limit";
import { logger } from "../utils/logger";
import { isLibraryMediaPath } from "./libraryRateLimitPaths";
import { createRedisRateLimitOptions } from "./rateLimitStore";

// soundspan is self-hosted behind a reverse proxy, and app.set("trust proxy", ...)
// makes X-Forwarded-For govern the client IP. Some auth, share-link, webhook,
// and federation surfaces can be unauthenticated and internet-exposed. The
// express-rate-limit trust-proxy warning is disabled because the proxy policy
// is configured centrally; operators must set TRUST_PROXY_HOPS to their real
// proxy depth so clients cannot select their own rate-limit key.
const trustProxyValidation = { validate: { trustProxy: false } };
const RATE_LIMIT_WINDOW_MS = 60_000;
const API_RATE_LIMIT_MAX = 5_000;
// Five thousand metadata operations fit large client syncs while bounding loops.
const LIBRARY_METADATA_RATE_LIMIT_MAX = 5_000;
// Five hundred limits outbound image-proxy amplification and bandwidth use.
const IMAGE_PROXY_RATE_LIMIT_MAX = 500;
// Five thousand covers fit a full large-library grid or offline-cache burst.
const COVER_ART_RATE_LIMIT_MAX = 5_000;
// Ten thousand stream starts allow gapless prefetch and seek storms while
// still bounding runaway players to about 167 new requests per second per IP.
const STREAMING_RATE_LIMIT_MAX = 10_000;
const COVER_ART_RATE_LIMIT_NAMESPACE = "cover-art-surface";
const STREAMING_RATE_LIMIT_NAMESPACE = "streaming-surface";

// General API rate limiter (5000 req/minute per IP)
// This remains in-memory to avoid Redis latency on hot API paths. It provides
// per-process bug and accidental-DOS containment, not distributed abuse control.
export const apiLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: API_RATE_LIMIT_MAX, // High ceiling for bug and accidental-loop containment
    message: "Too many requests from this IP, please try again later.",
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    handler: (req, res, next, options) => {
        logger.warn(
            `API rate limit exceeded: ${req.ip} on ${req.method} ${req.path}`,
        );
        res.status(options.statusCode).send(options.message);
    },
    skip: (req) => {
        // Never rate limit streaming, status polling, or health endpoints
        // Use precise path matching to prevent bypass via path manipulation
        const path = req.path;
        return (
            path === "/health" ||
            path === "/api/health" ||
            // Podcast streaming: /api/podcasts/:podcastId/episodes/:episodeId/stream
            (path.startsWith("/api/podcasts/") && path.endsWith("/stream")) ||
            // Soulseek search polling: /api/soulseek/search/:searchId (no /status suffix)
            /^\/api\/soulseek\/search\/[a-f0-9-]+$/.test(path)
        );
    },
    ...trustProxyValidation,
});

// Admin routes previously inherited apiLimiter, so retain its exact budget
// while sharing the counter across replicas for distributed abuse control.
export const adminSurfaceLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5000,
    message: "Too many requests from this IP, please try again later.",
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
        logger.warn(
            `API rate limit exceeded: ${req.ip} on ${req.method} ${req.path}`,
        );
        res.status(options.statusCode).send(options.message);
    },
    ...createRedisRateLimitOptions("admin-surface"),
    ...trustProxyValidation,
});

// Share-link routes previously inherited apiLimiter, so retain its exact
// budget while enforcing one counter across replicas and restarts.
export const shareLinkLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5000,
    message: "Too many requests from this IP, please try again later.",
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
        logger.warn(
            `API rate limit exceeded: ${req.ip} on ${req.method} ${req.path}`,
        );
        res.status(options.statusCode).send(options.message);
    },
    ...createRedisRateLimitOptions("share-link", { fallback: "memory" }),
    ...trustProxyValidation,
});

// Playback-state clients persist progress every 15 seconds (4 requests/minute).
// Allow 600 requests/minute so even 150 normally syncing devices behind one IP fit.
export const playbackStateLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 600,
    message: "Too many playback state requests. Please slow down.",
    standardHeaders: true,
    legacyHeaders: false,
    ...trustProxyValidation,
});

// Auth limiter for login endpoints (40 attempts/15min per IP)
// More lenient for self-hosted apps where users may have password manager issues
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 40, // Increased from 5 for self-hosted environments
    skipSuccessfulRequests: true, // Don't count successful requests
    message: "Too many login attempts, please try again in 15 minutes.",
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
        logger.warn(`Auth rate limit exceeded: ${req.ip}`);
        res.status(options.statusCode).send(options.message);
    },
    ...createRedisRateLimitOptions("auth", { fallback: "memory" }),
    ...trustProxyValidation,
});

const REFRESH_RATE_LIMIT_MESSAGE =
    "Too many token refresh attempts. Please try again later.";

// Refresh traffic uses a separate, generous bucket so normal access-token
// rotation cannot exhaust the interactive login-attempt budget.
export const refreshLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 60,
    skipSuccessfulRequests: true,
    message: REFRESH_RATE_LIMIT_MESSAGE,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
        logger.warn(`Refresh rate limit exceeded: ${req.ip}`);
        res.status(options.statusCode).json({
            error: REFRESH_RATE_LIMIT_MESSAGE,
            code: "RATE_LIMITED",
        });
    },
    ...createRedisRateLimitOptions("auth-refresh", { fallback: "memory" }),
    ...trustProxyValidation,
});

/** Counts every OIDC browser-flow request, including redirect responses. */
export const oidcFlowLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    message: "Too many login attempts, please try again in 15 minutes.",
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
        logger.warn(`OIDC flow rate limit exceeded: ${req.ip}`);
        res.status(options.statusCode).send(options.message);
    },
    ...createRedisRateLimitOptions("oidc-flow", { fallback: "memory" }),
    ...trustProxyValidation,
});

// Library metadata keeps the general API ceiling but skips media paths using
// the path visible inside the mounted /api/library router.
export const libraryMetadataLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: LIBRARY_METADATA_RATE_LIMIT_MAX,
    message: "Too many library metadata requests, please slow down.",
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => isLibraryMediaPath(req.path),
    ...trustProxyValidation,
});

// External image proxies retain the original per-process budget because cache
// misses amplify into bounded but expensive upstream fetches.
export const imageLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: IMAGE_PROXY_RATE_LIMIT_MAX,
    message: "Too many image requests, please slow down.",
    standardHeaders: true,
    legacyHeaders: false,
    ...trustProxyValidation,
});

// Local covers use a high-volume shared budget so grids and offline caching do
// not consume metadata capacity across backend replicas.
export const coverArtLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: COVER_ART_RATE_LIMIT_MAX,
    message: "Too many cover art requests, please slow down.",
    standardHeaders: true,
    legacyHeaders: false,
    ...createRedisRateLimitOptions(COVER_ART_RATE_LIMIT_NAMESPACE, {
        fallback: "memory",
    }),
    ...trustProxyValidation,
});

// Audio starts and range retries use their own generous budget. Gapless
// players prefetch, and repeated seeking can open many short-lived requests.
export const streamingLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: STREAMING_RATE_LIMIT_MAX,
    message: "Too many streaming requests, please slow down.",
    standardHeaders: true,
    legacyHeaders: false,
    ...createRedisRateLimitOptions(STREAMING_RATE_LIMIT_NAMESPACE, {
        fallback: "memory",
    }),
    ...trustProxyValidation,
});

// Download limiter (100 req/minute)
// Users might download entire discographies, so this needs to be reasonable
export const downloadLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100,
    message: "Too many download requests, please try again later.",
    standardHeaders: true,
    legacyHeaders: false,
    ...trustProxyValidation,
});

// Lyrics lookup limiter (120 req/minute)
// Lyrics are heavily cached, but a dedicated limit protects external providers
// from burst traffic caused by bad clients or rapid track skipping.
export const lyricsLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 120,
    message: "Too many lyrics requests. Please slow down.",
    standardHeaders: true,
    legacyHeaders: false,
    ...trustProxyValidation,
});

// Lyrics cache mutation limiter (20 req/15 minutes)
// Prevents repeated cache clears from forcing avoidable upstream lookups.
export const lyricsMutationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    message: "Too many lyrics cache actions. Please try again later.",
    standardHeaders: true,
    legacyHeaders: false,
    ...trustProxyValidation,
});

// ── YouTube Music rate limiters ────────────────────────────────────
// These exist to throttle requests to YouTube's APIs, which are more
// sensitive to abuse than our own endpoints.  The sidecar also has its
// own internal concurrency/delay controls, but backend-side limits
// provide an additional safety layer.

// YT Music search limiter (30 search requests/minute per IP).
// Each "search" call triggers 1+ InnerTube requests on the sidecar.
// Batch match calls each count as 1 request here; the sidecar handles
// internal pacing of the individual queries within the batch.
export const ytMusicSearchLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30,
    message:
        "Too many YouTube Music search requests. Please slow down to avoid rate limiting.",
    standardHeaders: true,
    legacyHeaders: false,
    ...trustProxyValidation,
});

// YT Music stream extraction limiter (20 extractions/minute per IP).
// Each stream request triggers a yt-dlp extraction (unless cached).
// This is the most detectable operation — yt-dlp makes multiple HTTP
// requests to YouTube for each extraction.
export const ytMusicStreamLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 20,
    message:
        "Too many YouTube Music stream requests. Please wait before playing more tracks.",
    standardHeaders: true,
    legacyHeaders: false,
    ...trustProxyValidation,
});

// Lidarr webhook limiter. The POST /api/webhooks/lidarr endpoint is reachable by
// Lidarr — and by anyone who can reach the host — so bound abusive bursts while
// staying generous for the several events Lidarr emits per import. NOTE: keying
// is by IP, which is spoofable when `trust proxy` is permissive; set
// TRUST_PROXY_HOPS (see config.trustProxy) to your real proxy depth so the key
// is trustworthy.
export const webhookLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60,
    message: "Too many webhook requests, please try again later.",
    standardHeaders: true,
    legacyHeaders: false,
    ...createRedisRateLimitOptions("webhook", { fallback: "memory" }),
    ...trustProxyValidation,
});

// Federation catalog and stream traffic is keyed by the authenticated peer,
// so changing source IP cannot mint a new bucket for the same credential.
export const federationPeerLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 1000,
    message: "Too many federation requests. Please slow down.",
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.federationPeer?.id || "unresolved-peer",
    ...createRedisRateLimitOptions("federation-peer"),
    ...trustProxyValidation,
});
