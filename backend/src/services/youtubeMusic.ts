/**
 * YouTube Music Service
 *
 * Communicates with the ytmusic-streamer FastAPI sidecar over HTTP.
 * Provides search, browse, library, authentication, and stream-proxying
 * capabilities. Audio is streamed through the sidecar (never saved to disk).
 *
 * All methods accept a `userId` parameter — the sidecar uses per-user
 * OAuth credentials so each soundspan user connects their own YouTube Music
 * account independently.
 */

import axios, { AxiosInstance } from "axios";
import http from "node:http";
import https from "node:https";
import { logger } from "../utils/logger";
import type { CanonicalMediaSearchResult } from "@soundspan/media-metadata-contract";

// ── Sidecar URL ────────────────────────────────────────────────────
const YTMUSIC_STREAMER_URL =
    process.env.YTMUSIC_STREAMER_URL || "http://127.0.0.1:8586";
const SIDECAR_AGENT_OPTIONS = {
    keepAlive: true,
    maxSockets: 64,
    maxFreeSockets: 16,
};
const SIDE_CAR_HTTP_AGENT = new http.Agent(SIDECAR_AGENT_OPTIONS);
const SIDE_CAR_HTTPS_AGENT = new https.Agent(SIDECAR_AGENT_OPTIONS);
const AVAILABILITY_CACHE_TTL_MS = 10_000;

// ── Types ──────────────────────────────────────────────────────────

export interface YtMusicAuthStatus {
    authenticated: boolean;
    reason?: string;
}

export interface YtMusicDeviceCode {
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
}

export interface YtMusicDeviceCodePollResult {
    status: "pending" | "success" | "error";
    error?: string;
    oauth_json?: string;
}

export interface YtMusicSearchResult {
    results: any[];
    total: number;
}

export interface YtMusicCanonicalSearchResponse {
    query: string;
    filter: "songs" | "albums" | "artists" | "videos" | null;
    total: number;
    results: CanonicalMediaSearchResult[];
}

export interface YtMusicAlbum {
    browseId: string;
    title: string;
    artist: string;
    year?: string;
    thumbnails: any[];
    tracks: any[];
    trackCount: number;
    duration?: string;
    type: string;
}

export interface YtMusicArtist {
    channelId: string;
    name: string;
    thumbnails: any[];
    description?: string;
    albums: any[];
    songs: any[];
}

export interface YtMusicSong {
    videoId: string;
    title: string;
    artist: string;
    album?: string;
    duration?: number;
    thumbnails: any[];
}

export interface YtMusicStreamInfo {
    videoId: string;
    url: string;
    content_type: string;
    duration: number;
    abr: number;
    acodec: string;
    expires_at: number;
}

export type YtMusicStreamQuality = "low" | "medium" | "high" | "lossless";

/**
 * Normalize user-provided or stored quality values to sidecar query values.
 * Accepts both persisted uppercase settings and lowercase request values.
 */
export const normalizeYtMusicStreamQuality = (
    quality: string | null | undefined
): YtMusicStreamQuality | undefined => {
    const normalized = quality?.trim().toLowerCase();
    if (
        normalized === "low" ||
        normalized === "medium" ||
        normalized === "high" ||
        normalized === "lossless"
    ) {
        return normalized;
    }
    return undefined;
};

interface YtMusicMatchInput {
    artist: string;
    title: string;
    albumTitle?: string;
    duration?: number;
    isrc?: string;
}

/**
 * Safely extract a numeric duration (in seconds) from a YT Music result.
 * The sidecar returns `duration_seconds` (int) and `duration` (string like "3:45").
 * If `duration_seconds` is missing or 0, parse the text representation.
 */
function parseDuration(item: any): number {
    if (item.duration_seconds && typeof item.duration_seconds === "number") {
        return item.duration_seconds;
    }
    if (typeof item.duration === "number" && item.duration > 0) {
        return item.duration;
    }
    if (typeof item.duration === "string" && item.duration.includes(":")) {
        const parts = item.duration.split(":").map(Number);
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
    }
    return 0;
}

