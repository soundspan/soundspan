import { ApiClientCore, type ApiData } from "./api/core";
import { WithAuth } from "./api/auth";
import { WithConnectors } from "./api/connectors";
import { WithDiscover } from "./api/discover";
import { WithDownloads } from "./api/downloads";
import { WithImports } from "./api/imports";
import { WithLibrary } from "./api/library";
import { WithMedia } from "./api/media";
import { WithNotifications } from "./api/notifications";
import { WithPlaylists } from "./api/playlists";
import { WithPlays } from "./api/plays";
import { WithRecommendations } from "./api/recommendations";
import { WithSettings } from "./api/settings";
import type {
    YouTubePlaylistInfo,
    YouTubeDownloadJob,
} from "./youtube-bulk-download";
import type {
    CanonicalMediaSearchResult,
    ResolvedMediaSource,
    SegmentedStreamingSourceType,
} from "@soundspan/media-metadata-contract";

// Mood Mix Types (Legacy - for old presets endpoint)
export interface MoodPreset {
    id: string;
    name: string;
    color: string;
    params: MoodMixParams;
}

export interface MoodMixParams {
    // Basic audio features
    valence?: { min?: number; max?: number };
    energy?: { min?: number; max?: number };
    danceability?: { min?: number; max?: number };
    acousticness?: { min?: number; max?: number };
    instrumentalness?: { min?: number; max?: number };
    arousal?: { min?: number; max?: number };
    bpm?: { min?: number; max?: number };
    keyScale?: "major" | "minor";
    // ML mood predictions (require Enhanced mode analysis)
    moodHappy?: { min?: number; max?: number };
    moodSad?: { min?: number; max?: number };
    moodRelaxed?: { min?: number; max?: number };
    moodAggressive?: { min?: number; max?: number };
    moodParty?: { min?: number; max?: number };
    moodAcoustic?: { min?: number; max?: number };
    moodElectronic?: { min?: number; max?: number };
    limit?: number;
}

export interface AlbumRelease {
    guid: string;
    title: string;
    indexer: string;
    indexerId: number;
    infoUrl: string | null;
    size: number;
    sizeFormatted: string;
    seeders?: number;
    leechers?: number;
    protocol: string;
    quality: string;
    approved: boolean;
    rejected: boolean;
    rejections: string[];
}

export type ImportResolutionSource =
    | "local"
    | "youtube"
    | "tidal"
    | "unresolved";

export interface PlaylistImportResolvedTrack {
    index: number;
    artist: string;
    title: string;
    album?: string;
    trackId?: string;
    trackYtMusicId?: string;
    trackTidalId?: string;
    source: ImportResolutionSource;
    confidence: number;
    duration?: number;
}

export interface PlaylistImportSummary {
    total: number;
    local: number;
    youtube: number;
    tidal: number;
    unresolved: number;
}

export interface PlaylistImportPreviewResponse {
    playlistName: string;
    resolved: PlaylistImportResolvedTrack[];
    summary: PlaylistImportSummary;
}

export interface PlaylistImportExecuteResponse {
    playlistId: string;
    summary: PlaylistImportSummary;
}

/** Lifecycle states returned by generic playlist import jobs. */
export type ImportJobStatus =
    | "pending"
    | "resolving"
    | "creating_playlist"
    | "cancelling"
    | "completed"
    | "failed"
    | "cancelled";

