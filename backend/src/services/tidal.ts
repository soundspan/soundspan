/**
 * TIDAL Download Service
 *
 * Communicates with the tidal-streamer Python sidecar (FastAPI)
 * to authenticate, search, and download tracks/albums from TIDAL.
 *
 * Auth tokens are persisted in SystemSettings (encrypted at rest).
 */

import axios, { AxiosInstance } from "axios";
import { config } from "../config";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";
import { prisma } from "../utils/db";
import { encrypt, decrypt } from "../utils/encryption";
import { pickBestAlbumMatch } from "./albumMatchPolicy";

const tidalLogger = logger.child("TidalService");

// ── Types ──────────────────────────────────────────────────────────

export interface TidalDeviceAuth {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
}

export interface TidalAuthTokens {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    user_id: string;
    country_code: string;
    username?: string;
}

export interface TidalTrackResult {
    id: number;
    title: string;
    artist: string;
    album: { id: number; title: string };
    duration: number;
    quality: string;
    isrc: string;
    explicit: boolean;
}

export interface TidalAlbumResult {
    id: number;
    title: string;
    artist: string;
    numberOfTracks: number;
    releaseDate: string | null;
    type: string;
    quality: string;
    cover: string | null;
}

export interface TidalSearchResults {
    tracks: TidalTrackResult[];
    albums: TidalAlbumResult[];
    artists: Array<{ id: number; name: string; picture: string | null }>;
}

export interface TidalDownloadResult {
    track_id: number;
    title: string;
    artist: string;
    album: string;
    quality: string;
    file_path: string;
    relative_path: string;
    file_size: number;
}

export interface TidalAlbumDownloadResult {
    album_id: number;
    album_title: string;
    artist: string;
    total_tracks: number;
    downloaded: number;
    failed: number;
    tracks: TidalDownloadResult[];
    errors: Array<{ track_id: number; title: string; error: string }>;
}

// ── Service ────────────────────────────────────────────────────────

class TidalService {
    private client: AxiosInstance;
    private readonly sidecarUrl: string;

    constructor() {
        this.sidecarUrl = config.tidal.sidecarUrl;

        this.client = axios.create({
            baseURL: this.sidecarUrl,
            timeout: 300000, // 5 min — album downloads can be slow
            headers: {
                "Content-Type": "application/json",
                // Authenticate to the sidecar (F31); omitted when unset.
                ...(config.internalApiSecret
                    ? { "x-internal-secret": config.internalApiSecret }
                    : {}),
            },
        });
    }

    // ── Health / availability ──────────────────────────────────────

    /**
     * Check whether the TIDAL sidecar container is reachable.
     */
    async isSidecarHealthy(): Promise<boolean> {
        try {
            const res = await this.client.get("/health", { timeout: 5000 });
            return res.data?.status === "ok";
        } catch {
            return false;
        }
    }

    /**
     * TIDAL is "enabled" when the user has turned on the feature
     * AND valid tokens are stored.
     */
    async isEnabled(): Promise<boolean> {
        try {
            const settings = await getSystemSettings();
            return !!(
                settings?.tidalEnabled &&
                settings?.tidalAccessToken &&
                settings?.tidalRefreshToken
            );
        } catch {
            return false;
        }
    }

    /**
     * TIDAL is "available" when enabled AND the sidecar is healthy.
     */
    async isAvailable(): Promise<boolean> {
        const enabled = await this.isEnabled();
        if (!enabled) return false;
        return this.isSidecarHealthy();
    }

    // ── Token helpers ──────────────────────────────────────────────

    /**
     * Build per-request credential headers for the sidecar.
     * Tokens travel in Authorization (never the URL) so they can't leak
     * into access logs or proxies.
     */
    private buildCredentialHeaders(creds: {
        accessToken: string;
        userId: string;
        countryCode: string;
    }): Record<string, string> {
        return {
            Authorization: `Bearer ${creds.accessToken}`,
            "x-tidal-user-id": creds.userId,
            "x-tidal-country-code": creds.countryCode,
        };
    }

