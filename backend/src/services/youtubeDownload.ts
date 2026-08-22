/**
 * YouTube Download Service
 *
 * Thin HTTP client wrapping the ytmusic-streamer sidecar's /yt/ endpoints.
 * These endpoints handle regular YouTube videos (not YouTube Music) and
 * do NOT require OAuth authentication — they use yt-dlp's anonymous
 * extraction against youtube.com.
 */

import axios, { AxiosInstance } from "axios";
import http from "node:http";
import https from "node:https";
import { config } from "../config";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";

const SIDECAR_AGENT_OPTIONS = {
    keepAlive: true,
    maxSockets: 64,
    maxFreeSockets: 16,
};

// ── Types ──────────────────────────────────────────────────────────

/** Metadata for a regular YouTube video, as returned by the sidecar /yt/info. */
export interface YtVideoInfo {
    videoId: string;
    title: string;
    uploader: string;
    duration: number;
    thumbnail: string | null;
    uploadDate: string;
    /** Audio container the stream proxy will serve ("webm" for opus, "mp4" for AAC). */
    audioFormat?: "webm" | "mp4";
}

/** A single enumerable video within a playlist/channel (GET /yt/playlist-info). */
export interface YtPlaylistEntry {
    videoId: string;
    title: string;
    uploader: string;
    duration: number | null;
}

/**
 * Bounded enumeration of a YouTube playlist or channel, as returned by the
 * sidecar /yt/playlist-info. `entries` is capped (sidecar-side); `truncated`
 * is true when the source holds more videos than were returned.
 */
export interface YtPlaylistInfo {
    kind: "playlist" | "channel";
    playlistId: string | null;
    channel: string | null;
    sourceUrl: string;
    title: string;
    uploader: string;
    totalCount: number | null;
    truncated: boolean;
    count: number;
    entries: YtPlaylistEntry[];
}

/** Lifecycle states reported by the sidecar's download job store. */
export type YtDownloadJobState =
    | "queued"
    | "downloading"
    | "processing"
    | "completed"
    | "failed"
    | "cancelled";

/** Response from starting a download job (POST /yt/download). */
export interface YtDownloadJobStart {
    jobId: string;
    status: YtDownloadJobState;
}

/** Status snapshot for a download job (GET /yt/download/{jobId}). */
export interface YtDownloadJobStatus {
    jobId: string;
    videoId: string;
    status: YtDownloadJobState;
    progressPct: number;
    filePath: string | null;
    title: string;
    error: string | null;
    alreadyExisted: boolean;
    /** Grouping label (playlist/channel title) for bulk runs, if provided. */
    source: string | null;
    /** Unix seconds when the job was created (sidecar clock). */
    createdAt: number | null;
}

/** Status snapshot for an album library-download job. */
export interface YtAlbumDownloadJobStatus {
    jobId: string;
    browseId: string;
    status: YtDownloadJobState;
    progressPct: number;
    albumTitle: string;
    albumArtist: string;
    totalTracks: number;
    downloaded: number;
    failed: number;
    errors: Array<{ videoId: string; title: string; error: string }>;
    error: string | null;
    createdAt: number | null;
}

/** Public YouTube Music album candidate returned by the download sidecar. */
export interface YtAlbumSearchResult {
    browseId: string;
    title: string;
    artists: string[];
}

/** Minimal job fields consumed by the shared terminal watcher. */
export interface YtDownloadStatusSnapshot {
    status: YtDownloadJobState;
    error: string | null;
    progressPct: number;
}

/** Terminal outcome of a server-side download-job watch. */
export type YtDownloadWatchOutcome =
    | "completed"
    | "failed"
    | "gone"
    | "timeout";

/** Options for watchYouTubeDownloadJobUntilTerminal(). */
export interface YtDownloadWatchOptions {
    /** Delay between status polls (default 5s). */
    intervalMs?: number;
    /** Give up after this much watch time (default 6h, sized for long sets). */
    timeoutMs?: number;
    /** Injectable delay, for tests. */
    sleep?: (ms: number) => Promise<void>;
    /** Observe each fetched status without adding another sidecar poll. */
    onStatus?: (status: YtDownloadStatusSnapshot) => void | Promise<void>;
}

const DEFAULT_WATCH_INTERVAL_MS = 5_000;
const DEFAULT_WATCH_TIMEOUT_MS = 6 * 60 * 60 * 1000;

const defaultSleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll a sidecar download job server-side until it reaches a terminal
 * state. This is what guarantees the post-download library scan fires even
 * when no browser is still polling the status endpoint (e.g. the user
 * navigated away during a multi-hour download).
 *
 * Transient status-fetch errors are tolerated until the timeout; a sidecar
 * 404 means the job store was lost (restart) and resolves "gone".
 */
