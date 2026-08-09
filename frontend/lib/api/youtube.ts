import type {
    YouTubePlaylistInfo,
    YouTubeDownloadJob,
} from "../youtube-bulk-download";
import { type ApiClientConstructor } from "./core";

/** Add YouTube-domain operations to an API client base class. */
export function WithYouTube<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class YouTubeApi extends Base {

    // ── YouTube (regular, non-Music) ─────────────────────────────

    /**
     * Fetch metadata for a regular YouTube video.
     * Pass an AbortSignal to cancel the request (e.g. when the search
     * query changes before the lookup resolves).
     */
    async getYouTubeVideoInfo(
        url: string,
        signal?: AbortSignal
    ): Promise<{
        videoId: string;
        title: string;
        uploader: string;
        duration: number;
        thumbnail: string | null;
        uploadDate: string;
        audioFormat?: "mp4" | "webm";
    }> {
        return this.request(`/youtube/info?url=${encodeURIComponent(url)}`, {
            method: "GET",
            signal,
        });
    }

    /**
     * Enumerate a YouTube playlist or channel into a bounded, truncation-aware
     * list of videos for the bulk-download preview. Rejects single-video URLs
     * and un-enumerable radio/mix lists (the request throws with status 422).
     * Pass an AbortSignal to cancel when the query changes.
     */
    async getYouTubePlaylistInfo(
        url: string,
        signal?: AbortSignal
    ): Promise<YouTubePlaylistInfo> {
        return this.request(
            `/youtube/playlist-info?url=${encodeURIComponent(url)}`,
            { method: "GET", signal }
        );
    }

    /**
     * Build a URL for streaming audio from a regular YouTube video.
     * Used by the player to set the audio source.
     */
    getYouTubeStreamUrl(videoId: string, quality?: string): string {
        let url = `${this.getBaseUrl()}/api/youtube/stream/${videoId}`;
        const params = new URLSearchParams();
        if (quality) params.set("quality", quality);
        const token = this.getCurrentToken();
        if (token) params.set("token", token);
        const qs = params.toString();
        if (qs) url += `?${qs}`;
        return url;
    }

    /**
     * Start a background download of a regular YouTube video into the
     * library. Returns immediately with a job id; poll
     * getYouTubeDownloadStatus() for progress. Admin only (403 otherwise).
     */
    async downloadYouTube(
        videoId: string,
        format: string = "mp3",
        quality: string = "HIGH",
        source?: string,
        sourceKind?: "channel" | "playlist"
    ): Promise<{
        jobId: string;
        status:
            | "queued"
            | "downloading"
            | "processing"
            | "completed"
            | "failed";
    }> {
        return this.post(`/youtube/download`, {
            videoId,
            format,
            quality,
            ...(source ? { source } : {}),
            ...(sourceKind ? { sourceKind } : {}),
        });
    }

    /**
     * List YouTube download jobs (active + recent) for the downloads view in
     * the activity panel. The sidecar's job store is in-memory per pod.
     * Admin only (403 otherwise).
     */
    async getYouTubeDownloads(): Promise<YouTubeDownloadJob[]> {
        const res = await this.get<{ jobs: YouTubeDownloadJob[] }>(
            `/youtube/downloads`
        );
        return res?.jobs ?? [];
    }

    /**
     * Cancel a YouTube download job (queued jobs never start; in-flight jobs
     * abort at the next progress tick). Admin only (403 otherwise).
     */
    async cancelYouTubeDownload(jobId: string): Promise<YouTubeDownloadJob> {
        return this.delete<YouTubeDownloadJob>(
            `/youtube/downloads/${encodeURIComponent(jobId)}`
        );
    }

    /**
     * Poll the status of a YouTube download job started via
     * downloadYouTube(). Used for UI progress only — the backend watches
     * the job server-side and queues the library scan on completion.
     * Admin only (403 otherwise).
     */
    async getYouTubeDownloadStatus(jobId: string): Promise<{
        jobId: string;
        videoId: string;
        status:
            | "queued"
            | "downloading"
            | "processing"
            | "completed"
            | "failed";
        progressPct: number;
        filePath: string | null;
        title: string;
        error: string | null;
        alreadyExisted: boolean;
    }> {
        return this.get(`/youtube/download/${encodeURIComponent(jobId)}`);
    }
    }
    return YouTubeApi;
}