function normalizeText(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function resolvePrimaryArtist(item: Record<string, unknown>): string {
    const artist = normalizeText(item.artist);
    if (artist) {
        return artist;
    }

    const artists = item.artists;
    if (Array.isArray(artists)) {
        for (const entry of artists) {
            if (typeof entry === "string") {
                const normalized = normalizeText(entry);
                if (normalized) return normalized;
                continue;
            }
            if (entry && typeof entry === "object") {
                const name = normalizeText(
                    (entry as Record<string, unknown>).name
                );
                if (name) return name;
            }
        }
    }

    return "Unknown Artist";
}

function resolveAlbumTitle(item: Record<string, unknown>): string | null {
    const album = item.album;
    if (typeof album === "string") {
        return normalizeText(album);
    }
    if (album && typeof album === "object") {
        const record = album as Record<string, unknown>;
        return normalizeText(record.title) ?? normalizeText(record.name);
    }
    return null;
}

function resolveThumbnailUrl(item: Record<string, unknown>): string | null {
    const thumbnails = item.thumbnails;
    if (!Array.isArray(thumbnails)) return null;
    for (const thumb of thumbnails) {
        if (!thumb || typeof thumb !== "object") continue;
        const url = normalizeText((thumb as Record<string, unknown>).url);
        if (url) return url;
    }
    return null;
}

function toCanonicalSearchResultItem(
    item: unknown
): CanonicalMediaSearchResult | null {
    if (!item || typeof item !== "object") {
        return null;
    }

    const record = item as Record<string, unknown>;
    const providerTrackId = normalizeText(record.videoId);
    const title = normalizeText(record.title);

    if (!providerTrackId || !title) {
        return null;
    }

    const durationSecRaw = parseDuration(record);
    const durationSec =
        Number.isFinite(durationSecRaw) && durationSecRaw > 0
            ? durationSecRaw
            : null;

    return {
        source: "youtube",
        provider: "ytmusic",
        providerTrackId,
        title,
        artistName: resolvePrimaryArtist(record),
        albumTitle: resolveAlbumTitle(record),
        durationSec,
        thumbnailUrl: resolveThumbnailUrl(record),
        raw: record,
    };
}

// ── Service ────────────────────────────────────────────────────────

/**
 * Retry a function with exponential backoff for transient errors.
 * Retries on HTTP 429 (rate limited) and 5xx (server errors).
 */
async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    label: string,
    maxRetries = 3,
    baseDelayMs = 1000
): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            const status = err?.response?.status;
            const isRetryable =
                status === 429 ||
                (status >= 500 && status < 600) ||
                err?.code === "ECONNRESET" ||
                err?.code === "ETIMEDOUT";

            if (!isRetryable || attempt === maxRetries) {
                throw err;
            }

            // Use Retry-After header if available (YouTube sends it on 429)
            const retryAfter = err?.response?.headers?.["retry-after"];
            let delayMs: number;
            if (retryAfter) {
                delayMs = parseInt(retryAfter, 10) * 1000 || baseDelayMs;
            } else {
                // Exponential backoff with jitter: base * 2^attempt ± 25%
                delayMs = baseDelayMs * Math.pow(2, attempt);
                delayMs += delayMs * (Math.random() * 0.5 - 0.25);
            }

            logger.warn(
                `[YTMusic] ${label} failed (status=${status}, attempt=${attempt + 1}/${maxRetries}), ` +
                `retrying in ${Math.round(delayMs)}ms`
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    // TypeScript: unreachable, but satisfies the compiler
    throw new Error(`[YTMusic] ${label}: exhausted retries`);
}

