import {
    toSearchParams,
    type ApiClientConstructor,
    type ApiData,
} from "./core";

/** Add discover-domain operations to an API client base class. */
export function WithDiscover<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class DiscoverApi extends Base {

    async generateDiscoverWeekly() {
        return this.request<{ message: string; jobId: string }>(
            "/discover/generate",
            {
                method: "POST",
            }
        );
    }

    async getDiscoverGenerationStatus(jobId: string) {
        return this.request<{
            status: string;
            progress: number;
            result?: {
                success: boolean;
                playlistName: string;
                songCount: number;
                error?: string;
            };
        }>(`/discover/generate/status/${jobId}`);
    }

    async getCurrentDiscoverWeekly() {
        return this.request<{
            weekStart: string;
            weekEnd: string;
            tracks: ApiData[];
            unavailable: ApiData[];
            totalCount: number;
            unavailableCount: number;
        }>("/discover/current");
    }

    async getDiscoverBatchStatus() {
        return this.request<{
            active: boolean;
            status: "downloading" | "scanning" | "generating" | null;
            batchId?: string;
            progress?: number;
            completed?: number;
            failed?: number;
            total?: number;
        }>("/discover/batch-status");
    }

    async likeDiscoverAlbum(albumId: string) {
        return this.request<{ success: boolean }>("/discover/like", {
            method: "POST",
            body: JSON.stringify({ albumId }),
        });
    }

    async unlikeDiscoverAlbum(albumId: string) {
        return this.request<{ success: boolean }>("/discover/unlike", {
            method: "DELETE",
            body: JSON.stringify({ albumId }),
        });
    }

    async getDiscoverConfig() {
        return this.request<{
            id: string;
            userId: string;
            playlistSize: number;
            enabled: boolean;
            lastGeneratedAt: string | null;
        }>("/discover/config");
    }

    async updateDiscoverConfig(config: {
        playlistSize?: number;
        enabled?: boolean;
    }) {
        return this.request<{
            id: string;
            userId: string;
            playlistSize: number;
            enabled: boolean;
            lastGeneratedAt: string | null;
        }>("/discover/config", {
            method: "PATCH",
            body: JSON.stringify(config),
        });
    }

    async clearDiscoverPlaylist() {
        return this.request<{
            success: boolean;
            message: string;
            likedMoved: number;
            activeDeleted: number;
        }>("/discover/clear", {
            method: "DELETE",
        });
    }

    async getDiscoverExclusions() {
        return this.request<{
            exclusions: Array<{
                id: string;
                albumMbid: string;
                artistName: string;
                albumTitle: string;
                lastSuggestedAt: string;
                expiresAt: string;
            }>;
            count: number;
        }>("/discover/exclusions");
    }

    async clearDiscoverExclusions() {
        return this.request<{
            success: boolean;
            message: string;
            clearedCount: number;
        }>("/discover/exclusions", {
            method: "DELETE",
        });
    }

    async removeDiscoverExclusion(id: string) {
        return this.request<{
            success: boolean;
            message: string;
        }>(`/discover/exclusions/${id}`, {
            method: "DELETE",
        });
    }

    async getArtistDiscovery(
        nameOrMbid: string,
        options?: {
            includeDiscography?: boolean;
            includeTopTracks?: boolean;
            includeSimilarArtists?: boolean;
        }
    ) {
        const queryString = options
            ? toSearchParams(options).toString()
            : "";
        const suffix = queryString ? `?${queryString}` : "";
        return this.request<ApiData>(
            `/artists/discover/${encodeURIComponent(nameOrMbid)}${suffix}`
        );
    }

    async getAlbumDiscovery(
        rgMbid: string,
        options?: {
            includeTracks?: boolean;
        }
    ) {
        const queryString = options
            ? toSearchParams(options).toString()
            : "";
        const suffix = queryString ? `?${queryString}` : "";
        return this.request<ApiData>(
            `/artists/album/${encodeURIComponent(rgMbid)}${suffix}`
        );
    }

    async discoverSearch(
        query: string,
        type: "music" | "podcasts" | "all" = "music",
        limit: number = 20,
        signal?: AbortSignal
    ) {
        return this.request<{
            results: ApiData[];
            aliasInfo: { original: string; canonical: string; mbid?: string } | null;
        }>(
            `/search/discover?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`,
            { signal }
        );
    }

    async discoverSimilarArtists(
        artist: string,
        mbid: string = "",
        limit: number = 6,
        signal?: AbortSignal
    ) {
        return this.request<{ similarArtists: ApiData[] }>(
            `/search/discover/similar?artist=${encodeURIComponent(artist)}&mbid=${encodeURIComponent(mbid)}&limit=${limit}`,
            { signal }
        );
    }
    }
    return DiscoverApi;
}
