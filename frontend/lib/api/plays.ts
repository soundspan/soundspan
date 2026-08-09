import type { AddToPlaylistRef } from "../trackRef";
import { type ApiClientConstructor, type ApiData } from "./core";

/** Add play-history operations to an API client base class. */
export function WithPlays<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class PlaysApi extends Base {

    // Play tracking
    async logPlay(trackRef: AddToPlaylistRef) {
        return this.request<ApiData>("/plays", {
            method: "POST",
            body: JSON.stringify(trackRef),
        });
    }

    async getRecentPlays(limit = 50) {
        return this.request<ApiData[]>(`/plays?limit=${limit}`);
    }

    async getPlayHistorySummary() {
        return this.request<{
            allTime: number;
            last7Days: number;
            last30Days: number;
            last365Days: number;
        }>("/plays/summary");
    }

    async clearPlayHistory(range: "7d" | "30d" | "365d" | "all") {
        return this.request<{
            success: boolean;
            range: "7d" | "30d" | "365d" | "all";
            deletedCount: number;
        }>(`/plays/history?range=${range}`, {
            method: "DELETE",
        });
    }

    // Playback State (cross-device sync)
    async getPlaybackState() {
        return this.request<ApiData>("/playback-state", {
            headers: {
                "X-Playback-Device-Id": this.getPlaybackDeviceId(),
            },
        });
    }

    async savePlaybackState(state: {
        playbackType: string;
        trackId?: string;
        audiobookId?: string;
        podcastId?: string;
        queue?: ApiData[];
        currentIndex?: number;
        isShuffle?: boolean;
        isPlaying?: boolean;
        currentTime?: number;
    }) {
        return this.request<ApiData>("/playback-state", {
            method: "POST",
            headers: {
                "X-Playback-Device-Id": this.getPlaybackDeviceId(),
            },
            body: JSON.stringify(state),
        });
    }

    async clearPlaybackState() {
        return this.request<void>("/playback-state", {
            method: "DELETE",
            headers: {
                "X-Playback-Device-Id": this.getPlaybackDeviceId(),
            },
        });
    }
    }
    return PlaysApi;
}
