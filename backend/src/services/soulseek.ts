/**
 * Direct Soulseek integration using slsk-client
 * Replaces the SLSKD Docker container with native Node.js connection
 */

import type { SlskClient } from "slsk-client";
import path from "path";
import { mkdir, rename, rm, stat } from "fs/promises";
import { getSystemSettings } from "../utils/systemSettings";
import { sessionLog } from "../utils/playlistLogger";
import { logger } from "../utils/logger";
import { safeResolvePath } from "../utils/safeResolvePath";
import { recordSoulseekAlbumFolderDecision } from "../metrics";
import {
    downloadAlbumBatch,
    type AlbumBatchTrack,
} from "./soulseek/albumFolderDownload";
import {
    createSoulseekClient,
    loginSoulseekClient,
    normalizeSearchResults,
    type SearchResult,
} from "./soulseek/slskSession";
import { categorizeDownloadError } from "./soulseek/downloadErrorCategory";
import { normalizeSoulseekTrackTitle } from "./soulseek/trackTitleNormalization";

export type { SearchResult } from "./soulseek/slskSession";

const log = logger.child("Soulseek");

export interface TrackMatch {
    username: string;
    filename: string;
    fullPath: string;
    size: number;
    bitRate?: number;
    quality: string;
    score: number;
    slots?: boolean;
    speed?: number;
}

export interface SearchTrackResult {
    found: boolean;
    bestMatch: TrackMatch | null;
    allMatches: TrackMatch[]; // All ranked matches for retry
}

interface DownloadDestination {
    finalPath: string;
    tempPath: string;
}

interface DownloadTrackResult {
    success: boolean;
    error?: string;
}

const INVALID_DOWNLOAD_DESTINATION = "Invalid download destination";
const DOWNLOAD_TIMED_OUT = Symbol("download-timed-out");
const AUDIO_EXTENSIONS = [
    ".flac",
    ".mp3",
    ".m4a",
    ".ogg",
    ".opus",
    ".wav",
    ".aac",
] as const;
class SoulseekService {
    private client: SlskClient | null = null;
    private connecting = false;
    private connectPromise: Promise<void> | null = null;
    private lastConnectAttempt = 0;
    private lastFailedAttempt = 0;
    private readonly RECONNECT_COOLDOWN = 30000; // 30 seconds between reconnect attempts
    private readonly FAILED_RECONNECT_COOLDOWN = 5000; // 5 seconds after failed attempt
    private readonly DOWNLOAD_TIMEOUT_INITIAL = 60000; // 1 minute for first attempt
    private readonly DOWNLOAD_TIMEOUT_RETRY = 30000; // 30 seconds for retries
    private readonly MAX_DOWNLOAD_RETRIES = 5; // Try up to 5 different users (more retries with shorter timeouts)

    // Circuit breaker for failing users
    private failedUsers = new Map<
        string,
        { failures: number; lastFailure: Date }
    >();
    private readonly FAILURE_THRESHOLD = 3; // Block after 3 failures
    private readonly FAILURE_WINDOW = 300000; // 5 minute window

    // Concurrency tracking
    private activeDownloads = 0;
    private maxConcurrentDownloads = 0;

    // Connection health tracking
    private connectedAt: Date | null = null;
    private lastSuccessfulSearch: Date | null = null;
    private consecutiveEmptySearches = 0;
    private totalSearches = 0;
    private totalSuccessfulSearches = 0;
    private readonly MAX_CONSECUTIVE_EMPTY = 3; // After 3 empty searches, force reconnect

    constructor() {
        // Start periodic cleanup of failedUsers (every 5 minutes)
        const cleanupTimer = setInterval(
            () => this.cleanupFailedUsers(),
            5 * 60 * 1000,
        );
        cleanupTimer.unref?.();
    }

    /**
     * Normalize track title for better search results
     * Extracts main song name by removing live performance details, remasters, etc.
     * e.g. "Santa Claus Is Comin' to Town (Live at C.W. Post College, NY - Dec 1975)" → "Santa Claus Is Comin' to Town"
     */
    private normalizeTrackTitle(title: string): string {
        return normalizeSoulseekTrackTitle(title);
    }

    /**
     * Connect to Soulseek network
     */
    async connect(): Promise<void> {
        const settings = await getSystemSettings();

        if (!settings?.soulseekUsername || !settings?.soulseekPassword) {
            throw new Error("Soulseek credentials not configured");
        }

        log.info(`Connecting to Soulseek as ${settings.soulseekUsername}`);
        sessionLog("SOULSEEK", `Connecting as ${settings.soulseekUsername}...`);

        const client = createSoulseekClient();
        this.attachClientListeners(client);
        try {
            await loginSoulseekClient(
                client,
                settings.soulseekUsername,
                settings.soulseekPassword,
            );
        } catch (error) {
            log.error("Soulseek connection failed", error);
            sessionLog(
                "SOULSEEK",
                "Connection failed (detail in server log)",
                "ERROR",
            );
            throw error;
        }

        this.client = client;
        this.connectedAt = new Date();
        this.consecutiveEmptySearches = 0;
        log.info("Connected to Soulseek network");
        sessionLog("SOULSEEK", "Connected to Soulseek network");
    }

