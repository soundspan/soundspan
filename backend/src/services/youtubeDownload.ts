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

/** Lifecycle states reported by the sidecar's download job store. */
export type YtDownloadJobState =
    | "queued"
    | "downloading"
    | "processing"
    | "completed"
    | "failed";

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
    getStatus: (jobId: string) => Promise<YtDownloadJobStatus>,
    options: YtDownloadWatchOptions = {}
): Promise<YtDownloadWatchOutcome> {
    const intervalMs = options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS;
    const sleep = options.sleep ?? defaultSleep;

    let elapsedMs = 0;
    while (elapsedMs < timeoutMs) {
        try {
            const status = await getStatus(jobId);
            if (status.status === "completed") {
                return "completed";
            }
            if (status.status === "failed") {
                logger.warn(
                    `[YouTube Download] Watched job ${jobId} failed: ${status.error ?? "unknown error"}`
                );
                return "failed";
            }
        } catch (err: any) {
            if (err.response?.status === 404) {
                logger.warn(
                    `[YouTube Download] Watched job ${jobId} disappeared (sidecar restart?)`
                );
                return "gone";
            }
            logger.debug(
                `[YouTube Download] Transient status error while watching job ${jobId}: ${err.message}`
            );
        }
        await sleep(intervalMs);
        elapsedMs += intervalMs;
    }

    logger.warn(
        `[YouTube Download] Gave up watching job ${jobId} after ${timeoutMs}ms`
    );
    return "timeout";
}

// ── Service ────────────────────────────────────────────────────────

class YouTubeDownloadService {
    private client: AxiosInstance;

    constructor() {
        this.client = axios.create({
            baseURL: config.ytmusicStreamer.url,
            timeout: 30_000,
            httpAgent: new http.Agent(SIDECAR_AGENT_OPTIONS),
            httpsAgent: new https.Agent(SIDECAR_AGENT_OPTIONS),
        });
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
    async getStreamProxy(videoId: string, quality?: string, rangeHeader?: string) {
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
        quality: string = "HIGH"
    ): Promise<YtDownloadJobStart> {
        const res = await this.client.post("/yt/download", {
            video_id: videoId,
            format,
            quality,
        });
        logger.debug(
            `[YouTube Download] Job ${res.data.job_id} started for ${videoId} (status=${res.data.status})`
        );
        return {
            jobId: res.data.job_id,
            status: res.data.status,
        };
    }

    /**
     * Fetch the status of a download job started via startDownload().
     * Throws an axios error with response status 404 when the job is
     * unknown (e.g. the sidecar restarted).
     */
    async getDownloadJobStatus(jobId: string): Promise<YtDownloadJobStatus> {
        const res = await this.client.get(
            `/yt/download/${encodeURIComponent(jobId)}`
        );
        const data = res.data;
        return {
            jobId: data.job_id,
            videoId: data.video_id,
            status: data.status,
            progressPct: data.progress_pct ?? 0,
            filePath: data.file_path ?? null,
            title: data.title ?? "",
            error: data.error ?? null,
            alreadyExisted: Boolean(data.already_existed),
        };
    }
}

export const youtubeDownloadService = new YouTubeDownloadService();
