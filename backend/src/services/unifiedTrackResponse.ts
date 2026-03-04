/**
 * Canonical normalized track contract used across local and remote sources.
 */
export interface UnifiedTrackResponse {
    id: string;
    title: string;
    duration: number;
    trackNo: number | null;
    artist: { id: string | null; name: string };
    album: { id: string | null; title: string; coverArt: string | null };
    source: "local" | "tidal" | "youtube";
    provider: {
        tidalTrackId: number | null;
        youtubeVideoId: string | null;
    };
    filePath?: string;
    displayTitle?: string | null;
}

export interface UnifiedLocalTrackRecord {
    id: string;
    title: string;
    duration: number;
    trackNo?: number | null;
    trackNumber?: number | null;
    filePath?: string | null;
    displayTitle?: string | null;
    album: {
        id?: string | null;
        title: string;
        coverUrl?: string | null;
        coverArt?: string | null;
        artist: {
            name: string;
            id?: string | null;
            mbid?: string | null;
            [key: string]: unknown;
        };
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export interface UnifiedTrackTidalRecord {
    id: string;
    tidalId: number;
    title: string;
    artist: string;
    album: string;
    duration: number;
    artistId?: string | null;
    albumId?: string | null;
}

export interface UnifiedTrackYtMusicRecord {
    id: string;
    videoId: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    thumbnailUrl?: string | null;
    artistId?: string | null;
    albumId?: string | null;
}

export interface UnifiedPlaylistItemRecord {
    id: string;
    playlistId: string;
    trackId: string | null;
    trackTidalId: string | null;
    trackYtMusicId: string | null;
    sort: number;
    track: UnifiedLocalTrackRecord | null;
    trackTidal: UnifiedTrackTidalRecord | null;
    trackYtMusic: UnifiedTrackYtMusicRecord | null;
}

export interface UnifiedPlaylistTrackItemResponse {
    id: string;
    playlistId: string;
    trackId: string | null;
    trackTidalId: string | null;
    trackYtMusicId: string | null;
    sort: number;
    type: "track";
    provider: {
        source: "local" | "tidal" | "youtube" | "unknown";
        label: "LOCAL" | "TIDAL" | "YOUTUBE" | "UNKNOWN";
        tidalTrackId: number | null;
        youtubeVideoId: string | null;
    };
    playback: {
        isPlayable: boolean;
        reason: string | null;
        message: string | null;
    };
    track: Record<string, unknown> | null;
}

/**
 * Normalize a local library track row into the canonical unified track contract.
 */
export function normalizeLocalTrack(
    track: UnifiedLocalTrackRecord
): UnifiedTrackResponse {
    return {
        id: track.id,
        title: track.title,
        duration: track.duration,
        trackNo:
            typeof track.trackNo === "number"
                ? track.trackNo
                : typeof track.trackNumber === "number"
                ? track.trackNumber
                : null,
        artist: {
            id:
                typeof track.album.artist.id === "string"
                    ? track.album.artist.id
                    : null,
            name: track.album.artist.name || "Unknown Artist",
        },
        album: {
            id: typeof track.album.id === "string" ? track.album.id : null,
            title: track.album.title || "Unknown Album",
            coverArt: track.album.coverUrl ?? track.album.coverArt ?? null,
        },
        source: "local",
        provider: {
            tidalTrackId: null,
            youtubeVideoId: null,
        },
        ...(typeof track.filePath === "string"
            ? { filePath: track.filePath }
            : {}),
        displayTitle:
            typeof track.displayTitle === "string" ? track.displayTitle : null,
    };
}

/**
 * Normalize a materialized TIDAL track row into the canonical unified track contract.
 */
export function normalizeTidalTrack(
    tidal: UnifiedTrackTidalRecord
): UnifiedTrackResponse {
    const tidalTrackId = Number(tidal.tidalId);
    const hasValidTidalTrackId = Number.isFinite(tidalTrackId) && tidalTrackId > 0;

    return {
        id: hasValidTidalTrackId
            ? `tidal:${tidalTrackId}`
            : `tidal:missing:${tidal.id}`,
        title: tidal.title,
        duration: tidal.duration,
        trackNo: null,
        artist: {
            id: tidal.artistId ?? null,
            name: tidal.artist || "Unknown Artist",
        },
        album: {
            id: tidal.albumId ?? null,
            title: tidal.album || "Unknown Album",
            coverArt: null,
        },
        source: "tidal",
        provider: {
            tidalTrackId: hasValidTidalTrackId ? tidalTrackId : null,
            youtubeVideoId: null,
        },
    };
}

/**
 * Normalize a materialized YouTube Music track row into the canonical unified track contract.
 */
export function normalizeYtMusicTrack(
    yt: UnifiedTrackYtMusicRecord
): UnifiedTrackResponse {
    const youtubeVideoId =
        typeof yt.videoId === "string" ? yt.videoId.trim() : "";
    const hasValidVideoId = youtubeVideoId.length > 0;

    return {
        id: hasValidVideoId ? `yt:${youtubeVideoId}` : `yt:missing:${yt.id}`,
        title: yt.title,
        duration: yt.duration,
        trackNo: null,
        artist: {
            id: yt.artistId ?? null,
            name: yt.artist || "Unknown Artist",
        },
        album: {
            id: yt.albumId ?? null,
            title: yt.album || "Single",
            coverArt: yt.thumbnailUrl || null,
        },
        source: "youtube",
        provider: {
            tidalTrackId: null,
            youtubeVideoId: hasValidVideoId ? youtubeVideoId : null,
        },
    };
}

function toLegacyCompatibleTrackShape(
    normalized: UnifiedTrackResponse
): Record<string, unknown> {
    return {
        ...normalized,
        ...(normalized.source !== "local"
            ? { streamSource: normalized.source }
            : {}),
        ...(normalized.provider.tidalTrackId !== null
            ? { tidalTrackId: normalized.provider.tidalTrackId }
            : {}),
        ...(normalized.provider.youtubeVideoId !== null
            ? { youtubeVideoId: normalized.provider.youtubeVideoId }
            : {}),
        album: {
            ...normalized.album,
            artist: normalized.artist,
        },
    };
}

function buildBaseTrackItem(
    item: UnifiedPlaylistItemRecord
): Omit<UnifiedPlaylistTrackItemResponse, "provider" | "playback" | "track"> {
    return {
        id: item.id,
        playlistId: item.playlistId,
        trackId: item.trackId,
        trackTidalId: item.trackTidalId,
        trackYtMusicId: item.trackYtMusicId,
        sort: item.sort,
        type: "track",
    };
}

function normalizeUnknownTrackItem(
    item: UnifiedPlaylistItemRecord
): UnifiedPlaylistTrackItemResponse {
    return {
        ...buildBaseTrackItem(item),
        provider: {
            source: "unknown",
            label: "UNKNOWN",
            tidalTrackId: null,
            youtubeVideoId: null,
        },
        playback: {
            isPlayable: false,
            reason: "missing_provider_track",
            message:
                "Playback is unavailable because this playlist item no longer has an attached track source.",
        },
        track: null,
    };
}

/**
 * Playlist response formatter that keeps existing provider/playback wrappers while
 * emitting normalized track content from canonical local/tidal/youtube normalizers.
 */
export function formatUnifiedTrackItem(
    item: UnifiedPlaylistItemRecord
): UnifiedPlaylistTrackItemResponse {
    if (item.track) {
        const normalizedTrack = normalizeLocalTrack(item.track);
        return {
            ...buildBaseTrackItem(item),
            provider: {
                source: "local",
                label: "LOCAL",
                tidalTrackId: null,
                youtubeVideoId: null,
            },
            playback: {
                isPlayable: true,
                reason: null,
                message: null,
            },
            track: toLegacyCompatibleTrackShape(normalizedTrack),
        };
    }

    if (item.trackTidal) {
        const normalizedTrack = normalizeTidalTrack(item.trackTidal);
        const isPlayable = normalizedTrack.provider.tidalTrackId !== null;
        return {
            ...buildBaseTrackItem(item),
            provider: {
                source: "tidal",
                label: "TIDAL",
                tidalTrackId: normalizedTrack.provider.tidalTrackId,
                youtubeVideoId: null,
            },
            playback: isPlayable
                ? {
                      isPlayable: true,
                      reason: null,
                      message: null,
                  }
                : {
                      isPlayable: false,
                      reason: "missing_tidal_track_id",
                      message:
                          "Playback is unavailable because this TIDAL item is missing a valid track id.",
                  },
            track: toLegacyCompatibleTrackShape(normalizedTrack),
        };
    }

    if (item.trackYtMusic) {
        const normalizedTrack = normalizeYtMusicTrack(item.trackYtMusic);
        const isPlayable = normalizedTrack.provider.youtubeVideoId !== null;
        return {
            ...buildBaseTrackItem(item),
            provider: {
                source: "youtube",
                label: "YOUTUBE",
                tidalTrackId: null,
                youtubeVideoId: normalizedTrack.provider.youtubeVideoId,
            },
            playback: isPlayable
                ? {
                      isPlayable: true,
                      reason: null,
                      message: null,
                  }
                : {
                      isPlayable: false,
                      reason: "missing_youtube_video_id",
                      message:
                          "Playback is unavailable because this YouTube Music item is missing a video id.",
                  },
            track: toLegacyCompatibleTrackShape(normalizedTrack),
        };
    }

    return normalizeUnknownTrackItem(item);
}