export async function watchYouTubeDownloadJobUntilTerminal(
    jobId: string,
    getStatus: (jobId: string) => Promise<YtDownloadStatusSnapshot>,
    options: YtDownloadWatchOptions = {},
): Promise<YtDownloadWatchOutcome> {
    const intervalMs = options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS;
    const sleep = options.sleep ?? defaultSleep;
    const onStatus = options.onStatus;

    let elapsedMs = 0;
    while (elapsedMs < timeoutMs) {
        let status: YtDownloadStatusSnapshot;
        try {
            status = await getStatus(jobId);
        } catch (err: any) {
            if (err.response?.status === 404) {
                logger.warn(
                    `[YouTube Download] Watched job ${jobId} disappeared (sidecar restart?)`,
                );
                return "gone";
            }
            logger.debug(
                `[YouTube Download] Transient status error while watching job ${jobId}: ${err.message}`,
            );
            await sleep(intervalMs);
            elapsedMs += intervalMs;
            continue;
        }
        if (onStatus) await onStatus(status);
        if (status.status === "completed") {
            return "completed";
        }
        if (status.status === "failed" || status.status === "cancelled") {
            logger.warn(
                `[YouTube Download] Watched job ${jobId} failed: ${status.error ?? "unknown error"}`,
            );
            return "failed";
        }
        await sleep(intervalMs);
        elapsedMs += intervalMs;
    }

    logger.warn(
        `[YouTube Download] Gave up watching job ${jobId} after ${timeoutMs}ms`,
    );
    return "timeout";
}

// ── Service ────────────────────────────────────────────────────────

class YouTubeDownloadService {
    private _client?: AxiosInstance;

    // Build the axios client lazily so importing this module does not read
    // sidecar config. The singleton below is constructed at import time (when
    // index.ts is required), so reading config.ytmusicStreamer.url in the
    // constructor crashed any context whose config isn't fully populated — e.g.
    // unit tests that mock a minimal config object. Other sidecar services read
    // config on first use; match that.
    private get client(): AxiosInstance {
        if (!this._client) {
            this._client = axios.create({
                baseURL: config.ytmusicStreamer.url,
                timeout: 30_000,
                httpAgent: new http.Agent(SIDECAR_AGENT_OPTIONS),
                httpsAgent: new https.Agent(SIDECAR_AGENT_OPTIONS),
                // Authenticate to the sidecar (F31). Omitted when unset so the
                // sidecar rejects fail-closed rather than sending a blank header.
                ...(config.internalApiSecret
                    ? {
                          headers: {
                              "x-internal-secret": config.internalApiSecret,
                          },
                      }
                    : {}),
            });
        }
        return this._client;
    }

    /** Check whether the public YouTube sidecar is reachable. */
    async isSidecarHealthy(): Promise<boolean> {
        try {
            const response = await this.client.get("/health", {
                timeout: 5_000,
            });
            return response.data?.status === "ok";
        } catch {
            return false;
        }
    }

    /** YouTube library downloads require the enabled setting and a healthy sidecar. */
    async isAvailable(): Promise<boolean> {
        try {
            const settings = await getSystemSettings();
            if (settings?.ytMusicEnabled !== true) return false;
            return this.isSidecarHealthy();
        } catch {
            return false;
        }
    }

    /**
     * Fetch metadata for a YouTube video (title, uploader, duration, thumbnail).
     */
    async getVideoInfo(url: string): Promise<YtVideoInfo> {
        const res = await this.client.get("/yt/info", {
            params: { url },
        });
        return res.data;
    }

    /**
     * Enumerate a YouTube playlist or channel into a bounded list of video
     * entries for the bulk-download UI. The sidecar caps the count and flags
     * truncation; it returns 422 for single videos and un-enumerable mixes.
     */
    async getPlaylistInfo(url: string): Promise<YtPlaylistInfo> {
        const res = await this.client.get("/yt/playlist-info", {
            params: { url },
        });
        return res.data;
    }

    /**
     * Build the sidecar proxy URL for streaming YouTube audio.
     * The backend proxies this to the frontend player.
     */
    getStreamProxyPath(videoId: string, quality?: string): string {
        const params = new URLSearchParams();
        if (quality) params.set("quality", quality);
        const qs = params.toString();
        return `/yt/proxy/${videoId}${qs ? `?${qs}` : ""}`;
    }

    /**
     * Proxy an audio stream from a YouTube video through the sidecar.
     * Returns an axios response with responseType: "stream" for piping.
     */
    async getStreamProxy(
        videoId: string,
        quality?: string,
        rangeHeader?: string,
    ) {
        const params: Record<string, string> = {};
        if (quality) params.quality = quality;

        const headers: Record<string, string> = {};
        if (rangeHeader) headers["Range"] = rangeHeader;

        return this.client.get(`/yt/proxy/${videoId}`, {
            params,
            headers,
            responseType: "stream",
            timeout: 120_000,
        });
    }