class YouTubeMusicService {
    private client: AxiosInstance;
    private availabilityCache: { value: boolean; expiresAt: number } | null = null;
    private availabilityInFlight: Promise<boolean> | null = null;
    private static readonly UNDESIRED_MISMATCH_TERMS = [
        "karaoke",
        "tribute",
        "cover",
        "soundalike",
        "sound alike",
        "nightcore",
        "sped up",
        "slowed",
    ];
    private static readonly VERSION_MISMATCH_TERMS = [
        "live",
        "acoustic",
        "instrumental",
        "remix",
        "edit",
        "version",
        "re-recorded",
        "rerecorded",
    ];

    constructor() {
        this.client = axios.create({
            baseURL: YTMUSIC_STREAMER_URL,
            timeout: 30_000,
            httpAgent: SIDE_CAR_HTTP_AGENT,
            httpsAgent: SIDE_CAR_HTTPS_AGENT,
        });
    }

    // ── Health / Status ────────────────────────────────────────────

    /**
     * Check whether the sidecar is reachable.
     */
    async isAvailable(): Promise<boolean> {
        const now = Date.now();
        if (this.availabilityCache && this.availabilityCache.expiresAt > now) {
            return this.availabilityCache.value;
        }
        if (this.availabilityInFlight) {
            return this.availabilityInFlight;
        }

        this.availabilityInFlight = (async () => {
            let available = false;
            try {
                const res = await this.client.get("/health", { timeout: 5_000 });
                available = res.status === 200;
            } catch {
                available = false;
            }

            this.availabilityCache = {
                value: available,
                expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_MS,
            };
            return available;
        })().finally(() => {
            this.availabilityInFlight = null;
        });

        return this.availabilityInFlight;
    }

    /**
     * Check whether a specific user is authenticated with YouTube Music.
     */
    async getAuthStatus(userId: string): Promise<YtMusicAuthStatus> {
        const res = await this.client.get("/auth/status", {
            params: { user_id: userId },
        });
        return res.data;
    }

    // ── OAuth Credential Restore ───────────────────────────────────

    /**
     * Write OAuth JSON to the sidecar for a specific user (used to restore
     * credentials from the DB on first request).
     */
    async restoreOAuth(userId: string, oauthJson: string): Promise<void> {
        await this.client.post(
            "/auth/restore",
            { oauth_json: oauthJson },
            { params: { user_id: userId } }
        );
    }

    /**
     * Clear stored OAuth credentials in the sidecar for a specific user.
     */
    async clearAuth(userId: string): Promise<void> {
        await this.client.post("/auth/clear", null, {
            params: { user_id: userId },
        });
    }

    // ── Device Code OAuth Flow ─────────────────────────────────────

    /**
     * Initiate the Google OAuth device code flow.
     * Returns a user_code and verification_url for the user to visit.
     */
    async initiateDeviceAuth(
        clientId: string,
        clientSecret: string
    ): Promise<YtMusicDeviceCode> {
        const res = await this.client.post("/auth/device-code", {
            client_id: clientId,
            client_secret: clientSecret,
        });
        return res.data;
    }

    /**
     * Poll for device code authorization completion.
     * Returns the token when ready, or a pending status.
     */
    async pollDeviceAuth(
        userId: string,
        clientId: string,
        clientSecret: string,
        deviceCode: string
    ): Promise<YtMusicDeviceCodePollResult> {
        const res = await this.client.post(
            "/auth/device-code/poll",
            {
                client_id: clientId,
                client_secret: clientSecret,
                device_code: deviceCode,
            },
            { params: { user_id: userId } }
        );
        return res.data;
    }

    /**
     * Restore OAuth credentials to the sidecar, including client credentials
     * for OAuthCredentials support.
     */
    async restoreOAuthWithCredentials(
        userId: string,
        oauthJson: string,
        clientId?: string,
        clientSecret?: string
    ): Promise<void> {
        const body: Record<string, string> = { oauth_json: oauthJson };
        if (clientId && clientSecret) {
            body.client_id = clientId;
            body.client_secret = clientSecret;
        }
        await this.client.post("/auth/restore", body, {
            params: { user_id: userId },
        });
    }

    // ── Search ─────────────────────────────────────────────────────