export interface ImportJob {
    id: string;
    userId: string;
    sourceType: string;
    sourceId: string;
    sourceUrl: string;
    normalizedSource: string;
    playlistName: string;
    requestedPlaylistName: string | null;
    status: ImportJobStatus;
    progress: number;
    summary: PlaylistImportSummary;
    createdPlaylistId: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface LibraryHealthRecord {
    id: string;
    trackId: string;
    status: "MISSING_FROM_DISK" | "UNREADABLE_METADATA";
    filePath: string;
    detail: string | null;
    detectedAt: string;
    updatedAt: string;
    track?: {
        id: string;
        title: string;
        album?: { title: string; artist?: { name: string } };
    };
}

export interface ShareLinkRecord {
    id: string;
    token: string;
    userId: string;
    resourceType: "playlist" | "album" | "track";
    resourceId: string;
    expiresAt: string | null;
    maxPlays: number | null;
    playCount: number;
    revoked: boolean;
    createdAt: string;
    accessPath: string;
}

// New Mood Bucket Types (simplified mood system)
export type MoodType =
    | "happy"
    | "sad"
    | "chill"
    | "energetic"
    | "party"
    | "focus"
    | "melancholy"
    | "aggressive"
    | "acoustic";

export interface MoodBucketPreset {
    id: MoodType;
    name: string;
    color: string;
    icon: string;
    trackCount: number;
}

export interface MoodBucketMix {
    id: string;
    mood: MoodType;
    name: string;
    description: string;
    trackIds: string[];
    coverUrls: string[];
    trackCount: number;
    color: string;
    tracks?: ApiData[];
}

export interface SavedMoodMixResponse {
    success: boolean;
    mix: MoodBucketMix & { generatedAt: string };
}

// Vibe (CLAP Similarity) Types
export interface SimilarTrack {
    id: string;
    title: string;
    duration: number;
    trackNo: number;
    distance: number;
    album: {
        id: string;
        title: string;
        coverUrl: string | null;
    };
    artist: {
        id: string;
        name: string;
    };
}

export interface SimilarTracksResponse {
    sourceTrackId: string;
    tracks: SimilarTrack[];
}

export interface VibeSearchResponse {
    query: string;
    tracks: SimilarTrack[];
}

export interface VibeStatusResponse {
    totalTracks: number;
    embeddedTracks: number;
    progress: number;
    isComplete: boolean;
}

export type TrackPreferenceSignal = "thumbs_up" | "thumbs_down" | "clear";

export interface TrackPreferenceResponse {
    trackId: string;
    signal: TrackPreferenceSignal;
    state: "liked" | "disliked" | "neutral";
    score: number;
    likedAt: string | null;
    dislikedAt: string | null;
    updatedAt: string | null;
}

export interface AlbumPreferenceResponse {
    albumId: string;
    trackCount: number;
    signal: TrackPreferenceSignal;
    state: "liked" | "disliked" | "neutral";
    score: number;
    likedAt: string | null;
    dislikedAt: string | null;
    updatedAt: string | null;
}

export interface LikedPlaylistTrack {
    id: string;
    title: string;
    duration: number;
    trackNo: number | null;
    filePath: string | null;
    likedAt: string;
    source?: ResolvedMediaSource;
    provider?: {
        tidalTrackId: number | null;
        youtubeVideoId: string | null;
    };
    /** Present on remote (YouTube/Tidal) liked tracks */
    streamSource?: Exclude<ResolvedMediaSource, "local">;
    /** YouTube video ID — present when streamSource is "youtube" */
    youtubeVideoId?: string;
    /** Tidal track ID — present when streamSource is "tidal" */
    tidalTrackId?: number | string | null;
    artist: {
        id: string | null;
        name: string;
    };
    album: {
        id: string | null;
        title: string;
        coverArt: string | null;
    };
}

export interface LikedPlaylistCursor {
    likedAt: string;
    trackId: string;
}

export interface LikedPlaylistResponse {
    playlist: {
        id: string;
        name: string;
        description: string;
    };
    tracks: LikedPlaylistTrack[];
    total: number;
    pagination: {
        limit: number;
        hasMore: boolean;
        nextCursor: LikedPlaylistCursor | null;
    };
}

export interface SegmentedStreamingSessionResponse {
    sessionId: string;
    manifestUrl: string;
    sessionToken: string;
    expiresAt: string;
    playbackProfile?: {
        protocol?: "dash";
        sourceType?: SegmentedStreamingSourceType;
        quality?: "original" | "high" | "medium" | "low";
        manifestProfile?: "startup_single" | "steady_state_dual";
        codec?: string;
        bitrateKbps?: number;
    };
    engineHints?: {
        protocol?: "dash";
        sourceType?: SegmentedStreamingSourceType;
        recommendedEngine?: "videojs";
        assetBuildInFlight?: boolean;
    };
}

export interface CreateSegmentedStreamingSessionInput {
    trackId: string;
    sourceType?: SegmentedStreamingSourceType;
    desiredQuality?: "original" | "high" | "medium" | "low";
    manifestProfile?: "startup_single" | "steady_state_dual";
    startupLoadId?: number;
    startupCorrelationId?: string;
}

export interface SegmentedStreamingHeartbeatResponse {
    sessionId: string;
    sessionToken: string;
    expiresAt: string;
}

export interface SegmentedStreamingSnapshotInput {
    positionSec?: number;
    isPlaying?: boolean;
    bufferedUntilSec?: number;
}

export interface SegmentedStreamingHandoffResponse
    extends SegmentedStreamingSessionResponse {
    previousSessionId: string;
    resumeAtSec: number;
    shouldPlay: boolean;
}

export interface PlaybackClientMetricInput {
    event: string;
    fields?: Record<string, unknown>;
}

class ApiClient extends WithNotifications(WithDiscover(WithImports(WithDownloads(WithAuth(
    WithConnectors(WithSettings(WithPlays(WithRecommendations(WithMedia(
        WithPlaylists(WithLibrary(ApiClientCore))
    )))))
))))) {
    async getYtMusicMixes(): Promise<{
        mixes: Array<{ playlistId: string; title: string; description: string; thumbnails: Array<{ url: string; width: number }>; count: string | null }>;
    }> {
        return this.get("/browse/ytmusic/mixes");
    }

    // Audiobooks
    async getAudiobooks() {
        return this.request<ApiData[]>("/audiobooks");
    }

    async getAudiobook(id: string) {
        return this.request<ApiData>(`/audiobooks/${id}`);
    }

    async getAudiobookSeries(seriesName: string) {
        return this.request<ApiData[]>(
            `/audiobooks/series/${encodeURIComponent(seriesName)}`
        );
    }

    getAudiobookStreamUrl(id: string): string {
        const baseUrl = `${this.getBaseUrl()}/api/audiobooks/${id}/stream`;
        // For audio element requests, cookies may not be sent cross-origin in development
        // Add token as query param for authentication (supported by requireAuthOrToken)
        const token = this.getCurrentToken();
        if (token) {
            return `${baseUrl}?token=${encodeURIComponent(token)}`;
        }
        return baseUrl;
    }

    async updateAudiobookProgress(
        id: string,
        currentTime: number,
        duration: number,
        isFinished: boolean = false
    ) {
        return this.request<ApiData>(`/audiobooks/${id}/progress`, {
            method: "POST",
            body: JSON.stringify({ currentTime, duration, isFinished }),
        });
    }

    async deleteAudiobookProgress(id: string) {
        return this.request<ApiData>(`/audiobooks/${id}/progress`, {
            method: "DELETE",
        });
    }

    async getContinueListening() {
        return this.request<ApiData[]>("/audiobooks/continue-listening");
    }

    async searchAudiobooks(query: string) {
        return this.request<ApiData[]>(
            `/audiobooks/search?q=${encodeURIComponent(query)}`
        );
    }

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

    // Soulseek - P2P Music Search & Download
    async getSlskdStatus() {
        return this.request<{
            enabled: boolean;
            connected: boolean;
            username?: string;
            message?: string;
        }>("/soulseek/status");
    }

    async searchSoulseek(query: string) {
        return this.request<{ searchId: string; message: string }>(
            "/soulseek/search",
            {
                method: "POST",
                body: JSON.stringify({ query }),
            }
        );
    }

    async getSoulseekResults(searchId: string) {
        return this.request<{ results: ApiData[]; count: number }>(
            `/soulseek/search/${searchId}`
        );
    }

    async downloadFromSoulseek(
        username: string,
        filepath: string,
        filename?: string,
        size?: number,
        artist?: string,
        album?: string,
        title?: string
    ) {
        return this.request<{
            success: boolean;
            message: string;
            filename: string;
        }>("/soulseek/download", {
            method: "POST",
            body: JSON.stringify({
                username,
                filepath,
                filename,
                size,
                artist,
                album,
                title,
            }),
        });
    }

    // Enrichment
    async getEnrichmentSettings() {
        return this.request<ApiData>("/enrichment/settings");
    }

    async updateEnrichmentSettings(settings: ApiData) {
        return this.request<ApiData>("/enrichment/settings", {
            method: "PUT",
            body: JSON.stringify(settings),
        });
    }

    async enrichArtist(artistId: string) {
        return this.request<{
            success: boolean;
            confidence: number;
            data: ApiData;
        }>(`/enrichment/artist/${artistId}`, {
            method: "POST",
        });
    }

    async enrichAlbum(albumId: string) {
        return this.request<{
            success: boolean;
            confidence: number;
            data: ApiData;
        }>(`/enrichment/album/${albumId}`, {
            method: "POST",
        });
    }

    async startLibraryEnrichment() {
        return this.request<{ success: boolean; message: string }>(
            "/enrichment/start",
            {
                method: "POST",
            }
        );
    }

    async syncLibraryEnrichment() {
        return this.request<{
            message: string;
            description: string;
            result: {
                artists: number;
                tracks: number;
                audioQueued: number;
            };
        }>("/enrichment/sync", {
            method: "POST",
        });
    }

    async getEnrichmentProgress() {
        return this.request<{
            artists: {
                total: number;
                completed: number;
                pending: number;
                failed: number;
                progress: number;
            };
            trackTags: {
                total: number;
                enriched: number;
                pending: number;
                progress: number;
            };
            audioAnalysis: {
                total: number;
                completed: number;
                pending: number;
                processing: number;
                failed: number;
                progress: number;
                isBackground: boolean;
            };
            clapEmbeddings: {
                total: number;
                completed: number;
                pending: number;
                processing: number;
                failed: number;
                progress: number;
                isBackground: boolean;
            };
            coreComplete: boolean;
            isFullyComplete: boolean;
        }>("/enrichment/progress");
    }

    async triggerFullEnrichment(options?: {
        forceVibeRebuild?: boolean;
        forceMoodBucketBackfill?: boolean;
    }) {
        return this.request<{
            message: string;
            description: string;
            forceVibeRebuild?: boolean;
            forceMoodBucketBackfill?: boolean;
        }>(
            "/enrichment/full",
            {
                method: "POST",
                body: JSON.stringify({
                    forceVibeRebuild: options?.forceVibeRebuild === true,
                    forceMoodBucketBackfill:
                        options?.forceMoodBucketBackfill === true,
                }),
            }
        );
    }

    async resetArtistsOnly() {
        return this.request<{
            message: string;
            description: string;
            count: number;
        }>("/enrichment/reset-artists", { method: "POST" });
    }

    async resetMoodTagsOnly() {
        return this.request<{
            message: string;
            description: string;
            count: number;
        }>("/enrichment/reset-mood-tags", { method: "POST" });
    }

    async resetAudioAnalysisOnly() {
        return this.request<{
            message: string;
            description: string;
            count: number;
        }>("/enrichment/reset-audio-analysis", { method: "POST" });
    }

    async retryFailedAnalysis() {
        return this.request<{ message: string; reset: number }>("/analysis/retry-failed", {
            method: "POST",
        });
    }

    async updateArtistMetadata(
        artistId: string,
        data: {
            name?: string;
            bio?: string;
            genres?: string[];
            mbid?: string;
            heroUrl?: string;
        }
    ) {
        return this.request<ApiData>(`/enrichment/artists/${artistId}/metadata`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async updateAlbumMetadata(
        albumId: string,
        data: {
            title?: string;
            year?: number;
            genres?: string[];
            rgMbid?: string;
            coverUrl?: string;
        }
    ) {
        return this.request<ApiData>(`/enrichment/albums/${albumId}/metadata`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async updateTrackMetadata(trackId: string, data: ApiData) {
        return this.request<ApiData>(`/enrichment/tracks/${trackId}/metadata`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async resetArtistMetadata(artistId: string) {
        return this.request<{ message: string; artist: ApiData }>(
            `/enrichment/artists/${artistId}/reset`,
            { method: "POST" }
        );
    }

    async resetAlbumMetadata(albumId: string) {
        return this.request<{ message: string; album: ApiData }>(
            `/enrichment/albums/${albumId}/reset`,
            { method: "POST" }
        );
    }

    async resetTrackMetadata(trackId: string) {
        return this.request<{ message: string; track: ApiData }>(
            `/enrichment/tracks/${trackId}/reset`,
            { method: "POST" }
        );
    }

    async searchMusicBrainzArtists(query: string): Promise<{
        artists: Array<{
            mbid: string;
            name: string;
            disambiguation: string | null;
            country: string | null;
            type: string | null;
            score: number;
        }>;
    }> {
        return this.request(
            `/enrichment/search/musicbrainz/artists?q=${encodeURIComponent(query)}`
        );
    }

    async searchMusicBrainzReleaseGroups(
        query: string,
        artistName?: string
    ): Promise<{
        albums: Array<{
            rgMbid: string;
            title: string;
            primaryType: string;
            secondaryTypes: string[];
            firstReleaseDate: string | null;
            artistCredit: string;
            score: number;
        }>;
    }> {
        let url = `/enrichment/search/musicbrainz/release-groups?q=${encodeURIComponent(query)}`;
        if (artistName) {
            url += `&artist=${encodeURIComponent(artistName)}`;
        }
        return this.request(url);
    }

    // Vibe (CLAP Similarity) API
    async getVibeSimilarTracks(trackId: string, limit = 20) {
        return this.request<{
            sourceTrackId: string;
            sourceFeatures: {
                energy: number | null;
                valence: number | null;
                danceability: number | null;
                arousal: number | null;
            } | null;
            tracks: Array<{
                id: string;
                title: string;
                duration: number;
                trackNo: number;
                distance: number;
                album: {
                    id: string;
                    title: string;
                    coverUrl: string | null;
                };
                artist: {
                    id: string;
                    name: string;
                };
                audioFeatures: {
                    energy: number | null;
                    valence: number | null;
                    danceability: number | null;
                    arousal: number | null;
                };
            }>;
        }>(`/vibe/similar/${trackId}?limit=${limit}`);
    }

    async vibeSearch(query: string, limit = 20) {
        return this.request<{
            query: string;
            tracks: Array<{
                id: string;
                title: string;
                duration: number;
                trackNo: number;
                distance: number;
                similarity: number;
                album: {
                    id: string;
                    title: string;
                    coverUrl: string | null;
                };
                artist: {
                    id: string;
                    name: string;
                };
            }>;
            minSimilarity: number;
            totalAboveThreshold: number;
            debug?: {
                matchedTerms: string[];
                genreConfidence: number;
                featureWeight: number;
            };
        }>("/vibe/search", {
            method: "POST",
            body: JSON.stringify({ query, limit }),
        });
    }

    async getVibeStatus() {
        return this.request<{
            totalTracks: number;
            embeddedTracks: number;
            progress: number;
            isComplete: boolean;
        }>("/vibe/status");
    }

    async getVibeMap() {
        return this.request<{
            tracks: Array<{
                id: string;
                x: number;
                y: number;
                title: string;
                artist: string;
                artistId: string;
                albumId: string;
                coverUrl: string | null;
                dominantMood: string;
                moodScore: number;
                moods: Record<string, number>;
                energy: number | null;
                valence: number | null;
            }>;
            trackCount: number;
            computedAt: string;
        }>("/vibe/map");
    }

    async getVibePath(fromId: string, toId: string, steps = 5) {
        return this.request<{
            from: string;
            to: string;
            steps: Array<{
                id: string;
                title: string;
                distance: number;
                similarity: number;
                album: { id: string; title: string; coverUrl: string | null };
                artist: { id: string; name: string };
            }>;
        }>(`/vibe/path?from=${fromId}&to=${toId}&steps=${steps}`);
    }

    async vibeAlchemy(trackIds: string[], weights?: number[], limit = 20) {
        return this.request<{
            ingredients: string[];
            weights: number[];
            tracks: Array<{
                id: string;
                title: string;
                distance: number;
                similarity: number;
                album: { id: string; title: string; coverUrl: string | null };
                artist: { id: string; name: string };
            }>;
        }>("/vibe/alchemy", {
            method: "POST",
            body: JSON.stringify({ trackIds, weights, limit }),
        });
    }

    async getVibeJourney(params: {
        fromTrackId: string;
        toTrackId?: string;
        mood?: string;
        steps?: number;
        excludeTrackIds?: string[];
    }) {
        return this.request<{
            mode: "track" | "mood";
            target:
                | { trackId: string; title: string }
                | { mood: string; label: string };
            waypoints: Array<{
                id: string;
                title: string;
                distance: number;
                similarity: number;
                album: { id: string; title: string; coverUrl: string | null };
                artist: { id: string; name: string };
            }>;
        }>("/vibe/journey", {
            method: "POST",
            body: JSON.stringify(params),
        });
    }

    async getVibeMoods() {
        return this.request<
            Array<{
                mood: string;
                trackCount: number;
            }>
        >("/vibe/moods");
    }

    /**
     * Library-calibrated pairwise-distance quantiles (p0..p100, 101 values,
     * ascending) for scoring match percentages as "closer than N% of random
     * pairs in your library" instead of the fixed `1 - distance/2` mapping.
     * `sampleSize: 0` / `quantiles: []` on a library with fewer than 10
     * embedded tracks — callers fall back to the old linear mapping.
     */
    async getVibeCalibration() {
        return this.request<{
            sampleSize: number;
            updatedAt?: string;
            quantiles: number[];
        }>("/vibe/calibration");
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

    // ── YouTube Music ──────────────────────────────────────────────

    async getYtMusicStatus(): Promise<{
        enabled: boolean;
        available: boolean;
        authenticated: boolean;
        credentialsConfigured: boolean;
    }> {
        return this.request(`/ytmusic/status`);
    }

    async initiateYtMusicAuth(): Promise<{
        device_code: string;
        user_code: string;
        verification_url: string;
        expires_in: number;
        interval: number;
    }> {
        return this.post(`/ytmusic/auth/device-code`);
    }

    async pollYtMusicAuth(deviceCode: string): Promise<{
        status: "pending" | "success" | "error";
        error?: string;
    }> {
        return this.post(`/ytmusic/auth/device-code/poll`, { deviceCode });
    }

    async saveYtMusicOAuthToken(oauthJson: string): Promise<{ success: boolean }> {
        return this.post(`/ytmusic/auth/save-token`, { oauthJson });
    }

    async clearYtMusicAuth(): Promise<{ success: boolean }> {
        return this.post(`/ytmusic/auth/clear`);
    }

    async searchYtMusic(
        query: string,
        filter?: "songs" | "albums" | "artists" | "videos"
    ): Promise<{
        query: string;
        filter: "songs" | "albums" | "artists" | "videos" | null;
        total: number;
        results: CanonicalMediaSearchResult[];
    }> {
        return this.post(`/ytmusic/search`, { query, filter });
    }

    async getYtMusicAlbum(browseId: string): Promise<any> {
        return this.request(`/ytmusic/album/${browseId}`);
    }

    async getYtMusicArtist(channelId: string): Promise<any> {
        return this.request(`/ytmusic/artist/${channelId}`);
    }

    async getYtMusicSong(videoId: string): Promise<any> {
        return this.request(`/ytmusic/song/${videoId}`);
    }

    async matchYtMusicTrack(
        artist: string,
        title: string,
        albumTitle?: string,
        duration?: number,
        isrc?: string
    ): Promise<{
        match: { videoId: string; title: string; duration: number } | null;
    }> {
        return this.post(`/ytmusic/match`, {
            artist,
            title,
            albumTitle,
            duration,
            isrc,
        });
    }

    /**
     * Batch-match multiple tracks against YouTube Music in a single request.
     * Far faster than calling matchYtMusicTrack() N times because the
     * sidecar runs all searches concurrently via asyncio.gather.
     */
    async matchYtMusicBatch(
        tracks: Array<{
            artist: string;
            title: string;
            albumTitle?: string;
            duration?: number;
            isrc?: string;
        }>
    ): Promise<{
        matches: Array<{ videoId: string; title: string; duration: number } | null>;
    }> {
        return this.post(`/ytmusic/match-batch`, { tracks });
    }

    /**
     * Build a stream URL for YouTube Music playback.
     * Like getStreamUrl(), this returns a synchronous URL string
     * that the audio engine can load directly.
     */
    getYtMusicStreamUrl(videoId: string, quality?: string, usePublic?: boolean): string {
        const endpoint = usePublic ? "stream-public" : "stream";
        let url = `${this.getBaseUrl()}/api/ytmusic/${endpoint}/${videoId}`;
        const params = new URLSearchParams();
        if (quality) params.set("quality", quality);
        const token = this.getCurrentToken();
        if (token) params.set("token", token);
        const qs = params.toString();
        if (qs) url += `?${qs}`;
        return url;
    }

    /**
     * Fetch stream metadata (bitrate, codec, etc.) for a YouTube Music
     * video. Used by the player UI to display quality information.
     */
    async getYtMusicStreamInfo(
        videoId: string,
        quality?: string
    ): Promise<{
        videoId: string;
        abr: number;
        acodec: string;
        duration: number;
        content_type: string;
    }> {
        const params = new URLSearchParams();
        if (quality) params.set("quality", quality);
        const qs = params.toString();
        const suffix = qs ? `?${qs}` : "";
        // Use the public endpoint (no per-user YT Music OAuth required) —
        // consistent with stream-public used for playback.
        return this.get(`/ytmusic/stream-info-public/${videoId}${suffix}`);
    }

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

    // ── TIDAL Streaming ────────────────────────────────────────────

    async getTidalStreamingStatus(): Promise<{
        enabled: boolean;
        available: boolean;
        authenticated: boolean;
        credentialsConfigured: boolean;
    }> {
        return this.request(`/tidal-streaming/status`);
    }

    async initiateTidalAuth(): Promise<{
        device_code: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete: string;
        expires_in: number;
        interval: number;
    }> {
        return this.post(`/tidal-streaming/auth/device-code`);
    }

    async pollTidalAuth(deviceCode: string): Promise<{
        status: "pending" | "success" | "error";
        username?: string;
        country_code?: string;
        error?: string;
    }> {
        return this.post(`/tidal-streaming/auth/device-code/poll`, { deviceCode });
    }

    async clearTidalStreamingAuth(): Promise<{ success: boolean }> {
        return this.post(`/tidal-streaming/auth/clear`);
    }

    async searchTidalStreaming(query: string): Promise<{
        tracks: any[];
        albums: any[];
        artists: any[];
    }> {
        return this.post(`/tidal-streaming/search`, { query });
    }

    async matchTidalTrack(
        artist: string,
        title: string,
        albumTitle?: string,
        duration?: number,
        isrc?: string
    ): Promise<{
        match: { id: number; title: string; artist: string; duration: number; isrc?: string } | null;
    }> {
        return this.post(`/tidal-streaming/match`, {
            artist,
            title,
            albumTitle,
            duration,
            isrc,
        });
    }

    /**
     * Batch-match multiple tracks against TIDAL in a single request.
     * Used for gap-fill on album and artist pages.
     */
    async matchTidalBatch(
        tracks: Array<{
            artist: string;
            title: string;
            albumTitle?: string;
            duration?: number;
            isrc?: string;
        }>
    ): Promise<{
        matches: Array<{ id: number; title: string; artist: string; duration: number; isrc?: string } | null>;
    }> {
        return this.post(`/tidal-streaming/match-batch`, { tracks });
    }

    /**
     * Build a stream URL for TIDAL playback.
     * Returns a synchronous URL string that the audio engine can load.
     */
    getTidalStreamUrl(trackId: number, quality?: string): string {
        let url = `${this.getBaseUrl()}/api/tidal-streaming/stream/${trackId}`;
        const params = new URLSearchParams();
        if (quality) params.set("quality", quality);
        const token = this.getCurrentToken();
        if (token) params.set("token", token);
        const qs = params.toString();
        if (qs) url += `?${qs}`;
        return url;
    }

    /**
     * Fetch stream metadata (quality, codec) for a TIDAL track.
     */
    async getTidalStreamInfo(
        trackId: number,
        quality?: string
    ): Promise<{
        trackId: number;
        quality: string;
        acodec: string;
        content_type: string;
        bit_depth?: number;
        sample_rate?: number;
    }> {
        const params = new URLSearchParams();
        if (quality) params.set("quality", quality);
        const qs = params.toString();
        const suffix = qs ? `?${qs}` : "";
        return this.get(`/tidal-streaming/stream-info/${trackId}${suffix}`);
    }

    // ── TIDAL Browse ──────────────────────────────────────────────

    getTidalBrowseImageUrl(externalUrl: string): string {
        const baseUrl = this.getBaseUrl();
        const token = this.getCurrentToken();
        const params = new URLSearchParams({ url: externalUrl });
        if (token) params.append("token", token);
        return `${baseUrl}/api/browse/tidal/image?${params.toString()}`;
    }

    async getTidalHomeShelves(): Promise<{
        shelves: Array<{ title: string; contents: Array<{ type: string; playlistId?: string; mixId?: string; albumId?: string; title: string; thumbnailUrl: string | null; subtitle?: string }> }>;
    }> {
        return this.get("/browse/tidal/home");
    }

    async getTidalExploreShelves(): Promise<{
        shelves: Array<{ title: string; contents: Array<{ type: string; playlistId?: string; mixId?: string; albumId?: string; title: string; thumbnailUrl: string | null; subtitle?: string }> }>;
    }> {
        return this.get("/browse/tidal/explore");
    }

    async getTidalGenres(): Promise<{
        genres: Array<{ name: string; path: string; hasPlaylists: boolean; imageUrl: string | null }>;
    }> {
        return this.get("/browse/tidal/genres");
    }

    async getTidalMoods(): Promise<{
        moods: Array<{ name: string; path: string; hasPlaylists: boolean; imageUrl: string | null }>;
    }> {
        return this.get("/browse/tidal/moods");
    }

    async getTidalMixes(): Promise<{
        mixes: Array<{ mixId: string; title: string; subTitle: string; thumbnailUrl: string | null }>;
    }> {
        return this.get("/browse/tidal/mixes");
    }

    async getTidalGenrePlaylists(path: string): Promise<{
        playlists: Array<{ playlistId: string; title: string; thumbnailUrl: string | null; numTracks: number }>;
    }> {
        return this.get(`/browse/tidal/genre-playlists?path=${encodeURIComponent(path)}`);
    }

    async getTidalBrowsePlaylist(id: string, limit?: number): Promise<{
        id: string;
        title: string;
        trackCount: number;
        thumbnailUrl: string | null;
        tracks: Array<{ trackId: number; title: string; artist: string; artists: string[]; album: string; duration: number; isrc: string | null; thumbnailUrl: string | null }>;
    }> {
        const params = new URLSearchParams();
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        return this.get(`/browse/tidal/playlist/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`);
    }

    async getTidalBrowseMix(id: string): Promise<{
        id: string;
        title: string;
        trackCount: number;
        thumbnailUrl: string | null;
        tracks: Array<{ trackId: number; title: string; artist: string; artists: string[]; album: string; duration: number; isrc: string | null; thumbnailUrl: string | null }>;
    }> {
        return this.get(`/browse/tidal/mix/${encodeURIComponent(id)}`);
    }

    // -----------------------------------------------------------------------
    // Listen Together (cold path — create, join, discover, leave, end)
    // -----------------------------------------------------------------------

    async createListenGroup(options: {
        name?: string;
        visibility?: "public" | "private";
        queueTrackIds?: string[];
        queueTracks?: Array<{
            trackId?: string;
            tidalTrackId?: number;
            youtubeVideoId?: string;
            title?: string;
            artist?: string;
            album?: string;
            duration?: number;
            thumbnailUrl?: string;
            isrc?: string;
        }>;
        currentTrackId?: string;
        currentTimeMs?: number;
        isPlaying?: boolean;
    } = {}): Promise<ApiData> {
        return this.post("/listen-together", options);
    }

    async joinListenGroup(joinCode: string): Promise<ApiData> {
        return this.post("/listen-together/join", { joinCode });
    }

    async discoverListenGroups(): Promise<ApiData> {
        return this.get("/listen-together/discover");
    }

    async getActiveListenGroupCount(): Promise<{ count: number }> {
        return this.get("/listen-together/active-count");
    }

    async getMyListenGroup(): Promise<ApiData> {
        return this.get("/listen-together/mine");
    }

    async leaveListenGroup(groupId: string): Promise<ApiData> {
        return this.post(`/listen-together/${groupId}/leave`);
    }

    async endListenGroup(groupId: string): Promise<ApiData> {
        return this.post(`/listen-together/${groupId}/end`);
    }
}

// Create a singleton instance without passing baseUrl - it will be determined dynamically
export const api = new ApiClient();
