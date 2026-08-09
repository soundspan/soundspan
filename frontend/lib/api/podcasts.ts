import { type ApiClientConstructor, type ApiData } from "./core";

/** Add podcast-domain operations to an API client base class. */
export function WithPodcasts<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class PodcastsApi extends Base {

    // Podcasts
    async getPodcasts() {
        return this.request<ApiData[]>("/podcasts");
    }

    async getPodcast(id: string) {
        return this.request<ApiData>(`/podcasts/${id}`, { silent404: true });
    }

    async previewPodcast(itunesId: string) {
        return this.request<ApiData>(`/podcasts/preview/${itunesId}`);
    }

    getPodcastEpisodeStreamUrl(podcastId: string, episodeId: string): string {
        const baseUrl = `${this.getBaseUrl()}/api/podcasts/${podcastId}/episodes/${episodeId}/stream`;
        // For audio element requests, cookies may not be sent cross-origin in development
        // Add token as query param for authentication (supported by requireAuthOrToken)
        const token = this.getCurrentToken();
        if (token) {
            return `${baseUrl}?token=${encodeURIComponent(token)}`;
        }
        return baseUrl;
    }

    /**
     * Check if a podcast episode is cached locally
     * Returns { cached: boolean, downloading: boolean, downloadProgress: number | null }
     */
    async getPodcastEpisodeCacheStatus(
        podcastId: string,
        episodeId: string
    ): Promise<{
        cached: boolean;
        downloading: boolean;
        downloadProgress: number | null;
    }> {
        return this.request<{
            cached: boolean;
            downloading: boolean;
            downloadProgress: number | null;
        }>(`/podcasts/${podcastId}/episodes/${episodeId}/cache-status`);
    }

    async updatePodcastEpisodeProgress(
        podcastId: string,
        episodeId: string,
        currentTime: number,
        duration: number,
        isFinished: boolean = false
    ) {
        return this.request<ApiData>(
            `/podcasts/${podcastId}/episodes/${episodeId}/progress`,
            {
                method: "POST",
                body: JSON.stringify({ currentTime, duration, isFinished }),
            }
        );
    }

    // Alias for compatibility with AudioElement
    async updatePodcastProgress(
        podcastId: string,
        episodeId: string,
        currentTime: number,
        duration: number,
        isFinished: boolean = false
    ) {
        return this.updatePodcastEpisodeProgress(
            podcastId,
            episodeId,
            currentTime,
            duration,
            isFinished
        );
    }

    async deletePodcastEpisodeProgress(podcastId: string, episodeId: string) {
        return this.request<ApiData>(
            `/podcasts/${podcastId}/episodes/${episodeId}/progress`,
            {
                method: "DELETE",
            }
        );
    }

    async getSimilarPodcasts(podcastId: string) {
        return this.request<ApiData[]>(`/podcasts/${podcastId}/similar`);
    }

    async getTopPodcasts(limit = 20, genreId?: number) {
        const params = new URLSearchParams({ limit: limit.toString() });
        if (genreId) params.append("genreId", genreId.toString());
        return this.request<ApiData[]>(
            `/podcasts/discover/top?${params.toString()}`
        );
    }

    async getPodcastsByGenre(genreIds: number[]) {
        return this.request<ApiData>(
            `/podcasts/discover/genres?genres=${genreIds.join(",")}`
        );
    }

    async getPodcastsByGenrePaginated(genreId: number, limit = 20, offset = 0) {
        return this.request<ApiData[]>(
            `/podcasts/discover/genre/${genreId}?limit=${limit}&offset=${offset}`
        );
    }

    async subscribePodcast(feedUrl: string, itunesId?: string) {
        return this.request<{ success: boolean; podcast?: ApiData }>("/podcasts/subscribe", {
            method: "POST",
            body: JSON.stringify({ feedUrl, itunesId }),
        });
    }

    async removePodcast(podcastId: string) {
        return this.request<{ success: boolean; message: string }>(
            `/podcasts/${podcastId}/unsubscribe`,
            {
                method: "DELETE",
            }
        );
    }

    async refreshAllPodcasts() {
        return this.request<{
            success: boolean;
            total: number;
            totalNewEpisodes: number;
            failed: number;
            results: Array<{
                podcastId: string;
                success: boolean;
                newEpisodesCount: number;
                error?: string;
            }>;
        }>("/podcasts/refresh-all", { method: "POST" });
    }
    }
    return PodcastsApi;
}