    async search(
        userId: string,
        query: string,
        filter?: "songs" | "albums" | "artists" | "videos"
    ): Promise<YtMusicSearchResult> {
        return retryWithBackoff(async () => {
            const res = await this.client.post(
                "/search",
                { query, filter },
                { params: { user_id: userId } }
            );
            return res.data;
        }, `search(${query})`);
    }

    async searchCanonical(
        userId: string,
        query: string,
        filter?: "songs" | "albums" | "artists" | "videos"
    ): Promise<YtMusicCanonicalSearchResponse> {
        const rawResult = await this.search(userId, query, filter);
        const canonicalResults = Array.isArray(rawResult.results)
            ? rawResult.results
                  .map((item) => toCanonicalSearchResultItem(item))
                  .filter(
                      (item): item is CanonicalMediaSearchResult => item !== null
                  )
            : [];

        return {
            query,
            filter: filter ?? null,
            total:
                typeof rawResult.total === "number" &&
                Number.isFinite(rawResult.total)
                    ? rawResult.total
                    : canonicalResults.length,
            results: canonicalResults,
        };
    }

    // ── Browse ─────────────────────────────────────────────────────

    async getAlbum(userId: string, browseId: string): Promise<YtMusicAlbum> {
        const res = await this.client.get(`/album/${browseId}`, {
            params: { user_id: userId },
        });
        return res.data;
    }

    async getArtist(userId: string, channelId: string): Promise<YtMusicArtist> {
        const res = await this.client.get(`/artist/${channelId}`, {
            params: { user_id: userId },
        });
        return res.data;
    }

    async getSong(userId: string, videoId: string): Promise<YtMusicSong> {
        const res = await this.client.get(`/song/${videoId}`, {
            params: { user_id: userId },
        });
        return res.data;
    }

    // ── Streaming ──────────────────────────────────────────────────

    /**
     * Get stream metadata (URL, format, quality) for a video.
     * The URL itself is IP-locked to the sidecar — callers should
     * use `getStreamProxy` for actual audio delivery.
     */
    async getStreamInfo(
        userId: string,
        videoId: string,
        quality?: string
    ): Promise<YtMusicStreamInfo> {
        return retryWithBackoff(async () => {
            const params: Record<string, string> = { user_id: userId };
            if (quality) params.quality = quality;
            const res = await this.client.get(`/stream/${videoId}`, { params });
            return res.data;
        }, `getStreamInfo(${videoId})`);
    }

    /**
     * Return an Axios response that streams the audio bytes from the
     * sidecar proxy. The caller should pipe `res.data` to the client.
     */
    async getStreamProxy(
        userId: string,
        videoId: string,
        quality?: string,
        rangeHeader?: string
    ) {
        const params: Record<string, string> = { user_id: userId };
        if (quality) params.quality = quality;

        const headers: Record<string, string> = {};
        if (rangeHeader) headers["Range"] = rangeHeader;

        return this.client.get(`/proxy/${videoId}`, {
            params,
            headers,
            responseType: "stream",
            timeout: 120_000, // Longer timeout for streaming
        });
    }

    // ── Library ────────────────────────────────────────────────────

    async getLibrarySongs(userId: string, limit = 100): Promise<any[]> {
        const res = await this.client.get("/library/songs", {
            params: { user_id: userId, limit },
        });
        return res.data.songs;
    }

    async getLibraryAlbums(userId: string, limit = 100): Promise<any[]> {
        const res = await this.client.get("/library/albums", {
            params: { user_id: userId, limit },
        });
        return res.data.albums;
    }

    // ── Gap-Fill Matching ──────────────────────────────────────────

