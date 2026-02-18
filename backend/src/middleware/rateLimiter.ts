import rateLimit from "express-rate-limit";

// Trust proxy validation is disabled because this is a self-hosted app
// running behind a reverse proxy (nginx/traefik in Docker). The app.set("trust proxy", true)
// setting is required for proper IP detection and session cookies to work.
// Since this is self-hosted (not a public API), IP spoofing to bypass rate limiting is not a concern.
const trustProxyValidation = { validate: { trustProxy: false } };

// General API rate limiter (5000 req/minute per IP)
// This is for a single-user self-hosted app, so limits should be VERY high
// Only exists to prevent infinite loops or bugs from DOS'ing the server
export const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5000, // Very high limit - personal app, not a public API
    message: "Too many requests from this IP, please try again later.",
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    skip: (req) => {
        // Never rate limit streaming, status polling, or health endpoints
        // Use precise path matching to prevent bypass via path manipulation
        const path = req.path;
        return (
            path === "/health" ||
            path === "/api/health" ||
            // Track streaming: /api/library/tracks/:id/stream
            (path.startsWith("/api/library/tracks/") && path.endsWith("/stream")) ||
            // Podcast streaming: /api/podcasts/:podcastId/episodes/:episodeId/stream
            (path.startsWith("/api/podcasts/") && path.endsWith("/stream")) ||
            // Soulseek search polling: /api/soulseek/search/:searchId (no /status suffix)
            /^\/api\/soulseek\/search\/[a-f0-9-]+$/.test(path) ||
            // Spotify import status: /api/spotify/import/:jobId/status
            /^\/api\/spotify\/import\/[a-zA-Z0-9_-]+\/status$/.test(path)
        );
    },
    ...trustProxyValidation,
});

// Auth limiter for login endpoints (20 attempts/15min per IP)
// More lenient for self-hosted apps where users may have password manager issues
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // Increased from 5 for self-hosted environments
    skipSuccessfulRequests: true, // Don't count successful requests
    message: "Too many login attempts, please try again in 15 minutes.",
    standardHeaders: true,
    legacyHeaders: false,
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
    message: "Too many YouTube Music search requests. Please slow down to avoid rate limiting.",
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
    message: "Too many YouTube Music stream requests. Please wait before playing more tracks.",
    standardHeaders: true,
    legacyHeaders: false,
    ...trustProxyValidation,
});
