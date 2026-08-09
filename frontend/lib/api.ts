import { ApiClientCore, type ApiData } from "./api/core";
import { WithAuth } from "./api/auth";
import { WithAudiobooks } from "./api/audiobooks";
import { WithConnectors } from "./api/connectors";
import { WithEnrichment } from "./api/enrichment";
import { WithDiscover } from "./api/discover";
import { WithDownloads } from "./api/downloads";
import { WithImports } from "./api/imports";
import { WithLibrary } from "./api/library";
import { WithMedia } from "./api/media";
import { WithMetadata } from "./api/metadata";
import { WithNotifications } from "./api/notifications";
import { WithPlaylists } from "./api/playlists";
import { WithPodcasts } from "./api/podcasts";
import { WithPlays } from "./api/plays";
import { WithRecommendations } from "./api/recommendations";
import { WithSettings } from "./api/settings";
import { WithSoulseek } from "./api/soulseek";
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

class ApiClient extends WithAudiobooks(WithPodcasts(WithSoulseek(WithEnrichment(WithMetadata(
    WithNotifications(WithDiscover(WithImports(WithDownloads(WithAuth(
        WithConnectors(WithSettings(WithPlays(WithRecommendations(WithMedia(
            WithPlaylists(WithLibrary(ApiClientCore))
        )))))
    )))))
))))) {
    async getYtMusicMixes(): Promise<{
        mixes: Array<{ playlistId: string; title: string; description: string; thumbnails: Array<{ url: string; width: number }>; count: string | null }>;
    }> {
        return this.get("/browse/ytmusic/mixes");
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