    /**
     * Start a background download job for a YouTube video via the sidecar.
     * Returns immediately with a job id; poll getDownloadJobStatus() for
     * progress. The sidecar handles yt-dlp download, FFmpeg conversion,
     * and metadata/thumbnail embedding into YT_DOWNLOAD_DIR.
     */
    async startDownload(
        videoId: string,
        format: string = "mp3",
        quality: string = "HIGH",
        source?: string,
        sourceKind?: string,
    ): Promise<YtDownloadJobStart> {
        const res = await this.client.post("/yt/download", {
            video_id: videoId,
            format,
            quality,
            ...(source ? { source } : {}),
            ...(sourceKind ? { source_kind: sourceKind } : {}),
        });
        logger.debug(
            `[YouTube Download] Job ${res.data.job_id} started for ${videoId} (status=${res.data.status})`,
        );
        return {
            jobId: res.data.job_id,
            status: res.data.status,
        };
    }

    /** Start a server-rooted YouTube Music album download. */
    async startAlbumDownload(
        browseId: string,
        format: string = "mp3",
        quality: string = "HIGH",
    ): Promise<YtDownloadJobStart> {
        const response = await this.client.post("/yt/download/album", {
            browse_id: browseId,
            format,
            quality,
        });
        return {
            jobId: response.data.job_id,
            status: response.data.status,
        };
    }

    /** Search public YouTube Music albums for a library download candidate. */
    async searchAlbums(
        query: string,
        limit: number = 10,
    ): Promise<YtAlbumSearchResult[]> {
        const encodedQuery = encodeURIComponent(query);
        const encodedLimit = encodeURIComponent(String(limit));
        const response = await this.client.get(
            `/yt/album-search?query=${encodedQuery}&limit=${encodedLimit}`,
        );
        const albums = Array.isArray(response.data?.albums)
            ? response.data.albums
            : [];
        return albums.map(mapAlbumSearchResult);
    }

    /** Fetch an isolated YouTube Music album job status. */
    async getAlbumDownloadJobStatus(
        jobId: string,
    ): Promise<YtAlbumDownloadJobStatus> {
        const response = await this.client.get(
            `/yt/download/album/${encodeURIComponent(jobId)}`,
        );
        return mapAlbumDownloadJob(response.data);
    }

    /**
     * Fetch the status of a download job started via startDownload().
     * Throws an axios error with response status 404 when the job is
     * unknown (e.g. the sidecar restarted).
     */
    async getDownloadJobStatus(jobId: string): Promise<YtDownloadJobStatus> {
        const res = await this.client.get(
            `/yt/download/${encodeURIComponent(jobId)}`,
        );
        return mapDownloadJob(res.data);
    }

    /**
     * List all known download jobs (active + recent terminal) for the
     * downloads view. The sidecar store is in-memory per pod.
     */
    async listDownloads(): Promise<YtDownloadJobStatus[]> {
        const res = await this.client.get("/yt/downloads");
        const jobs = Array.isArray(res.data?.jobs) ? res.data.jobs : [];
        return jobs.map(mapDownloadJob);
    }

    /**
     * Cancel a download job. Queued jobs never start; in-flight jobs abort at
     * the next progress tick. Throws an axios error with status 404 when the
     * job is unknown.
     */
    async cancelDownload(jobId: string): Promise<YtDownloadJobStatus> {
        const res = await this.client.delete(
            `/yt/downloads/${encodeURIComponent(jobId)}`,
        );
        return mapDownloadJob(res.data);
    }
}

/** Map a sidecar snake_case download-job payload to the camelCase shape. */
function mapDownloadJob(data: any): YtDownloadJobStatus {
    return {
        jobId: data.job_id,
        videoId: data.video_id,
        status: data.status,
        progressPct: data.progress_pct ?? 0,
        filePath: data.file_path ?? null,
        title: data.title ?? "",
        error: data.error ?? null,
        alreadyExisted: Boolean(data.already_existed),
        source: data.source ?? null,
        createdAt: data.created_at ?? null,
    };
}

/** Map a sidecar album-job payload to the backend shape. */
function mapAlbumDownloadJob(data: any): YtAlbumDownloadJobStatus {
    const errors = Array.isArray(data.errors) ? data.errors : [];
    return {
        jobId: data.job_id,
        browseId: data.browse_id,
        status: data.status,
        progressPct: data.progress_pct ?? 0,
        albumTitle: data.album_title ?? "",
        albumArtist: data.album_artist ?? "",
        totalTracks: data.total_tracks ?? 0,
        downloaded: data.downloaded ?? 0,
        failed: data.failed ?? 0,
        errors: errors.map((entry: any) => ({
            videoId: entry.video_id ?? "",
            title: entry.title ?? "",
            error: entry.error ?? "Track download failed",
        })),
        error: data.error ?? null,
        createdAt: data.created_at ?? null,
    };
}

/** Map a sidecar album-search payload to the backend shape. */
function mapAlbumSearchResult(data: any): YtAlbumSearchResult {
    const artists = Array.isArray(data.artists) ? data.artists : [];
    return {
        browseId: typeof data.browse_id === "string" ? data.browse_id : "",
        title: typeof data.title === "string" ? data.title : "",
        artists: artists.filter(
            (artist: unknown): artist is string => typeof artist === "string",
        ),
    };
}

export const youtubeDownloadService = new YouTubeDownloadService();