    /**
     * Read and decrypt credentials from SystemSettings. In fail-closed mode,
     * decryption failure leaves Tidal unconfigured instead of using stored
     * ciphertext as bearer tokens.
     */
    private async getCredentials(): Promise<{
        accessToken: string;
        refreshToken: string;
        userId: string;
        countryCode: string;
        quality: string;
        fileTemplate: string;
    } | null> {
        try {
            const settings = await prisma.systemSettings.findUnique({
                where: { id: "default" },
            });
            if (!settings?.tidalAccessToken || !settings?.tidalRefreshToken)
                return null;

            let accessToken: string;
            let refreshToken: string;
            try {
                accessToken = decrypt(settings.tidalAccessToken);
                refreshToken = decrypt(settings.tidalRefreshToken);
                if (!accessToken || !refreshToken) {
                    throw new Error(
                        "Tidal credential decryption returned empty",
                    );
                }
            } catch (err) {
                if (config.settingsDecryptFailClosed) {
                    logger.error(
                        "[TIDAL] Credential decryption failed closed:",
                        err,
                    );
                    return null;
                }
                accessToken = settings.tidalAccessToken;
                refreshToken = settings.tidalRefreshToken;
            }

            return {
                accessToken,
                refreshToken,
                userId: settings.tidalUserId || "",
                countryCode: settings.tidalCountryCode || "US",
                quality: settings.tidalQuality || "HIGH",
                fileTemplate:
                    settings.tidalFileTemplate ||
                    "{album.artist}/{album.title}/{item.number:02d}. {item.title}",
            };
        } catch (err) {
            logger.error("[TIDAL] Failed to read credentials:", err);
            return null;
        }
    }

    /**
     * Persist new tokens (encrypted) to SystemSettings.
     */
    async saveTokens(tokens: {
        accessToken: string;
        refreshToken: string;
        userId: string;
        countryCode: string;
    }): Promise<void> {
        await prisma.systemSettings.update({
            where: { id: "default" },
            data: {
                tidalAccessToken: encrypt(tokens.accessToken),
                tidalRefreshToken: encrypt(tokens.refreshToken),
                tidalUserId: tokens.userId,
                tidalCountryCode: tokens.countryCode,
            },
        });
        logger.debug("[TIDAL] Tokens saved");
    }

    /**
     * Attempt to refresh the access token via the sidecar.
     * On success, saves the new token to the database.
     */
    async refreshAccessToken(): Promise<boolean> {
        const creds = await this.getCredentials();
        if (!creds) return false;

        try {
            const res = await this.client.post("/auth/refresh", {
                refresh_token: creds.refreshToken,
            });

            await this.saveTokens({
                accessToken: res.data.access_token,
                refreshToken: creds.refreshToken, // refresh_token doesn't change
                userId: res.data.user_id,
                countryCode: res.data.country_code,
            });

            return true;
        } catch (err: any) {
            logger.error(
                "[TIDAL] Token refresh failed:",
                err.response?.data || err.message,
            );
            return false;
        }
    }

    // ── Auth flow ──────────────────────────────────────────────────

    /**
     * Step 1 — Initiate device auth. Returns a verification URL the
     * user must visit to authorize soundspan.
     */
    async initiateDeviceAuth(): Promise<TidalDeviceAuth> {
        const res = await this.client.post("/auth/device");
        return res.data;
    }