    /**
     * Run multiple search queries against the sidecar concurrently.
     * The sidecar executes all queries in parallel via asyncio.gather,
     * so N queries take ~1 round-trip instead of N sequential ones.
     */
    async searchBatch(
        userId: string,
        queries: Array<{ query: string; filter?: "songs" | "albums" | "artists" | "videos"; limit?: number }>
    ): Promise<Array<{ results: any[]; total: number; error: string | null }>> {
        return retryWithBackoff(async () => {
            const res = await this.client.post(
                "/search/batch",
                { queries },
                {
                    params: { user_id: userId },
                    timeout: 60_000, // Longer timeout for batch
                }
            );
            return res.data.results;
        }, `searchBatch(${queries.length} queries)`);
    }

    /**
     * Match an entire album's tracks against YouTube Music in one
     * batch call. Instead of N individual match requests (each doing
     * up to 3 search fallbacks), this:
     *   1. Sends all search queries in a single batch to the sidecar
     *   2. Runs them concurrently on the sidecar via asyncio.gather
     *   3. Returns matches keyed by track index
     *
     * Falls back to individual matching for tracks that didn't match
     * in the filtered batch.
     */
    async findMatchesForAlbum(
        userId: string,
        tracks: YtMusicMatchInput[]
    ): Promise<Array<{ videoId: string; title: string; duration: number } | null>> {
        // Step 1: Build filtered "songs" search queries for all tracks
        const queries = tracks.map((t) => {
            const cleanArtist = this.sanitizeQuery(t.artist);
            const cleanTitle = this.sanitizeQuery(t.title);
            return {
                query: `${cleanArtist} ${cleanTitle}`,
                filter: "songs" as const,
                limit: 6,
            };
        });

        // Step 2: Execute all queries concurrently in one batch call
        let batchResults: Array<{ results: any[]; total: number; error: string | null }>;
        try {
            batchResults = await this.searchBatch(userId, queries);
        } catch (err) {
            logger.warn("[YTMusic] Batch search failed, falling back to individual:", err);
            // Fallback: match each track individually
            return Promise.all(
                tracks.map((t) =>
                    this.findMatchForTrack(
                        userId,
                        t.artist,
                        t.title,
                        t.albumTitle,
                        t.duration,
                        t.isrc
                    )
                )
            );
        }

        // Step 3: Extract matches from batch results
        const matches: Array<{ videoId: string; title: string; duration: number } | null> = [];
        const unmatchedIndices: number[] = [];

        for (let i = 0; i < tracks.length; i++) {
            const result = batchResults[i];
            if (result && !result.error && result.results?.length) {
                const sourceTrack = tracks[i];
                if (!sourceTrack) {
                    matches.push(null);
                    unmatchedIndices.push(i);
                    continue;
                }

                const song = this.selectBestCandidate(sourceTrack, result.results);
                if (song) {
                    matches.push(this.toMatchResult(song, sourceTrack.title));
                    continue;
                }
            }
            // No match from filtered search — try unfiltered fallback
            matches.push(null);
            unmatchedIndices.push(i);
        }

        // Step 4: For unmatched tracks, try unfiltered search in a second batch
        if (unmatchedIndices.length > 0) {
            const fallbackQueries = unmatchedIndices.map((idx) => {
                const t = tracks[idx];
                const cleanArtist = this.sanitizeQuery(t.artist);
                const cleanTitle = this.sanitizeQuery(t.title);
                // Try with album title for disambiguation
                const cleanAlbum = t.albumTitle ? this.sanitizeQuery(t.albumTitle) : "";
                const query = cleanAlbum
                    ? `${cleanArtist} ${cleanTitle} ${cleanAlbum}`
                    : `${cleanArtist} ${cleanTitle}`;
                return { query, limit: 8 };
            });

            try {
                const fallbackResults = await this.searchBatch(userId, fallbackQueries);
                for (let j = 0; j < unmatchedIndices.length; j++) {
                    const idx = unmatchedIndices[j];
                    const result = fallbackResults[j];
                    if (result && !result.error && result.results?.length) {
                        const sourceTrack = tracks[idx];
                        if (!sourceTrack) continue;
                        const song = this.selectBestCandidate(sourceTrack, result.results);
                        if (song) {
                            matches[idx] = this.toMatchResult(song, sourceTrack.title);
                        }
                    }
                }
            } catch (err) {
                logger.warn("[YTMusic] Batch fallback search failed:", err);
                // Leave unmatched tracks as null
            }
        }

        return matches;
    }