    private attachClientListeners(client: SlskClient): void {
        client.on("server-error", (error) => {
            log.error("Soulseek client connection error", error);
            sessionLog(
                "SOULSEEK",
                "Client connection error (detail in server log)",
                "ERROR",
            );
        });
        client.on("listen-error", (error) => {
            log.warn(
                "Soulseek incoming peer port could not be used; peers that must connect to us may fail",
                error,
            );
        });
        client.on("peer-error", (error, user) => {
            log.debug("Soulseek peer connection error", { user, error });
        });
        client.on("server-disconnect", () => {
            this.handleClientSessionLoss(
                client,
                "Soulseek server disconnected",
            );
        });
        client.on("relogged", () => {
            this.handleClientSessionLoss(
                client,
                "Another client logged in with the same Soulseek account",
            );
        });
    }

    private handleClientSessionLoss(client: SlskClient, message: string): void {
        if (this.client !== client) return;
        log.warn(message);
        sessionLog("SOULSEEK", message, "WARN");
        this.forceDisconnect();
    }

    /**
     * Force disconnect and clear client state
     */
    private forceDisconnect(): void {
        const uptime = this.connectedAt
            ? Math.round((Date.now() - this.connectedAt.getTime()) / 1000)
            : 0;
        sessionLog(
            "SOULSEEK",
            `Force disconnecting (was connected for ${uptime}s)`,
            "WARN",
        );
        this.teardownClient();
        this.client = null;
        this.connectedAt = null;
        this.lastConnectAttempt = 0; // Allow immediate reconnect
    }

    private teardownClient(): void {
        try {
            if (!this.client) return;
            this.client.removeAllListeners();
            this.client.destroy();
        } catch (teardownError) {
            log.warn(
                "Client teardown failed; continuing state reset",
                teardownError,
            );
            sessionLog(
                "SOULSEEK",
                "Client teardown failed; continuing state reset",
                "WARN",
            );
        }
    }

    /**
     * Ensure we have an active connection
     * @param force - If true, disconnect and reconnect even if client exists
     */
    private async ensureConnected(force: boolean = false): Promise<void> {
        if (force && this.client) {
            this.forceDisconnect();
        }

        if (this.client) {
            return;
        }

        // Prevent multiple simultaneous connection attempts
        if (this.connecting && this.connectPromise) {
            return this.connectPromise;
        }

        // Short cooldown after FAILED attempts (5s), longer after SUCCESS (30s)
        const now = Date.now();

        // If last successful connection was recent, respect cooldown
        if (
            !force &&
            this.lastConnectAttempt > 0 &&
            now - this.lastConnectAttempt < this.RECONNECT_COOLDOWN
        ) {
            throw new Error(
                "Connection cooldown - please wait before retrying",
            );
        }

        // If last FAILED attempt was very recent (5s), wait briefly
        if (
            !force &&
            this.lastFailedAttempt > 0 &&
            now - this.lastFailedAttempt < this.FAILED_RECONNECT_COOLDOWN
        ) {
            throw new Error(
                "Connection recently failed - please wait before retrying",
            );
        }

        this.connecting = true;

        this.connectPromise = this.connect()
            .then(() => {
                // Only set lastConnectAttempt on SUCCESS
                this.lastConnectAttempt = Date.now();
                this.lastFailedAttempt = 0; // Clear failed tracking
            })
            .catch((err) => {
                // Track failed attempt separately (shorter cooldown)
                this.lastFailedAttempt = Date.now();
                throw err;
            })
            .finally(() => {
                this.connecting = false;
                this.connectPromise = null;
            });

        return this.connectPromise;
    }

    /**
     * Check if connected to Soulseek
     */
    isConnected(): boolean {
        return this.client !== null;
    }

    /**
     * Check if Soulseek is available (credentials configured)
     */
    async isAvailable(): Promise<boolean> {
        try {
            const settings = await getSystemSettings();
            return !!(settings?.soulseekUsername && settings?.soulseekPassword);
        } catch {
            return false;
        }
    }

    /**
     * Get connection status
     */
    async getStatus(): Promise<{
        connected: boolean;
        username: string | null;
    }> {
        const settings = await getSystemSettings();
        return {
            connected: this.client !== null,
            username: settings?.soulseekUsername || null,
        };
    }

    /**
     * Search for a track and return the best match plus alternatives for retry
     * @param timeoutMs - Search timeout in milliseconds (default 45000 for downloads, use 15000 for UI)
     */
    async searchTrack(
        artistName: string,
        trackTitle: string,
        isRetry: boolean = false,
        timeoutMs: number = 45000,
    ): Promise<SearchTrackResult> {
        this.totalSearches++;
        const searchId = this.totalSearches;
        const client = await this.getSearchClient(searchId);
        if (!client) return this.emptySearchResult();
        const query = this.buildSearchQuery(
            artistName,
            trackTitle,
            searchId,
            timeoutMs,
        );
        const searchStartTime = Date.now();
        let rawResults: unknown;
        try {
            rawResults = await client.search({
                req: query,
                timeout: timeoutMs,
            });
            this.logRawSearchResults(searchId, rawResults);
        } catch (error) {
            this.logRawSearchResults(searchId, null);
            return this.handleSearchFailure(
                error,
                artistName,
                trackTitle,
                searchId,
                Date.now() - searchStartTime,
                isRetry,
            );
        }
        return this.handleSearchResults(
            rawResults,
            artistName,
            trackTitle,
            searchId,
            Date.now() - searchStartTime,
            isRetry,
        );
    }

