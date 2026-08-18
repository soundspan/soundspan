import { ApiClientCore, type ApiData } from "./api/core";
import { WithAuth } from "./api/auth";
import { WithAudiobooks } from "./api/audiobooks";
import { WithConnectors } from "./api/connectors";
import { WithEnrichment } from "./api/enrichment";
import { WithFederation } from "./api/federation";
import { WithDiscover } from "./api/discover";
import { WithDownloads } from "./api/downloads";
import { WithImports } from "./api/imports";
import { WithLibrary } from "./api/library";
import { WithListenGroups } from "./api/listenGroups";
import { WithMedia } from "./api/media";
import { WithMetadata } from "./api/metadata";
import { WithNotifications } from "./api/notifications";
import { WithPlaylists } from "./api/playlists";
import { WithPodcasts } from "./api/podcasts";
import { WithPlays } from "./api/plays";
import { WithRecommendations } from "./api/recommendations";
import { WithSettings } from "./api/settings";
import { WithSoulseek } from "./api/soulseek";
import { WithTidal } from "./api/tidal";
import { WithVibe } from "./api/vibe";
import { WithYouTube } from "./api/youtube";
import { WithYtMusic } from "./api/ytmusic";
import type {
    ResolvedMediaSource,
    SegmentedStreamingSourceType,
} from "@soundspan/media-metadata-contract";

export { vibeErrorMessage } from "./api/vibe";

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

/** Reasons a playlist item can be retained but unavailable for playback. */
export type PlaylistPlaybackReason =
    | "provider_unavailable"
    | "duration_mismatch"
    | "low_confidence_mapping"
    | "stale_mapping"
    | "missing_provider_track"
    | "track_removed"
    | "peer_offline"
    | "pending_import";

/** Playback availability metadata returned with a playlist item. */
export interface PlaylistPlaybackMeta {
    isPlayable: boolean;
    reason: PlaylistPlaybackReason | null;
    message: string | null;
}

/** Provider metadata returned with a resolved playlist item. */
export interface PlaylistTrackProvider {
    source: "local" | "tidal" | "youtube" | "federated" | "unknown";
    label?: string;
    tidalTrackId?: number | null;
    youtubeVideoId?: string | null;
}

/** Track data rendered by the playlist detail route. */
export interface PlaylistDetailTrack {
    id: string;
    title: string;
    duration: number;
    streamSource?: "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    source?: "local" | "tidal" | "youtube" | "federated";
    peer?: { id: string; name: string; online: boolean };
    album: {
        id?: string;
        title: string;
        coverArt?: string | null;
        artist: {
            id?: string;
            name: string;
        };
    };
}

/** Resolved track item returned by the playlist detail endpoint. */
export interface PlaylistDetailTrackItem {
    id: string;
    type: "track";
    sort: number;
    track: PlaylistDetailTrack | null;
    trackId?: string | null;
    provider?: PlaylistTrackProvider;
    playback?: PlaylistPlaybackMeta;
}

/** Pending import item returned by the playlist detail endpoint. */
export interface PlaylistPendingTrackItem {
    id: string;
    type: "pending";
    sort: number;
    pending: {
        id: string;
        artist: string;
        title: string;
        album: string;
        previewUrl: string | null;
    };
}

/** Typed response from GET /api/playlists/:id. */
export interface PlaylistDetailResponse {
    id: string;
    name: string;
    isOwner: boolean;
    isHidden: boolean;
    isPublic: boolean;
    user?: { username: string };
    items: PlaylistDetailTrackItem[];
    pendingTracks: PlaylistPendingTrackItem[];
    pendingCount: number;
    unplayableCount?: number;
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
        removedAt: string | null;
        album?: { title: string; artist?: { name: string } };
    };
}

/** Typed response from GET /api/admin/library-health. */
export interface LibraryHealthResponse {
    records: LibraryHealthRecord[];
    total: number;
    removedPendingPurgeCount: number;
    trackRemovalRetentionDays: number;
}

/** Typed response from POST /api/admin/library-health/purge-removed. */
export interface PurgeRemovedTracksResponse {
    enqueued: boolean;
    matched: number;
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

export interface SegmentedStreamingHandoffResponse extends SegmentedStreamingSessionResponse {
    previousSessionId: string;
    resumeAtSec: number;
    shouldPlay: boolean;
}

export interface PlaybackClientMetricInput {
    event: string;
    fields?: Record<string, unknown>;
}

class ApiClient extends WithListenGroups(
    WithFederation(
        WithTidal(
            WithYouTube(
                WithYtMusic(
                    WithVibe(
                        WithAudiobooks(
                            WithPodcasts(
                                WithSoulseek(
                                    WithEnrichment(
                                        WithMetadata(
                                            WithNotifications(
                                                WithDiscover(
                                                    WithImports(
                                                        WithDownloads(
                                                            WithAuth(
                                                                WithConnectors(
                                                                    WithSettings(
                                                                        WithPlays(
                                                                            WithRecommendations(
                                                                                WithMedia(
                                                                                    WithPlaylists(
                                                                                        WithLibrary(
                                                                                            ApiClientCore,
                                                                                        ),
                                                                                    ),
                                                                                ),
                                                                            ),
                                                                        ),
                                                                    ),
                                                                ),
                                                            ),
                                                        ),
                                                    ),
                                                ),
                                            ),
                                        ),
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        ),
    ),
) {}

// Create a singleton instance without passing baseUrl - it will be determined dynamically
export const api = new ApiClient();