    /**
     * Sanitize a search query for YouTube Music.
     * Strips characters that cause HTTP 400 from Google's API:
     * parentheses, brackets, featuring tags, remaster suffixes, etc.
     */
    private sanitizeQuery(text: string): string {
        return text
            .replace(/\s*\(.*?\)\s*/g, " ")     // Remove (Deluxe Edition), (feat. X), etc.
            .replace(/\s*\[.*?\]\s*/g, " ")      // Remove [Remastered], [Explicit], etc.
            .replace(/[^\p{L}\p{N}\s'-]/gu, " ") // Keep letters, numbers, spaces, hyphens, apostrophes
            .replace(/\s+/g, " ")                 // Collapse whitespace
            .trim();
    }

    private normaliseLoose(text: string): string {
        return this.sanitizeQuery(text || "")
            .toLowerCase()
            .replace(/['\u2019]/g, "")
            .replace(/[^\p{L}\p{N}\s]/gu, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    private normaliseCompact(text: string): string {
        return this.normaliseLoose(text).replace(/\s+/g, "");
    }

    private tokenOverlapScore(a: string, b: string): number {
        if (!a || !b) return 0;
        const aTokens = new Set(a.split(" ").filter(Boolean));
        const bTokens = new Set(b.split(" ").filter(Boolean));
        if (!aTokens.size || !bTokens.size) return 0;
        let intersection = 0;
        for (const token of aTokens) {
            if (bTokens.has(token)) intersection++;
        }
        const union = new Set([...aTokens, ...bTokens]).size;
        return union > 0 ? intersection / union : 0;
    }

    private textSimilarity(expected: string, candidate: string): number {
        const lhs = this.normaliseLoose(expected);
        const rhs = this.normaliseLoose(candidate);
        if (!lhs || !rhs) return 0;
        if (lhs === rhs) return 1;

        const lhsCompact = lhs.replace(/\s+/g, "");
        const rhsCompact = rhs.replace(/\s+/g, "");
        if (lhsCompact === rhsCompact) return 0.98;

        const overlap = this.tokenOverlapScore(lhs, rhs);
        const containsBonus =
            lhs.includes(rhs) || rhs.includes(lhs) ? 0.1 : 0;
        return Math.min(1, overlap * 0.9 + containsBonus);
    }

    private hasTerm(text: string, term: string): boolean {
        return this.normaliseLoose(text).includes(term);
    }

    private mismatchPenalty(expectedTitle: string, candidateTitle: string): number {
        let penalty = 0;

        for (const term of YouTubeMusicService.UNDESIRED_MISMATCH_TERMS) {
            if (!this.hasTerm(expectedTitle, term) && this.hasTerm(candidateTitle, term)) {
                penalty += 0.25;
            }
        }

        for (const term of YouTubeMusicService.VERSION_MISMATCH_TERMS) {
            if (!this.hasTerm(expectedTitle, term) && this.hasTerm(candidateTitle, term)) {
                penalty += 0.08;
            }
        }

        return Math.min(0.45, penalty);
    }

    private normaliseDurationSeconds(value?: number): number | null {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
            return null;
        }
        const seconds = value > 10_000 ? Math.round(value / 1000) : Math.round(value);
        if (seconds <= 0 || seconds > 6 * 60 * 60) return null;
        return seconds;
    }

    private durationSimilarity(expected?: number, candidate?: number): number | null {
        const expectedSeconds = this.normaliseDurationSeconds(expected);
        const candidateSeconds = this.normaliseDurationSeconds(candidate);
        if (expectedSeconds === null || candidateSeconds === null) return null;

        const diff = Math.abs(expectedSeconds - candidateSeconds);
        if (diff <= 3) return 1;
        if (diff <= 7) return 0.9;
        if (diff <= 15) return 0.65;
        if (diff <= 30) return 0.35;
        return 0;
    }

    private extractCandidateArtists(candidate: any): string[] {
        const fromPrimary =
            typeof candidate?.artist === "string" && candidate.artist.trim()
                ? [candidate.artist]
                : [];
        const fromList = Array.isArray(candidate?.artists)
            ? candidate.artists.filter(
                (artist: unknown) =>
                    typeof artist === "string" && artist.trim()
            )
            : [];
        return Array.from(new Set([...fromPrimary, ...fromList]));
    }

    private extractCandidateAlbum(candidate: any): string {
        if (typeof candidate?.album === "string") return candidate.album;
        if (typeof candidate?.album?.name === "string") return candidate.album.name;
        if (typeof candidate?.album?.title === "string") return candidate.album.title;
        return "";
    }

    private scoreCandidate(
        track: YtMusicMatchInput,
        candidate: any
    ): number {
        const titleScore = this.textSimilarity(track.title, candidate?.title || "");
        const artistCandidates = this.extractCandidateArtists(candidate);
        const artistScore = artistCandidates.length
            ? Math.max(
                ...artistCandidates.map((artistName) =>
                    this.textSimilarity(track.artist, artistName)
                )
            )
            : this.textSimilarity(track.artist, candidate?.artist || "");
        const albumScore =
            track.albumTitle && this.extractCandidateAlbum(candidate)
                ? this.textSimilarity(track.albumTitle, this.extractCandidateAlbum(candidate))
                : null;
        const durationScore = this.durationSimilarity(track.duration, parseDuration(candidate));

        const weightedSignals: Array<{ score: number; weight: number }> = [
            { score: titleScore, weight: 0.56 },
            { score: artistScore, weight: 0.32 },
        ];
        if (albumScore !== null) weightedSignals.push({ score: albumScore, weight: 0.12 });
        if (durationScore !== null) weightedSignals.push({ score: durationScore, weight: 0.2 });

        const totalWeight = weightedSignals.reduce((sum, entry) => sum + entry.weight, 0);
        let score =
            totalWeight > 0
                ? weightedSignals.reduce(
                    (sum, entry) => sum + entry.score * entry.weight,
                    0
                ) / totalWeight
                : 0;
        score -= this.mismatchPenalty(track.title, candidate?.title || "");

        if (candidate?.type && candidate.type !== "song") {
            score -= 0.25;
        }

        if (
            this.normaliseCompact(track.title) ===
            this.normaliseCompact(candidate?.title || "")
        ) {
            score += 0.08;
        }

        if (
            artistCandidates.some(
                (artistName) =>
                    this.normaliseCompact(track.artist) ===
                    this.normaliseCompact(artistName)
            )
        ) {
            score += 0.05;
        }

        return score;
    }

    private selectBestCandidate(
        track: YtMusicMatchInput,
        candidates: any[]
    ): any | null {
        const viable = candidates.filter((candidate) => !!candidate?.videoId);
        if (!viable.length) return null;

        const ranked = viable
            .map((candidate) => ({
                candidate,
                score: this.scoreCandidate(track, candidate),
            }))
            .sort((a, b) => b.score - a.score);

        const best = ranked[0];
        const second = ranked[1];
        if (!best) return null;

        if (best.score < 0.54) return null;
        if (second && best.score < 0.64 && best.score - second.score < 0.07) {
            return null;
        }

        return best.candidate;
    }

    private toMatchResult(
        candidate: any,
        fallbackTitle: string
    ): { videoId: string; title: string; duration: number } {
        return {
            videoId: candidate.videoId,
            title: candidate.title || fallbackTitle,
            duration: parseDuration(candidate),
        };
    }

    /**
     * Find a matching YouTube Music track for an album track that
     * isn't in the local library. Searches by "{artist} {title}" and
     * ranks candidates by title/artist/album/duration similarity.
     *
     * Uses a tiered fallback strategy:
     *   1. artist + title (filtered to songs)
     *   2. artist + title (unfiltered)
     *   3. artist + title + album (unfiltered)
     */
    async findMatchForTrack(
        userId: string,
        artist: string,
        title: string,
        albumTitle?: string,
        duration?: number,
        isrc?: string
    ): Promise<{ videoId: string; title: string; duration: number } | null> {
        const cleanArtist = this.sanitizeQuery(artist);
        const cleanTitle = this.sanitizeQuery(title);
        const shortQuery = `${cleanArtist} ${cleanTitle}`;
        const sourceTrack: YtMusicMatchInput = {
            artist: cleanArtist,
            title: cleanTitle,
            albumTitle,
            duration,
            isrc,
        };

        // --- Attempt 1: filtered search (songs only) ---
        try {
            const result = await this.search(userId, shortQuery, "songs");
            if (result.results?.length) {
                const match = this.selectBestCandidate(
                    sourceTrack,
                    result.results
                );
                if (match) return this.toMatchResult(match, title);
            }
        } catch {
            // Filtered search failed (HTTP 400) — fall through
        }

        // --- Attempt 2: unfiltered search, pick first song ---
        try {
            const result = await this.search(userId, shortQuery);
            const song = this.selectBestCandidate(
                sourceTrack,
                result.results || []
            );
            if (song) return this.toMatchResult(song, title);
        } catch {
            // Unfiltered search also failed — fall through
        }

        // --- Attempt 3: add album title for disambiguation ---
        if (albumTitle) {
            const cleanAlbum = this.sanitizeQuery(albumTitle);
            const longQuery = `${cleanArtist} ${cleanTitle} ${cleanAlbum}`;
            try {
                const result = await this.search(userId, longQuery);
                const song = this.selectBestCandidate(
                    { ...sourceTrack, albumTitle: cleanAlbum },
                    result.results || []
                );
                if (song) return this.toMatchResult(song, title);
            } catch (err) {
                logger.warn(
                    `[YTMusic] All search attempts failed for "${artist} - ${title}":`,
                    err
                );
            }
        }

        return null;
    }

    // ── Browse (unauthenticated) ─────────────────────────────────

    async getCharts(country: string = "US"): Promise<Record<string, any[]>> {
        const { data } = await this.client.get("/charts", {
            params: { country },
            timeout: 15_000,
        });
        return data;
    }

    async getMoodCategories(): Promise<
        Array<{ title: string; items: Array<{ title: string; params: string }> }>
    > {
        const { data } = await this.client.get("/moods-and-genres", {
            timeout: 15_000,
        });
        return data;
    }

    async getHome(
        limit: number = 6
    ): Promise<
        Array<{
            title: string;
            contents: Array<{
                playlistId?: string;
                videoId?: string;
                browseId?: string;
                title: string;
                thumbnailUrl: string | null;
                subtitle: string;
            }>;
        }>
    > {
        const { data } = await this.client.get("/home", {
            params: { limit },
            timeout: 15_000,
        });
        return data;
    }

    async getMoodPlaylists(
        params: string
    ): Promise<
        Array<{
            playlistId: string;
            title: string;
            thumbnailUrl: string | null;
            author: string;
        }>
    > {
        const { data } = await this.client.get("/mood-playlists", {
            params: { params },
            timeout: 15_000,
        });
        return data;
    }

    async getBrowsePlaylist(
        playlistId: string,
        limit: number = 100
    ): Promise<{
        id: string;
        title: string;
        description: string;
        trackCount: number;
        thumbnailUrl: string | null;
        tracks: Array<{
            videoId: string;
            title: string;
            artist: string;
            artists: string[];
            album: string;
            duration: number;
            thumbnailUrl: string | null;
        }>;
    }> {
        const { data } = await this.client.get(`/playlist/${playlistId}`, {
            params: { limit },
            timeout: 15_000,
        });
        return data;
    }
}

export const ytMusicService = new YouTubeMusicService();
