/**
 * TIDAL Streaming Service
 *
 * Communicates with the tidal-downloader Python sidecar for per-user
 * streaming. Each soundspan user connects their own TIDAL account via
 * device-code OAuth. Credentials are stored encrypted in UserSettings.
 *
 * This is the streaming counterpart of tidal.ts (which handles admin
 * download operations). Mirrors the youtubeMusic.ts service pattern.
 */

import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { encrypt } from "../utils/encryption";

// ── Types ──────────────────────────────────────────────────────────

export interface TidalStreamInfo {
    trackId: number;
    quality: string;
    acodec: string;
    content_type: string;
    bit_depth?: number;
    sample_rate?: number;
}

export interface TidalMatchResult {
    id: number;
    title: string;
    artist: string;
    duration: number;
    isrc?: string;
}

interface TidalMatchInput {
    artist: string;
    title: string;
    albumTitle?: string;
    duration?: number;
    isrc?: string;
}

// ── Service ────────────────────────────────────────────────────────

class TidalStreamingService {
    private client: AxiosInstance;
    private readonly sidecarUrl: string;
    private static readonly UNDESIRED_MISMATCH_TERMS = [
        "karaoke",
        "tribute",
        "cover",
        "soundalike",
        "sound alike",
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
        this.sidecarUrl =
            process.env.TIDAL_SIDECAR_URL || "http://127.0.0.1:8585";

        this.client = axios.create({
            baseURL: this.sidecarUrl,
            timeout: 30000,
            headers: { "Content-Type": "application/json" },
        });
    }

    // ── Health / availability ──────────────────────────────────────

    /**
     * Check whether the TIDAL sidecar is reachable.
     */
    async isAvailable(): Promise<boolean> {
        try {
            const res = await this.client.get("/health", { timeout: 5000 });
            return res.data?.status === "ok";
        } catch {
            return false;
        }
    }

    /**
     * Check if TIDAL streaming is enabled (admin has configured TIDAL).
     * We consider it enabled when the sidecar is healthy AND the admin
     * has `tidalEnabled` set in SystemSettings.
     */
    async isEnabled(): Promise<boolean> {
        try {
            const settings = await prisma.systemSettings.findUnique({
                where: { id: "default" },
            });
            return !!settings?.tidalEnabled;
        } catch {
            return false;
        }
    }

    // ── Per-user auth ──────────────────────────────────────────────

    /**
     * Check if a specific user has TIDAL credentials stored.
     */
    async getAuthStatus(
        userId: string
    ): Promise<{ authenticated: boolean; credentialsConfigured: boolean }> {
        try {
            const userSettings = await prisma.userSettings.findUnique({
                where: { userId },
            });
            const hasCredentials = !!userSettings?.tidalOAuthJson;
            return {
                authenticated: hasCredentials,
                credentialsConfigured: hasCredentials,
            };
        } catch {
            return { authenticated: false, credentialsConfigured: false };
        }
    }

    /**
     * Restore a user's OAuth credentials from the DB to the sidecar.
     * Called lazily on the first streaming request for a session.
     * If the sidecar refreshes an expired token, we update the DB.
     */
    async restoreOAuth(userId: string, oauthJson: string): Promise<boolean> {
        try {
            const creds = JSON.parse(oauthJson);
            const res = await this.client.post(
                `/user/auth/restore?user_id=${encodeURIComponent(userId)}`,
                {
                    access_token: creds.access_token,
                    refresh_token: creds.refresh_token,
                    user_id: creds.tidal_user_id || creds.user_id || "",
                    country_code: creds.country_code || "US",
                }
            );

            // If the sidecar refreshed the token, persist the new one
            if (res.data?.refreshed && res.data?.access_token) {
                const updatedCreds = {
                    ...creds,
                    access_token: res.data.access_token,
                    tidal_user_id: res.data.user_id || creds.tidal_user_id,
                    user_id: res.data.user_id || creds.user_id,
                    country_code: res.data.country_code || creds.country_code,
                };
                const updatedJson = JSON.stringify(updatedCreds);
                await prisma.userSettings.update({
                    where: { userId },
                    data: { tidalOAuthJson: encrypt(updatedJson) },
                });
                logger.info(
                    `[TIDAL-STREAM] Refreshed and persisted new token for user ${userId}`
                );
            }

            return res.data?.success === true;
        } catch (err: any) {
            logger.error(
                `[TIDAL-STREAM] Failed to restore OAuth for user ${userId}:`,
                err.response?.data || err.message
            );
            return false;
        }
    }

