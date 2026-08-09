import { isRemoteTrack } from "../trackRef";
import type {
    AlbumPreferenceResponse,
    LibraryHealthRecord,
    LikedPlaylistResponse,
    TrackPreferenceResponse,
    TrackPreferenceSignal,
} from "../api";
import {
    toSearchParams,
    type ApiClientConstructor,
    type ApiData,
} from "./core";

/** Add library-domain operations to an API client base class. */
export function WithLibrary<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class LibraryApi extends Base {

    // Library
    async getArtists(params?: {
        limit?: number;
        offset?: number;
        filter?: "owned" | "discovery" | "all";
        sortBy?: string;
    }) {
        return this.request<{
            artists: ApiData[];
            total: number;
            offset: number;
            limit: number;
        }>(`/library/artists?${toSearchParams(params as Record<string, string | number | boolean | undefined>).toString()}`);
    }

    async getRecentlyListened(limit = 10) {
        return this.request<{ items: ApiData[] }>(
            `/library/recently-listened?limit=${limit}`
        );
    }

    async getRecentlyAdded(limit = 10) {
        return this.request<{ artists: ApiData[] }>(
            `/library/recently-added?limit=${limit}`
        );
    }

    async scanLibrary() {
        return this.request<{
            message: string;
            jobId: string;
            musicPath: string;
        }>("/library/scan", {
            method: "POST",
        });
    }

    async getScanStatus(jobId: string) {
        return this.request<{
            status: string;
            progress: number;
            result?: Record<string, unknown>;
        }>(`/library/scan/status/${jobId}`);
    }

    async organizeLibrary() {
        return this.request<{ message: string }>("/library/organize", {
            method: "POST",
        });
    }

    async getArtist(
        id: string,
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
        return this.request<ApiData>(`/library/artists/${id}${suffix}`);
    }

    async getAlbums(params?: {
        artistId?: string;
        limit?: number;
        offset?: number;
        filter?: "owned" | "discovery" | "all";
        sortBy?: string;
    }) {
        return this.request<{
            albums: ApiData[];
            total: number;
            offset: number;
            limit: number;
        }>(`/library/albums?${toSearchParams(params as Record<string, string | number | boolean | undefined>).toString()}`);
    }

    async getAlbum(
        id: string,
        options?: {
            includeTracks?: boolean;
        }
    ) {
        const queryString = options
            ? toSearchParams(options).toString()
            : "";
        const suffix = queryString ? `?${queryString}` : "";
        return this.request<ApiData>(`/library/albums/${id}${suffix}`);
    }

    async getTracks(params?: {
        albumId?: string;
        limit?: number;
        offset?: number;
        sortBy?: string;
    }) {
        return this.request<{
            tracks: ApiData[];
            total: number;
            offset: number;
            limit: number;
        }>(`/library/tracks?${toSearchParams(params as Record<string, string | number | boolean | undefined>).toString()}`);
    }

    async getShuffledTracks(limit?: number) {
        const params = limit ? `?limit=${limit}` : "";
        return this.request<{
            tracks: ApiData[];
            total: number;
        }>(`/library/tracks/shuffle${params}`);
    }

    async getLibraryDeletePolicy() {
        return this.request<{
            isAdmin: boolean;
            libraryDeletionEnabled: boolean;
            canDelete: boolean;
        }>("/library/delete-policy");
    }

    async deleteTrack(trackId: string) {
        return this.request<{ message: string }>(`/library/tracks/${trackId}`, {
            method: "DELETE",
        });
    }

    async deleteAlbum(albumId: string) {
        return this.request<{ message: string; deletedFiles?: number }>(
            `/library/albums/${albumId}`,
            {
                method: "DELETE",
            }
        );
    }

    async deleteArtist(artistId: string) {
        return this.request<{ message: string; deletedFiles?: number }>(
            `/library/artists/${artistId}`,
            {
                method: "DELETE",
            }
        );
    }

    async getTrack(id: string) {
        return this.request<ApiData>(`/library/tracks/${id}`);
    }

    async getTrackPreference(trackId: string) {
        const isRemote = isRemoteTrack({ id: trackId });
        const basePath = isRemote ? "/library/remote-tracks" : "/library/tracks";
        return this.request<TrackPreferenceResponse>(
            `${basePath}/${encodeURIComponent(trackId)}/preference`
        );
    }

    async setTrackPreference(trackId: string, signal: TrackPreferenceSignal, metadata?: { title?: string; artist?: string; album?: string; thumbnailUrl?: string; duration?: number }) {
        const isRemote = isRemoteTrack({ id: trackId });
        const basePath = isRemote ? "/library/remote-tracks" : "/library/tracks";
        return this.request<TrackPreferenceResponse>(
            `${basePath}/${encodeURIComponent(trackId)}/preference`,
            {
                method: "POST",
                body: JSON.stringify({ signal, ...(metadata ? { metadata } : {}) }),
            }
        );
    }

    async setAlbumPreference(albumId: string, signal: TrackPreferenceSignal) {
        return this.request<AlbumPreferenceResponse>(
            `/library/albums/${encodeURIComponent(albumId)}/preference`,
            {
                method: "POST",
                body: JSON.stringify({ signal }),
            }
        );
    }

    // Lyrics
    async getLyrics(
        trackId: string,
        metadata?: {
            artist?: string;
            title?: string;
            album?: string;
            duration?: number;
        }
    ) {
        const encodedTrackId = encodeURIComponent(trackId);
        const params = new URLSearchParams();

        if (metadata?.artist) params.set("artist", metadata.artist);
        if (metadata?.title) params.set("title", metadata.title);
        if (metadata?.album) params.set("album", metadata.album);
        if (
            typeof metadata?.duration === "number" &&
            Number.isFinite(metadata.duration) &&
            metadata.duration > 0
        ) {
            params.set("duration", String(Math.round(metadata.duration)));
        }

        const query = params.toString();
        return this.request<{
            syncedLyrics: string | null;
            plainLyrics: string | null;
            source: string;
            synced: boolean;
        }>(`/lyrics/${encodedTrackId}${query ? `?${query}` : ""}`);
    }

    async clearLyricsCache(trackId: string) {
        return this.request<{ message: string }>(
            `/lyrics/${encodeURIComponent(trackId)}`,
            {
                method: "DELETE",
            }
        );
    }

    async getRadioTracks(type: string, value?: string, limit = 50) {
        const params = new URLSearchParams({ type, limit: String(limit) });
        if (value) params.append("value", value);
        return this.request<{ tracks: ApiData[] }>(
            `/library/radio?${params.toString()}`
        );
    }

    async getLikedPlaylist(params?: {
        limit?: number;
        cursorLikedAt?: string;
        cursorTrackId?: string;
    }) {
        const searchParams = new URLSearchParams();
        if (typeof params?.limit === "number") {
            searchParams.set("limit", String(params.limit));
        }
        if (params?.cursorLikedAt) {
            searchParams.set("cursorLikedAt", params.cursorLikedAt);
        }
        if (params?.cursorTrackId) {
            searchParams.set("cursorTrackId", params.cursorTrackId);
        }
        const queryString = searchParams.toString();
        return this.request<LikedPlaylistResponse>(
            `/library/liked${queryString ? `?${queryString}` : ""}`
        );
    }

    // Homepage
    async getHomepageGenres(limit = 4) {
        return this.request<ApiData[]>(`/homepage/genres?limit=${limit}`);
    }

    async getHomepageTopPodcasts(limit = 6) {
        return this.request<ApiData[]>(`/homepage/top-podcasts?limit=${limit}`);
    }

    async getPopularArtists(limit = 20) {
        return this.request<{ artists: ApiData[] }>(
            `/discover/popular-artists?limit=${limit}`
        );
    }

    async getLibraryHealth() {
        return this.request<{
            records: LibraryHealthRecord[];
            total: number;
        }>("/admin/library-health");
    }

    async dismissLibraryHealthRecord(recordId: string) {
        return this.request<{ success: boolean }>(
            `/admin/library-health/${recordId}`,
            { method: "DELETE" }
        );
    }

    async getTrackAnalysis(trackId: string) {
        return this.request<{
            id: string;
            title: string;
            analysisStatus: string;
            analysisError: string | null;
            analyzedAt: string | null;
            analysisVersion: string | null;
            analysisMode: string | null;
            bpm: number | null;
            beatsCount: number | null;
            key: string | null;
            keyScale: string | null;
            keyStrength: number | null;
            energy: number | null;
            loudness: number | null;
            dynamicRange: number | null;
            danceability: number | null;
            valence: number | null;
            arousal: number | null;
            instrumentalness: number | null;
            acousticness: number | null;
            speechiness: number | null;
            // MusiCNN mood predictions
            moodHappy: number | null;
            moodSad: number | null;
            moodRelaxed: number | null;
            moodAggressive: number | null;
            moodParty: number | null;
            moodAcoustic: number | null;
            moodElectronic: number | null;
            moodTags: string[] | null;
            essentiaGenres: string[] | null;
            lastfmTags: string[] | null;
        }>(`/analysis/track/${trackId}`);
    }

    // ── Local Track Quality ────────────────────────────────────────

    /**
     * Fetch audio quality metadata for a local (owned) track by probing
     * the file on disk. Used by the player UI to display quality info.
     */
    async getLocalTrackAudioInfo(
        trackId: string,
        options?: {
            playback?: boolean;
            quality?: "original" | "high" | "medium" | "low";
        }
    ): Promise<{
        codec: string | null;
        bitrate: number | null;
        sampleRate: number | null;
        bitDepth: number | null;
        lossless: boolean | null;
        channels: number | null;
    }> {
        const params = new URLSearchParams();
        if (options?.playback) {
            params.set("playback", "true");
        }
        if (options?.quality) {
            params.set("quality", options.quality);
        }
        const suffix = params.toString();
        return this.get(`/library/tracks/${trackId}/audio-info${suffix ? `?${suffix}` : ""}`);
    }

    // -----------------------------------------------------------------------
    // Track Mappings (persisted gap-fill / provider resolution)
    // -----------------------------------------------------------------------

    async getAlbumMappings(albumId: string): Promise<{
        mappings: Array<{
            id: string;
            trackId: string | null;
            trackTidalId: string | null;
            trackYtMusicId: string | null;
            confidence: number;
            source: string;
            stale: boolean;
            trackTidal: {
                id: string;
                tidalId: number;
                title: string;
                artist: string;
                album: string;
                duration: number;
                isrc?: string;
                quality?: string;
            } | null;
            trackYtMusic: {
                id: string;
                videoId: string;
                title: string;
                artist: string;
                album: string;
                duration: number;
                thumbnailUrl?: string;
            } | null;
        }>;
    }> {
        return this.get(`/track-mappings/album/${albumId}`);
    }
    }
    return LibraryApi;
}
