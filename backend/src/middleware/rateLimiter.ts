import rateLimit from "express-rate-limit";
import { logger } from "../utils/logger";
import { createRedisRateLimitOptions } from "./rateLimitStore";

// soundspan is self-hosted behind a reverse proxy, and app.set("trust proxy", ...)
// makes X-Forwarded-For govern the client IP. Some auth, share-link, webhook,
// and federation surfaces can be unauthenticated and internet-exposed. The
// express-rate-limit trust-proxy warning is disabled because the proxy policy
// is configured centrally; operators must set TRUST_PROXY_HOPS to their real
// proxy depth so clients cannot select their own rate-limit key.
const trustProxyValidation = { validate: { trustProxy: false } };

// General API rate limiter (5000 req/minute per IP)
// This remains in-memory to avoid Redis latency on hot API paths. It provides
// per-process bug and accidental-DOS containment, not distributed abuse control.
export const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5000, // High ceiling for bug and accidental-loop containment
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
            // Track streaming: /api/library/tracks/:id/stream
            (path.startsWith("/api/library/tracks/") &&
                path.endsWith("/stream")) ||
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
    ...createRedisRateLimitOptions("share-link"),
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
    ...createRedisRateLimitOptions("auth"),
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
    ...createRedisRateLimitOptions("oidc-flow"),
    ...trustProxyValidation,
});

// Image/Cover art limiter (very high limit: 500 req/minute)
// This is for image proxying - not a security risk, just bandwidth
export const imageLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 500, // Allow 500 image requests per minute (high volume pages need this)
    message: "Too many image requests, please slow down.",
    standardHeaders: true,
    legacyHeaders: false,
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
    ...createRedisRateLimitOptions("webhook"),
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

// Pairing is unauthenticated until a valid single-use code is consumed.
export const federationPairingLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: "Too many federation pairing attempts. Please try again later.",
    standardHeaders: true,
    legacyHeaders: false,
    ...createRedisRateLimitOptions("federation-pairing"),
    ...trustProxyValidation,
});