    /**
     * Clear a user's TIDAL session from the sidecar.
     */
    async clearAuth(userId: string): Promise<void> {
        try {
            await this.client.post(
                `/user/auth/clear?user_id=${encodeURIComponent(userId)}`
            );
        } catch (err: any) {
            logger.warn(
                `[TIDAL-STREAM] Failed to clear auth for user ${userId}:`,
                err.response?.data || err.message
            );
        }
    }

    // ── Device code auth flow ──────────────────────────────────────

    /**
     * Step 1 — initiate device-code OAuth.
     * Uses the same /auth/device endpoint as admin auth.
     */
    async initiateDeviceAuth(): Promise<{
        device_code: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete: string;
        expires_in: number;
        interval: number;
    }> {
        const res = await this.client.post("/auth/device");
        return res.data;
    }

    /**
     * Step 2 — poll for token completion.
     * Returns null while still pending, or the full token data on success.
     */
    async pollDeviceAuth(deviceCode: string): Promise<{
        access_token: string;
        refresh_token: string;
        user_id: string;
        country_code: string;
        username?: string;
    } | null> {
        try {
            const res = await this.client.post("/auth/token", {
                device_code: deviceCode,
            });
            return res.data;
        } catch (err: any) {
            if (err.response?.status === 428) return null; // still waiting
            throw err;
        }
    }

    // ── Search ─────────────────────────────────────────────────────

    /**
     * Search TIDAL using a user's session.
     */
    async search(
        userId: string,
        query: string
    ): Promise<any> {
        const res = await this.client.post(
            `/user/search?user_id=${encodeURIComponent(userId)}`,
            { query }
        );
        return res.data;
    }

    /**
     * Batch search for gap-fill matching.
     */
    async searchBatch(
        userId: string,
        queries: Array<{ query: string; filter?: string; limit?: number }>
    ): Promise<{ results: Array<{ query: string; results: any[] }> }> {
        const res = await this.client.post(
            `/user/search/batch?user_id=${encodeURIComponent(userId)}`,
            queries
        );
        return res.data;
    }

    // ── Stream ─────────────────────────────────────────────────────

    /**
     * Get stream metadata (quality, codec) for a track.
     */
    async getStreamInfo(
        userId: string,
        trackId: number,
        quality?: string
    ): Promise<TidalStreamInfo> {
        const params = new URLSearchParams({
            user_id: userId,
        });
        if (quality) params.set("quality", quality);

        const res = await this.client.get(
            `/user/stream-info/${trackId}?${params.toString()}`
        );
        return res.data;
    }

    /**
     * Get a proxied audio stream from the sidecar.
     * Returns an axios response configured for streaming.
     */
    async getStreamProxy(
        userId: string,
        trackId: number,
        quality?: string,
        rangeHeader?: string
    ): Promise<{
        data: any;
        headers: Record<string, string>;
        status: number;
    }> {
        const params = new URLSearchParams({
            user_id: userId,
        });
        if (quality) params.set("quality", quality);

        const headers: Record<string, string> = {};
        if (rangeHeader) headers["Range"] = rangeHeader;

        const res = await this.client.get(
            `/user/stream/${trackId}?${params.toString()}`,
            {
                responseType: "stream",
                headers,
                timeout: 300000, // 5 min for long streams
            }
        );

        return {
            data: res.data,
            headers: res.headers as Record<string, string>,
            status: res.status,
        };
    }

    // ── Match helpers ──────────────────────────────────────────────

    /**
     * Sanitize a search query (remove feat., brackets, etc.)
     */
    private sanitizeQuery(text: string): string {
        return text
            .replace(/\s*\(feat\.?.*?\)/gi, "")
            .replace(/\s*\[.*?\]/g, "")
            .replace(/\s*-\s*(remaster|deluxe|bonus|expanded|anniversary).*/gi, "")
            .trim();
    }

