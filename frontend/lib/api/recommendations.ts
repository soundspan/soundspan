import type {
    MoodBucketMix,
    MoodBucketPreset,
    MoodMixParams,
    MoodPreset,
    MoodType,
    SavedMoodMixResponse,
} from "../api";
import { type ApiClientConstructor, type ApiData } from "./core";

/** Unowned artist on an Explore discovery shelf. */
export interface ExploreDiscoveryArtist {
    name: string;
    mbid?: string;
    image: string | null;
    /** Artist from the user's own history that led to this suggestion. */
    because?: string;
}

/** Recent release group (MusicBrainz) that is not in the library. */
export interface ExploreDiscoveryRelease {
    rgMbid: string;
    title: string;
    artistName: string;
    artistMbid?: string;
    releaseDate: string;
    primaryType?: string;
    coverUrl: string;
}

/** Globally trending track (Last.fm) that is not in the library. */
export interface ExploreDiscoveryTrack {
    type: "track";
    id: string;
    name: string;
    artist: string;
    image?: string;
    listeners?: number;
}

/** Explore discovery shelves of music outside the library. */
export interface ExploreDiscovery {
    /** False when the user has no history and only global content is shown. */
    personalized: boolean;
    similarArtists: ExploreDiscoveryArtist[];
    newReleases: ExploreDiscoveryRelease[];
    trendingTracks: ExploreDiscoveryTrack[];
    tagShelves: Array<{ tag: string; artists: ExploreDiscoveryArtist[] }>;
}

/** Add recommendation-domain operations to an API client base class. */
export function WithRecommendations<TBase extends ApiClientConstructor>(
    Base: TBase,
) {
    abstract class RecommendationsApi extends Base {
        // Recommendations
        async getRecommendationsForYou(limit = 10) {
            return this.request<{ artists: ApiData[] }>(
                `/recommendations/for-you?limit=${limit}`,
            );
        }

        /** Explore shelves of music not in the library, tailored per user. */
        async getExploreDiscovery() {
            return this.request<ExploreDiscovery>("/recommendations/explore");
        }

        async getSimilarArtists(seedArtistId: string, limit = 20) {
            return this.request<{ recommendations: ApiData[] }>(
                `/recommendations?seedArtistId=${seedArtistId}&limit=${limit}`,
            );
        }

        async getSimilarAlbums(seedAlbumId: string, limit = 20) {
            return this.request<{ recommendations: ApiData[] }>(
                `/recommendations/albums?seedAlbumId=${seedAlbumId}&limit=${limit}`,
            );
        }

        async getSimilarTracks(
            seedTrackId: string,
            limit = 20,
            artist?: string,
            title?: string,
        ) {
            const params = new URLSearchParams({
                seedTrackId,
                limit: String(limit),
            });
            if (artist) params.set("artist", artist);
            if (title) params.set("title", title);
            return this.request<{ recommendations: ApiData[] }>(
                `/recommendations/tracks?${params.toString()}`,
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
                },
            );
        }

        async saveMixAsPlaylist(mixId: string, customName?: string) {
            return this.request<{
                id: string;
                name: string;
                trackCount: number;
            }>(`/mixes/${mixId}/save`, {
                method: "POST",
                body: customName
                    ? JSON.stringify({ name: customName })
                    : undefined,
            });
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
            return this.request<MoodBucketPreset[]>(
                "/mixes/mood/buckets/presets",
            );
        }

        async getMoodBucketMix(mood: MoodType) {
            return this.request<MoodBucketMix>(`/mixes/mood/buckets/${mood}`);
        }

        async saveMoodBucketMix(mood: MoodType) {
            return this.request<SavedMoodMixResponse>(
                `/mixes/mood/buckets/${mood}/save`,
                { method: "POST" },
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