    private async handleSearchResults(
        rawResults: unknown,
        artistName: string,
        trackTitle: string,
        searchId: number,
        searchDuration: number,
        isRetry: boolean,
    ): Promise<SearchTrackResult> {
        try {
            const results = normalizeSearchResults(rawResults);
            if (results.length === 0) {
                return await this.handleEmptySearch(
                    artistName,
                    trackTitle,
                    searchId,
                    searchDuration,
                    isRetry,
                );
            }
            return this.selectSearchResults(
                results,
                artistName,
                trackTitle,
                searchId,
                searchDuration,
            );
        } catch (error) {
            log.error("Soulseek search result handling failed", {
                searchId,
                searchDuration,
                error,
            });
            return this.emptySearchResult();
        }
    }

    private async getSearchClient(
        searchId: number,
    ): Promise<SlskClient | null> {
        try {
            await this.ensureConnected();
        } catch (error) {
            log.error("Soulseek search connection failed", { searchId, error });
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Connection failed (detail in server log)`,
                "ERROR",
            );
            return null;
        }

        const client = this.client;
        if (!client) {
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Client not connected`,
                "ERROR",
            );
            return null;
        }
        return client;
    }

    private buildSearchQuery(
        artistName: string,
        trackTitle: string,
        searchId: number,
        timeoutMs: number,
    ): string {
        const normalizedTitle = this.normalizeTrackTitle(trackTitle);
        const query = `${artistName} ${normalizedTitle}`.trim();
        this.logSearchRequest(
            searchId,
            query,
            trackTitle,
            normalizedTitle,
            timeoutMs,
        );
        return query;
    }

    private emptySearchResult(): SearchTrackResult {
        return { found: false, bestMatch: null, allMatches: [] };
    }

    private logSearchRequest(
        searchId: number,
        query: string,
        trackTitle: string,
        normalizedTitle: string,
        timeoutMs: number,
    ): void {
        if (normalizedTitle !== trackTitle) {
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Normalized: "${trackTitle}" → "${normalizedTitle}"`,
            );
        }
        const connectionAge = this.connectedAt
            ? Math.round((Date.now() - this.connectedAt.getTime()) / 1000)
            : 0;
        sessionLog(
            "SOULSEEK",
            `[Search #${searchId}] Searching: "${query}" (timeout ${timeoutMs}ms, connected ${connectionAge}s, ${this.consecutiveEmptySearches} consecutive empty)`,
        );
    }

    private logRawSearchResults(searchId: number, rawResults: unknown): void {
        const count = rawResults
            ? Array.isArray(rawResults)
                ? rawResults.length
                : "not an array"
            : "null";
        sessionLog(
            "SOULSEEK",
            `[Search #${searchId}] Raw results received: ${count}`,
        );
    }

    private async handleSearchFailure(
        error: unknown,
        artistName: string,
        trackTitle: string,
        searchId: number,
        searchDuration: number,
        isRetry: boolean,
    ): Promise<SearchTrackResult> {
        log.error("Soulseek search failed", {
            searchId,
            searchDuration,
            error,
        });
        sessionLog(
            "SOULSEEK",
            `[Search #${searchId}] Search failed after ${searchDuration}ms (detail in server log)`,
            "ERROR",
        );
        this.consecutiveEmptySearches++;
        if (isRetry || this.consecutiveEmptySearches < 2) {
            return this.emptySearchResult();
        }
        sessionLog(
            "SOULSEEK",
            `[Search #${searchId}] Search error detected, forcing reconnect and retry...`,
            "WARN",
        );
        this.forceDisconnect();
        return this.searchTrack(artistName, trackTitle, true);
    }

    private async handleEmptySearch(
        artistName: string,
        trackTitle: string,
        searchId: number,
        searchDuration: number,
        isRetry: boolean,
    ): Promise<SearchTrackResult> {
        this.consecutiveEmptySearches++;
        sessionLog(
            "SOULSEEK",
            `[Search #${searchId}] No results found after ${searchDuration}ms (${this.consecutiveEmptySearches}/${this.MAX_CONSECUTIVE_EMPTY} consecutive empty)`,
            "WARN",
        );
        if (
            isRetry ||
            this.consecutiveEmptySearches < this.MAX_CONSECUTIVE_EMPTY
        ) {
            return this.emptySearchResult();
        }
        sessionLog(
            "SOULSEEK",
            `[Search #${searchId}] Too many consecutive empty searches, forcing reconnect and retry...`,
            "WARN",
        );
        this.forceDisconnect();
        return this.searchTrack(artistName, trackTitle, true);
    }

    private selectSearchResults(
        results: SearchResult[],
        artistName: string,
        trackTitle: string,
        searchId: number,
        searchDuration: number,
    ): SearchTrackResult {
        this.consecutiveEmptySearches = 0;
        this.lastSuccessfulSearch = new Date();
        this.totalSuccessfulSearches++;
        const successRate = Math.round(
            (this.totalSuccessfulSearches / this.totalSearches) * 100,
        );
        sessionLog(
            "SOULSEEK",
            `[Search #${searchId}] Found ${results.length} results in ${searchDuration}ms (success rate: ${successRate}%)`,
        );
        const audioFiles = results.filter((result) =>
            AUDIO_EXTENSIONS.some((extension) =>
                result.file.toLowerCase().endsWith(extension),
            ),
        );
        if (audioFiles.length === 0) {
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] No audio files in ${results.length} results`,
                "WARN",
            );
            return this.emptySearchResult();
        }
        return this.rankSearchResults(
            audioFiles,
            artistName,
            trackTitle,
            searchId,
        );
    }

    private rankSearchResults(
        audioFiles: SearchResult[],
        artistName: string,
        trackTitle: string,
        searchId: number,
    ): SearchTrackResult {
        const rankedMatches = this.rankAllResults(
            audioFiles,
            artistName,
            trackTitle,
        );
        if (rankedMatches.length === 0) {
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] No suitable match found from ${audioFiles.length} audio files`,
                "WARN",
            );
            return this.emptySearchResult();
        }

        const best = rankedMatches[0];
        sessionLog(
            "SOULSEEK",
            `[Search #${searchId}] ✓ MATCH: ${best.filename} | ${best.quality} | ${Math.round(best.size / 1024 / 1024)}MB | User: ${best.username} | Score: ${best.score}`,
        );
        sessionLog(
            "SOULSEEK",
            `[Search #${searchId}] Found ${rankedMatches.length} alternative sources for retry`,
        );
        return { found: true, bestMatch: best, allMatches: rankedMatches };
    }

    /**
     * Check if a user should be blocked due to recent failures
     */
    private isUserBlocked(username: string): boolean {
        const record = this.failedUsers.get(username);
        if (!record) return false;

        // Clear old failures outside the window
        if (Date.now() - record.lastFailure.getTime() > this.FAILURE_WINDOW) {
            this.failedUsers.delete(username);
            return false;
        }

        return record.failures >= this.FAILURE_THRESHOLD;
    }

    /**
     * Periodically clean up expired entries from failedUsers Map
     * Called every 5 minutes to prevent unbounded memory growth
     */
    private cleanupFailedUsers(): void {
        const now = Date.now();
        let cleaned = 0;
        for (const [username, record] of this.failedUsers.entries()) {
            if (now - record.lastFailure.getTime() > this.FAILURE_WINDOW) {
                this.failedUsers.delete(username);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            sessionLog(
                "SOULSEEK",
                `Cleaned up ${cleaned} expired user failure records`,
            );
        }
    }

    /**
     * Record a user failure for circuit breaker
     */
    private recordUserFailure(username: string): void {
        const record = this.failedUsers.get(username) || {
            failures: 0,
            lastFailure: new Date(),
        };
        record.failures++;
        record.lastFailure = new Date();
        this.failedUsers.set(username, record);

        if (record.failures >= this.FAILURE_THRESHOLD) {
            sessionLog(
                "SOULSEEK",
                `User ${username} blocked: ${
                    record.failures
                } failures in ${Math.round(
                    this.FAILURE_WINDOW / 60000,
                )}min window`,
                "WARN",
            );
        }
    }

    private sanitizeDownloadComponent(name: string): string | null {
        const sanitized = name.replace(/[<>:"/\\|?*]/g, "_").trim();
        if (!sanitized || sanitized === "." || sanitized === "..") {
            return null;
        }
        return sanitized;
    }

    private resolveDownloadDestination(
        musicPath: string,
        artistName: string,
        albumName: string,
        filename: string,
    ): DownloadDestination | null {
        const artist = this.sanitizeDownloadComponent(artistName);
        const album = this.sanitizeDownloadComponent(albumName);
        const file = this.sanitizeDownloadComponent(filename);
        if (!artist || !album || !file) {
            return null;
        }

        const relativePath = path.join(artist, album, file);
        const singlesRoot = path.resolve(musicPath, "Singles");
        const finalPath = safeResolvePath(singlesRoot, relativePath);
        const tempPath = safeResolvePath(singlesRoot, `${relativePath}.part`);
        if (!finalPath || !tempPath) {
            return null;
        }
        return { finalPath, tempPath };
    }

    /**
     * Rank all search results and return sorted matches (best first)
     * Filters out matches below minimum score threshold and blocked users
     */
    private rankAllResults(
        results: SearchResult[],
        artistName: string,
        trackTitle: string,
    ): TrackMatch[] {
        // Normalize search terms for matching
        const normalizedArtist = artistName
            .toLowerCase()
            .replace(/^the\s+/, "") // Remove leading "the"
            .replace(/\s*&\s*/g, " and ")
            .replace(/[^a-z0-9\s]/g, "");
        const normalizedTitle = trackTitle
            .toLowerCase()
            .replace(/\s*&\s*/g, " and ")
            .replace(/[^a-z0-9\s]/g, "")
            .replace(/^\d+\s*[-.]?\s*/, ""); // Remove leading track numbers

        // Get first word of artist for fuzzy matching
        const artistWords = normalizedArtist.split(/\s+/);
        const artistFirstWord = artistWords[0];
        // If first word is short (e.g. "of", "a"), try second word too
        const artistSecondWord =
            artistWords.length > 1 && artistFirstWord.length < 3
                ? artistWords[1]
                : "";
        // Get first few significant words of title
        const titleWords = normalizedTitle
            .split(/\s+/)
            .filter((w) => w.length > 2)
            .slice(0, 3);

        // Filter out blocked users first
        const availableResults = results.filter(
            (file) => !this.isUserBlocked(file.user),
        );

        const scored = availableResults.map((file) => {
            const filename = (file.file || "").toLowerCase();
            const normalizedFilename = filename.replace(/[^a-z0-9]/g, "");
            const shortFilename = filename.split(/[/\\]/).pop() || filename;

            let score = 0;

            // Strongly prefer files with slots available (+40)
            if (file.slots) score += 40;

            // Prefer high-speed peers
            if (file.speed > 1000000)
                score += 15; // >1MB/s
            else if (file.speed > 500000) score += 5; // >500KB/s

            // Check if filename contains artist (full or first word)
            if (
                normalizedFilename.includes(normalizedArtist.replace(/\s/g, ""))
            ) {
                score += 50; // Full artist match
            } else if (
                (artistFirstWord.length >= 3 &&
                    normalizedFilename.includes(artistFirstWord)) ||
                (artistSecondWord &&
                    normalizedFilename.includes(artistSecondWord))
            ) {
                score += 35; // Partial artist match (first/second word)
            }

            // Check if filename contains title (full or partial)
            const titleNoSpaces = normalizedTitle.replace(/\s/g, "");
            if (
                titleNoSpaces.length > 0 &&
                normalizedFilename.includes(titleNoSpaces)
            ) {
                score += 50; // Full title match
            } else if (
                titleWords.length > 0 &&
                titleWords.every((w) => normalizedFilename.includes(w))
            ) {
                score += 40; // All significant title words match
            } else if (
                titleWords.length > 0 &&
                titleWords.some(
                    (w) => w.length > 4 && normalizedFilename.includes(w),
                )
            ) {
                score += 25; // At least one significant title word matches
            }

            // Prefer FLAC (+30)
            if (filename.endsWith(".flac")) score += 30;
            // Then high-quality MP3 (+20 for 320, +10 for 256)
            else if (filename.endsWith(".mp3") && (file.bitrate || 0) >= 320)
                score += 20;
            else if (filename.endsWith(".mp3") && (file.bitrate || 0) >= 256)
                score += 10;

            // Prefer reasonable file sizes
            const sizeMB = (file.size || 0) / 1024 / 1024;
            if (sizeMB >= 3 && sizeMB <= 100) score += 10;
            if (sizeMB >= 10 && sizeMB <= 50) score += 5; // FLAC range

            // Prefer higher speed peers
            if (file.speed > 1000000) score += 5; // >1MB/s

            const quality = this.getQualityFromFilename(
                file.file,
                file.bitrate,
            );

            return {
                username: file.user,
                filename: shortFilename,
                fullPath: file.file,
                size: file.size,
                bitRate: file.bitrate,
                quality,
                score,
                slots: file.slots,
                speed: file.speed,
            };
        });

        // Sort by score descending, filter by minimum threshold
        // Score 20+ is acceptable: slots(20) OR artist match(35-50) OR title match(25-50)
        return scored
            .filter((m) => m.score >= 20)
            .sort((a, b) => b.score - a.score)
            .slice(0, 10); // Keep top 10 for retry purposes
    }

    /**
     * Download a track to a temporary file and atomically finalize it.
     * @param match - Remote Soulseek match to download.
     * @param destPath - Final destination path.
     * @param attemptNumber - Zero-based retry number used for timeout selection.
     * @param tempPath - Prevalidated temporary path for the incomplete file.
     */
    async downloadTrack(
        match: TrackMatch,
        destPath: string,
        attemptNumber: number = 0,
        tempPath: string = `${destPath}.part`,
    ): Promise<DownloadTrackResult> {
        this.activeDownloads++;
        this.maxConcurrentDownloads = Math.max(
            this.maxConcurrentDownloads,
            this.activeDownloads,
        );
        sessionLog(
            "SOULSEEK",
            `Active downloads: ${this.activeDownloads}/${this.maxConcurrentDownloads} max`,
        );
        try {
            return await this.prepareDownload(
                match,
                destPath,
                attemptNumber,
                tempPath,
            );
        } finally {
            this.activeDownloads--;
        }
    }

    private async prepareDownload(
        match: TrackMatch,
        destPath: string,
        attemptNumber: number,
        tempPath: string,
    ): Promise<DownloadTrackResult> {
        const timeout =
            attemptNumber === 0
                ? this.DOWNLOAD_TIMEOUT_INITIAL
                : this.DOWNLOAD_TIMEOUT_RETRY;
        try {
            await this.ensureConnected();
        } catch (error) {
            return { success: false, error: this.toError(error).message };
        }

        const client = this.client;
        if (!client) {
            return { success: false, error: "Not connected" };
        }

        const directoryError = await this.createDestinationDirectory(destPath);
        if (directoryError) return directoryError;
        sessionLog(
            "SOULSEEK",
            `Downloading from ${match.username}: ${match.filename}`,
        );
        return this.executeDownload(client, match, destPath, tempPath, timeout);
    }

    private async createDestinationDirectory(
        destPath: string,
    ): Promise<DownloadTrackResult | null> {
        const destDir = path.dirname(destPath);
        try {
            await mkdir(destDir, { recursive: true });
            return null;
        } catch (error) {
            const message = this.toError(error).message;
            log.error("Failed to create Soulseek destination directory", {
                destDir,
                error,
            });
            sessionLog(
                "SOULSEEK",
                "Failed to create directory (detail in server log)",
                "ERROR",
            );
            return {
                success: false,
                error: `Cannot create destination directory: ${message}`,
            };
        }
    }

    private async executeDownload(
        client: SlskClient,
        match: TrackMatch,
        destPath: string,
        tempPath: string,
        timeout: number,
    ): Promise<DownloadTrackResult> {
        const controller = new AbortController();
        let timeoutId: NodeJS.Timeout | undefined;
        const deadline = new Promise<typeof DOWNLOAD_TIMED_OUT>((resolve) => {
            timeoutId = setTimeout(() => {
                resolve(DOWNLOAD_TIMED_OUT);
                controller.abort();
            }, timeout);
        });

        let download: ReturnType<SlskClient["download"]>;
        try {
            download = client.download({
                user: match.username,
                file: match.fullPath,
                size: match.size,
                path: tempPath,
                signal: controller.signal,
            });
        } catch (error) {
            if (timeoutId) clearTimeout(timeoutId);
            return this.handleSynchronousDownloadError(error, match);
        }

        try {
            const outcome = await Promise.race([
                Promise.resolve(download),
                deadline,
            ]);
            if (timeoutId) clearTimeout(timeoutId);
            if (outcome === DOWNLOAD_TIMED_OUT) {
                return this.handleDownloadTimeout(match, tempPath, timeout);
            }
            return this.finalizeDownload(match, destPath, tempPath);
        } catch (error) {
            if (timeoutId) clearTimeout(timeoutId);
            return this.handleDownloadRejection(error, match);
        }
    }

    private handleDownloadTimeout(
        match: TrackMatch,
        tempPath: string,
        timeout: number,
    ): DownloadTrackResult {
        sessionLog(
            "SOULSEEK",
            `Download timed out after ${timeout / 1000}s: ${match.filename}`,
            "WARN",
        );
        this.recordUserFailure(match.username);
        void rm(tempPath, { force: true }).catch(() => {
            // Ignore cleanup errors
        });
        return { success: false, error: "Download timed out" };
    }

    private handleDownloadRejection(
        reason: unknown,
        match: TrackMatch,
    ): DownloadTrackResult {
        const error = this.toError(reason);
        const errorInfo = categorizeDownloadError(error);
        log.error("Soulseek download failed", {
            username: match.username,
            filename: match.filename,
            errorType: errorInfo.type,
            error,
        });
        sessionLog(
            "SOULSEEK",
            "Download failed (detail in server log)",
            "ERROR",
        );
        if (errorInfo.skipUser) this.recordUserFailure(match.username);
        return { success: false, error: error.message };
    }

    private handleSynchronousDownloadError(
        reason: unknown,
        match: TrackMatch,
    ): DownloadTrackResult {
        const error = this.toError(reason);
        log.error("Soulseek download threw synchronously", {
            username: match.username,
            filename: match.filename,
            error,
        });
        sessionLog(
            "SOULSEEK",
            "Download failed synchronously (detail in server log)",
            "ERROR",
        );
        return { success: false, error: `Synchronous error: ${error.message}` };
    }

    private async finalizeDownload(
        match: TrackMatch,
        destPath: string,
        tempPath: string,
    ): Promise<DownloadTrackResult> {
        try {
            const stats = await stat(tempPath);
            await rename(tempPath, destPath);
            sessionLog(
                "SOULSEEK",
                `✓ Downloaded: ${match.filename} (${Math.round(stats.size / 1024)}KB)`,
            );
            return { success: true };
        } catch (error) {
            await rm(tempPath, { force: true }).catch(() => {
                // Ignore cleanup errors
            });
            log.error("Failed to finalize Soulseek download", {
                destPath,
                tempPath,
                error,
            });
            sessionLog("SOULSEEK", "File not found after download", "ERROR");
            return { success: false, error: "File not written" };
        }
    }

    private toError(reason: unknown): Error {
        return reason instanceof Error ? reason : new Error(String(reason));
    }

    /**
     * Search and download a track in one operation
     * Includes retry logic - tries multiple users if first fails/times out
     */
    async searchAndDownload(
        artistName: string,
        trackTitle: string,
        albumName: string,
        musicPath: string,
    ): Promise<{ success: boolean; filePath?: string; error?: string }> {
        // Search for the track
        const searchResult = await this.searchTrack(artistName, trackTitle);

        if (!searchResult.found || searchResult.allMatches.length === 0) {
            return { success: false, error: "No suitable match found" };
        }

        const errors: string[] = [];

        // Try up to MAX_DOWNLOAD_RETRIES different users
        const matchesToTry = searchResult.allMatches.slice(
            0,
            this.MAX_DOWNLOAD_RETRIES,
        );

        for (let attempt = 0; attempt < matchesToTry.length; attempt++) {
            const match = matchesToTry[attempt];

            sessionLog(
                "SOULSEEK",
                `Attempt ${attempt + 1}/${matchesToTry.length}: Trying ${
                    match.username
                } for ${match.filename}`,
            );

            const destination = this.resolveDownloadDestination(
                musicPath,
                artistName,
                albumName,
                match.filename,
            );
            if (!destination) {
                return { success: false, error: INVALID_DOWNLOAD_DESTINATION };
            }

            // Download with timeout
            const downloadResult = await this.downloadTrack(
                match,
                destination.finalPath,
                0,
                destination.tempPath,
            );

            if (downloadResult.success) {
                if (attempt > 0) {
                    sessionLog(
                        "SOULSEEK",
                        `✓ Success on attempt ${attempt + 1} (user: ${
                            match.username
                        })`,
                    );
                }
                return { success: true, filePath: destination.finalPath };
            }

            // Log failure and try next user
            const errorMsg = downloadResult.error || "Unknown error";
            errors.push(`${match.username}: ${errorMsg}`);
            log.warn("Soulseek download attempt failed", {
                attempt: attempt + 1,
                username: match.username,
                filename: match.filename,
                error: errorMsg,
            });
            sessionLog(
                "SOULSEEK",
                `Attempt ${attempt + 1} failed, trying next user (detail in server log)`,
                "WARN",
            );
        }

        // All attempts failed
        sessionLog(
            "SOULSEEK",
            `All ${matchesToTry.length} download attempts failed for: ${artistName} - ${trackTitle}`,
            "ERROR",
        );
        return {
            success: false,
            error: `All ${matchesToTry.length} attempts failed: ${errors.join(
                "; ",
            )}`,
        };
    }

    /**
     * Download best match from pre-searched results
     * Used when search was already done separately (e.g., for retry functionality)
     */
    async downloadBestMatch(
        artistName: string,
        trackTitle: string,
        albumName: string,
        allMatches: TrackMatch[],
        musicPath: string,
    ): Promise<{ success: boolean; filePath?: string; error?: string }> {
        if (allMatches.length === 0) {
            return { success: false, error: "No matches provided" };
        }

        const errors: string[] = [];

        // Try up to MAX_DOWNLOAD_RETRIES different users
        const matchesToTry = allMatches.slice(0, this.MAX_DOWNLOAD_RETRIES);

        for (let attempt = 0; attempt < matchesToTry.length; attempt++) {
            const match = matchesToTry[attempt];

            sessionLog(
                "SOULSEEK",
                `[${artistName} - ${trackTitle}] Attempt ${attempt + 1}/${
                    matchesToTry.length
                }: Trying ${match.username}`,
            );

            const destination = this.resolveDownloadDestination(
                musicPath,
                artistName,
                albumName,
                match.filename,
            );
            if (!destination) {
                return { success: false, error: INVALID_DOWNLOAD_DESTINATION };
            }

            // Download with timeout
            const downloadResult = await this.downloadTrack(
                match,
                destination.finalPath,
                0,
                destination.tempPath,
            );

            if (downloadResult.success) {
                if (attempt > 0) {
                    sessionLog(
                        "SOULSEEK",
                        `✓ Success on attempt ${attempt + 1} (user: ${
                            match.username
                        })`,
                    );
                }
                return { success: true, filePath: destination.finalPath };
            }

            // Log failure and try next user
            const errorMsg = downloadResult.error || "Unknown error";
            errors.push(`${match.username}: ${errorMsg}`);
            log.warn("Soulseek download attempt failed", {
                attempt: attempt + 1,
                username: match.username,
                filename: match.filename,
                error: errorMsg,
            });
            sessionLog(
                "SOULSEEK",
                `Attempt ${attempt + 1} failed (detail in server log)`,
                "WARN",
            );
        }

        // All attempts failed
        return {
            success: false,
            error: `All ${matchesToTry.length} attempts failed: ${errors.join(
                "; ",
            )}`,
        };
    }

    /**
     * Search and download multiple tracks in parallel
     * - Searches run fully parallel (fast, 15s timeout each)
     * - Downloads limited to concurrency of 4 to prevent network saturation
     */
    async searchAndDownloadBatch(
        tracks: AlbumBatchTrack[],
        musicPath: string,
        concurrency: number = 4,
        _expectedTrackCount: number = tracks.length,
    ): Promise<{
        successful: number;
        failed: number;
        files: string[];
        errors: string[];
    }> {
        // Phase 1: Search all tracks in parallel (searches are fast)
        sessionLog(
            "SOULSEEK",
            `Searching for ${tracks.length} tracks in parallel...`,
        );
        const searchPromises = tracks.map((track) =>
            this.searchTrack(track.artist, track.title).then((result) => ({
                track,
                result,
            })),
        );
        const searchResults = await Promise.all(searchPromises);

        // Phase 2: Queue downloads with concurrency limit
        const tracksWithMatches = searchResults.filter(
            (r) => r.result.found && r.result.allMatches.length > 0,
        );
        sessionLog(
            "SOULSEEK",
            `Found matches for ${tracksWithMatches.length}/${tracks.length} tracks, downloading with concurrency ${concurrency}...`,
        );

        const results = await downloadAlbumBatch(searchResults, concurrency, {
            downloadWithRetry: (track, matches) =>
                this.downloadWithRetry(
                    track.artist,
                    track.title,
                    track.album,
                    matches,
                    musicPath,
                ),
            formatError: (track, result) =>
                `${track.artist} - ${track.title}: ${result.error || "Unknown error"}`,
            recordDecision: (decision) => {
                recordSoulseekAlbumFolderDecision(
                    decision.outcome,
                    decision.coherenceScore,
                );
                log.debug("Album folder selection decision", {
                    outcome: decision.outcome,
                    username: decision.username,
                    folderName: decision.folderName,
                    coherenceScore: decision.coherenceScore,
                    compositeScore: decision.compositeScore,
                    candidateCount: decision.candidateCount,
                });
            },
        });

        sessionLog(
            "SOULSEEK",
            `Batch complete: ${results.successful} succeeded, ${results.failed} failed`,
        );

        return results;
    }

    /**
     * Download with retry logic (extracted for use by batch downloads)
     */
    private async downloadWithRetry(
        artistName: string,
        trackTitle: string,
        albumName: string,
        allMatches: TrackMatch[],
        musicPath: string,
    ): Promise<{ success: boolean; filePath?: string; error?: string }> {
        const errors: string[] = [];
        const matchesToTry = allMatches.slice(0, this.MAX_DOWNLOAD_RETRIES);

        for (let attempt = 0; attempt < matchesToTry.length; attempt++) {
            const match = matchesToTry[attempt];

            sessionLog(
                "SOULSEEK",
                `[${artistName} - ${trackTitle}] Attempt ${attempt + 1}/${
                    matchesToTry.length
                }: Trying ${match.username}`,
            );

            const destination = this.resolveDownloadDestination(
                musicPath,
                artistName,
                albumName,
                match.filename,
            );
            if (!destination) {
                return { success: false, error: INVALID_DOWNLOAD_DESTINATION };
            }

            const result = await this.downloadTrack(
                match,
                destination.finalPath,
                attempt,
                destination.tempPath,
            );
            if (result.success) {
                if (attempt > 0) {
                    sessionLog(
                        "SOULSEEK",
                        `[${artistName} - ${trackTitle}] ✓ Success on attempt ${
                            attempt + 1
                        }`,
                    );
                }
                return { success: true, filePath: destination.finalPath };
            }
            errors.push(`${match.username}: ${result.error}`);
        }

        sessionLog(
            "SOULSEEK",
            `[${artistName} - ${trackTitle}] All ${matchesToTry.length} attempts failed`,
            "ERROR",
        );
        return { success: false, error: errors.join("; ") };
    }

    /**
     * Get quality string from filename/bitrate
     */
    private getQualityFromFilename(filename: string, bitRate?: number): string {
        const lowerFilename = filename.toLowerCase();
        if (lowerFilename.endsWith(".flac")) return "FLAC";
        if (lowerFilename.endsWith(".wav")) return "WAV";
        if (lowerFilename.endsWith(".mp3")) {
            if (bitRate && bitRate >= 320) return "MP3 320";
            if (bitRate && bitRate >= 256) return "MP3 256";
            if (bitRate && bitRate >= 192) return "MP3 192";
            return "MP3";
        }
        if (lowerFilename.endsWith(".m4a") || lowerFilename.endsWith(".aac"))
            return "AAC";
        if (lowerFilename.endsWith(".ogg")) return "OGG";
        if (lowerFilename.endsWith(".opus")) return "OPUS";
        return "Unknown";
    }

    /**
     * Disconnect from Soulseek
     */
    disconnect(): void {
        this.teardownClient();
        this.client = null;
        sessionLog("SOULSEEK", "Disconnected");
    }
}

// Export singleton instance
export const soulseekService = new SoulseekService();