    private normaliseLoose(text: string): string {
        return this.sanitizeQuery(text || "")
            .toLowerCase()
            .replace(/['\u2019]/g, "")
            .replace(/[^a-z0-9]+/g, " ")
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

        for (const term of TidalStreamingService.UNDESIRED_MISMATCH_TERMS) {
            if (!this.hasTerm(expectedTitle, term) && this.hasTerm(candidateTitle, term)) {
                penalty += 0.3;
            }
        }

        for (const term of TidalStreamingService.VERSION_MISMATCH_TERMS) {
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
        if (diff <= 2) return 1;
        if (diff <= 5) return 0.92;
        if (diff <= 10) return 0.75;
        if (diff <= 20) return 0.45;
        if (diff <= 35) return 0.2;
        return 0;
    }

    private normaliseIsrc(isrc?: string): string | null {
        if (!isrc) return null;
        const compact = isrc.toUpperCase().replace(/[^A-Z0-9]/g, "");
        return compact.length >= 8 ? compact : null;
    }

    private scoreCandidate(
        track: TidalMatchInput,
        candidate: any
    ): number {
        const titleScore = this.textSimilarity(track.title, candidate?.title || "");
        const artistScore = this.textSimilarity(track.artist, candidate?.artist || "");
        const albumScore =
            track.albumTitle && candidate?.album?.title
                ? this.textSimilarity(track.albumTitle, candidate.album.title)
                : null;
        const durationScore = this.durationSimilarity(track.duration, candidate?.duration);

        const weightedSignals: Array<{ score: number; weight: number }> = [
            { score: titleScore, weight: 0.58 },
            { score: artistScore, weight: 0.32 },
        ];
        if (albumScore !== null) weightedSignals.push({ score: albumScore, weight: 0.08 });
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

        const expectedIsrc = this.normaliseIsrc(track.isrc);
        const candidateIsrc = this.normaliseIsrc(candidate?.isrc);
        if (expectedIsrc && candidateIsrc) {
            score += expectedIsrc === candidateIsrc ? 0.35 : -0.2;
        }

        if (
            this.normaliseCompact(track.title) ===
            this.normaliseCompact(candidate?.title || "")
        ) {
            score += 0.08;
        }

        if (
            this.normaliseCompact(track.artist) ===
            this.normaliseCompact(candidate?.artist || "")
        ) {
            score += 0.06;
        }

        return score;
    }

    private selectBestCandidate(
        track: TidalMatchInput,
        candidates: any[]
    ): any | null {
        if (!candidates.length) return null;

        const ranked = candidates
            .map((candidate) => ({
                candidate,
                score: this.scoreCandidate(track, candidate),
            }))
            .sort((a, b) => b.score - a.score);

        const best = ranked[0];
        const second = ranked[1];
        if (!best) return null;

        // Avoid forcing questionable matches when ranking is weak/ambiguous.
        if (best.score < 0.54) return null;
        if (second && best.score < 0.64 && best.score - second.score < 0.07) {
            return null;
        }

        return best.candidate;
    }

    private toMatchResult(match: any): TidalMatchResult {
        return {
            id: match.id,
            title: match.title,
            artist: match.artist,
            duration: match.duration,
            isrc: match.isrc,
        };
    }

    /**
     * Find a TIDAL match for a single track.
     */
    async findMatchForTrack(
        userId: string,
        artist: string,
        title: string,
        albumTitle?: string,
        duration?: number,
        isrc?: string
    ): Promise<TidalMatchResult | null> {
        try {
            const cleanArtist = this.sanitizeQuery(artist);
            const cleanTitle = this.sanitizeQuery(title);
            const query = `${cleanArtist} ${cleanTitle}`;

            const results = await this.search(userId, query);
            if (!results?.tracks?.length) return null;
            const match = this.selectBestCandidate(
                {
                    artist: cleanArtist,
                    title: cleanTitle,
                    albumTitle,
                    duration,
                    isrc,
                },
                results.tracks
            );
            return match ? this.toMatchResult(match) : null;
        } catch (err) {
            logger.debug(
                `[TIDAL-STREAM] Match failed for "${artist} - ${title}":`,
                err
            );
            return null;
        }
    }

    /**
     * Batch-match multiple tracks against TIDAL.
     * Uses searchBatch for performance.
     */
    async findMatchesForAlbum(
        userId: string,
        tracks: TidalMatchInput[]
    ): Promise<Array<TidalMatchResult | null>> {
        try {
            const queries = tracks.map((t) => ({
                query: `${this.sanitizeQuery(t.artist)} ${this.sanitizeQuery(t.title)}`,
                limit: 8,
            }));

            const { results } = await this.searchBatch(userId, queries);
            return results.map((r, idx) => {
                const sourceTrack = tracks[idx];
                const candidates = r?.results || [];
                if (!sourceTrack || !candidates.length) return null;

                const match = this.selectBestCandidate(sourceTrack, candidates);
                return match ? this.toMatchResult(match) : null;
            });
        } catch (err) {
            logger.error("[TIDAL-STREAM] Batch match failed:", err);
            return tracks.map(() => null);
        }
    }
}

// ── Singleton ──────────────────────────────────────────────────────

export const tidalStreamingService = new TidalStreamingService();
