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
import { logger } from "../utils/logger";

// Reuse the same sidecar URL — the /yt/ endpoints live on the same service
const YTMUSIC_STREAMER_URL =
    process.env.YTMUSIC_STREAMER_URL || "http://127.0.0.1:8586";
const SIDECAR_AGENT_OPTIONS = {
    keepAlive: true,
    maxSockets: 64,
    maxFreeSockets: 16,
};

// ── Types ──────────────────────────────────────────────────────────

export interface YtVideoInfo {
    videoId: string;
    title: string;
    uploader: string;
    duration: number;
    thumbnail: string | null;
    uploadDate: string;
}

export interface YtDownloadResult {
    success: boolean;
    filePath: string;
    title: string;
    uploader?: string;
    duration?: number;
    alreadyExisted?: boolean;
}

// ── Service ────────────────────────────────────────────────────────

class YouTubeDownloadService {
    private client: AxiosInstance;

    constructor() {
        this.client = axios.create({
            baseURL: YTMUSIC_STREAMER_URL,
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
     * Download audio from a YouTube video to disk via the sidecar.
     * The sidecar handles yt-dlp download, FFmpeg conversion, and
     * metadata/thumbnail embedding.
     */
    async downloadVideo(
        videoId: string,
        format: string = "mp3",
        quality: string = "HIGH"
    ): Promise<YtDownloadResult> {
        const res = await this.client.post(
            "/yt/download",
            {
                video_id: videoId,
                format,
                quality,
                output_dir: "/music/YouTube Downloads",
            },
            {
                timeout: 600_000, // 10 minutes — long DJ sets can take a while
            }
        );
        return res.data;
    }
}

export const youtubeDownloadService = new YouTubeDownloadService();
