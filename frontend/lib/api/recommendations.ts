import type {
    MoodBucketMix,
    MoodBucketPreset,
    MoodMixParams,
    MoodPreset,
    MoodType,
    SavedMoodMixResponse,
} from "../api";
import { type ApiClientConstructor, type ApiData } from "./core";

/** Add recommendation-domain operations to an API client base class. */
export function WithRecommendations<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class RecommendationsApi extends Base {

    // Recommendations
    async getRecommendationsForYou(limit = 10) {
        return this.request<{ artists: ApiData[] }>(
            `/recommendations/for-you?limit=${limit}`
        );
    }

    async getSimilarArtists(seedArtistId: string, limit = 20) {
        return this.request<{ recommendations: ApiData[] }>(
            `/recommendations?seedArtistId=${seedArtistId}&limit=${limit}`
        );
    }

    async getSimilarAlbums(seedAlbumId: string, limit = 20) {
        return this.request<{ recommendations: ApiData[] }>(
            `/recommendations/albums?seedAlbumId=${seedAlbumId}&limit=${limit}`
        );
    }

    async getSimilarTracks(seedTrackId: string, limit = 20, artist?: string, title?: string) {
        const params = new URLSearchParams({ seedTrackId, limit: String(limit) });
        if (artist) params.set("artist", artist);
        if (title) params.set("title", title);
        return this.request<{ recommendations: ApiData[] }>(
            `/recommendations/tracks?${params.toString()}`
        );
    }

    // Programmatic Mixes
    async getMixes() {
        return this.request<ApiData[]>("/mixes");
    }

    async getMix(id: string) {
        return this.request<ApiData>(`/mixes/${id}`);
    }

    async refreshMixes() {
        return this.request<{ message: string; mixes: ApiData[] }>(
            "/mixes/refresh",
            {
                method: "POST",
            }
        );
    }

    async saveMixAsPlaylist(mixId: string, customName?: string) {
        return this.request<{ id: string; name: string; trackCount: number }>(
            `/mixes/${mixId}/save`,
            {
                method: "POST",
                body: customName
                    ? JSON.stringify({ name: customName })
                    : undefined,
            }
        );
    }

    // Mood on Demand (Legacy)
    async getMoodPresets() {
        return this.request<MoodPreset[]>("/mixes/mood/presets");
    }

    async generateMoodMix(params: MoodMixParams) {
        return this.request<ApiData>("/mixes/mood", {
            method: "POST",
            body: JSON.stringify(params),
        });
    }

    // New Mood Bucket System (simplified, pre-computed)
    async getMoodBucketPresets() {
        return this.request<MoodBucketPreset[]>("/mixes/mood/buckets/presets");
    }

    async getMoodBucketMix(mood: MoodType) {
        return this.request<MoodBucketMix>(`/mixes/mood/buckets/${mood}`);
    }

    async saveMoodBucketMix(mood: MoodType) {
        return this.request<SavedMoodMixResponse>(
            `/mixes/mood/buckets/${mood}/save`,
            { method: "POST" }
        );
    }

    async backfillMoodBuckets() {
        return this.request<{
            success: boolean;
            processed: number;
            assigned: number;
        }>("/mixes/mood/buckets/backfill", { method: "POST" });
    }
    }
    return RecommendationsApi;
}