    /**
     * Step 2 — Poll the sidecar to exchange the device code for tokens.
     * Returns null when the user hasn't authorised yet (HTTP 428).
     */
    async pollDeviceAuth(deviceCode: string): Promise<TidalAuthTokens | null> {
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

    /**
     * Verify that the stored session is still valid.
     */
    async verifySession(): Promise<{
        valid: boolean;
        userId?: string;
        countryCode?: string;
    }> {
        const creds = await this.getCredentials();
        if (!creds) return { valid: false };

        try {
            const res = await this.client.post("/auth/session", {
                access_token: creds.accessToken,
                user_id: creds.userId,
                country_code: creds.countryCode,
            });
            return {
                valid: true,
                userId: res.data.user_id,
                countryCode: res.data.country_code,
            };
        } catch (err: any) {
            // If 401, try refreshing
            if (err.response?.status === 401) {
                const refreshed = await this.refreshAccessToken();
                if (refreshed) {
                    return this.verifySession(); // retry once
                }
            }
            return { valid: false };
        }
    }

    // ── Search ─────────────────────────────────────────────────────

    async search(query: string): Promise<TidalSearchResults> {
        const creds = await this.getCredentials();
        if (!creds) throw new Error("TIDAL not authenticated");

        try {
            const res = await this.client.post(
                "/search",
                { query },
                { headers: this.buildCredentialHeaders(creds) },
            );
            return res.data;
        } catch (err: any) {
            // Auto-refresh on 401
            if (err.response?.status === 401) {
                const refreshed = await this.refreshAccessToken();
                if (refreshed) return this.search(query);
            }
            throw err;
        }
    }

    // ── Download ───────────────────────────────────────────────────

    /**
     * Search TIDAL for an album by artist + album title.
     * Returns the best-matching album ID, or null if not found.
     */
    async findAlbum(
        artistName: string,
        albumTitle: string,
    ): Promise<{
        albumId: number;
        title: string;
        artist: string;
        numberOfTracks: number;
    } | null> {
        try {
            const results = await this.search(`${artistName} ${albumTitle}`);
            if (!results.albums || results.albums.length === 0) return null;

            const match = pickBestAlbumMatch(
                { artistName, albumTitle },
                results.albums,
                (album) => ({
                    artistName: album.artist,
                    albumTitle: album.title,
                }),
            );
            if (!match) {
                tidalLogger.debug("No acceptable album match found", {
                    artistName,
                    albumTitle,
                    candidateCount: results.albums.length,
                });
                return null;
            }

            return {
                albumId: match.id,
                title: match.title,
                artist: match.artist,
                numberOfTracks: match.numberOfTracks,
            };
        } catch (err: any) {
            logger.error("[TIDAL] Album search failed:", err.message);
            return null;
        }
    }

    /**
     * Download a single track directly to /music,
     * using the user's configured file template.
     */
    async downloadTrack(trackId: number): Promise<TidalDownloadResult> {
        const creds = await this.getCredentials();
        if (!creds) throw new Error("TIDAL not authenticated");

        try {
            const res = await this.client.post(
                "/download/track",
                {
                    track_id: trackId,
                    quality: creds.quality,
                    output_template: creds.fileTemplate,
                },
                { headers: this.buildCredentialHeaders(creds) },
            );
            return res.data;
        } catch (err: any) {
            if (err.response?.status === 401) {
                const refreshed = await this.refreshAccessToken();
                if (refreshed) return this.downloadTrack(trackId);
            }
            throw err;
        }
    }

    /**
     * Download an entire album directly to /music.
     */
    async downloadAlbum(albumId: number): Promise<TidalAlbumDownloadResult> {
        const creds = await this.getCredentials();
        if (!creds) throw new Error("TIDAL not authenticated");

        try {
            const res = await this.client.post(
                "/download/album",
                {
                    album_id: albumId,
                    quality: creds.quality,
                    output_template: creds.fileTemplate,
                },
                { headers: this.buildCredentialHeaders(creds) },
            );
            return res.data;
        } catch (err: any) {
            if (err.response?.status === 401) {
                const refreshed = await this.refreshAccessToken();
                if (refreshed) return this.downloadAlbum(albumId);
            }
            throw err;
        }
    }
}

// ── Singleton ──────────────────────────────────────────────────────

export const tidalService = new TidalService();
