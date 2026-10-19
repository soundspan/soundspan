import {
    normalizeTidalTrack,
    normalizeYtMusicTrack,
} from "../unifiedTrackResponse";
import type { HydratedRemoteLibraryTrack } from "./types";

function normalizeRemoteTrack(row: HydratedRemoteLibraryTrack) {
    const linkedArtist =
        row.track.artistEntity ?? row.track.albumEntity?.artist ?? null;
    const common = {
        ...row.track,
        artist: linkedArtist?.name ?? row.track.artist,
        album: row.track.albumEntity?.title ?? row.track.album,
        artistId: row.artistId ?? row.albumArtistId,
        albumId: row.track.albumEntity?.id ?? null,
    };
    return row.provider === "tidal"
        ? normalizeTidalTrack({ ...common, tidalId: row.track.tidalId })
        : normalizeYtMusicTrack({
              ...common,
              videoId: row.track.videoId,
              thumbnailUrl: row.track.thumbnailUrl,
          });
}

/** Adapts one remote-set row to the established Library track response. */
export function toLibraryRemoteTrack(row: HydratedRemoteLibraryTrack) {
    const normalized = normalizeRemoteTrack(row);
    const linkedAlbum = row.track.albumEntity;
    const coverArt = linkedAlbum?.coverUrl ?? normalized.album.coverArt;
    return {
        ...normalized,
        streamSource: row.provider,
        ...(normalized.provider.tidalTrackId !== null
            ? { tidalTrackId: normalized.provider.tidalTrackId }
            : {}),
        ...(normalized.provider.youtubeVideoId !== null
            ? { youtubeVideoId: normalized.provider.youtubeVideoId }
            : {}),
        albumId: normalized.album.id,
        artistId: normalized.artist.id,
        trackNumber: normalized.trackNo,
        peer: undefined,
        album: {
            ...normalized.album,
            rgMbid: linkedAlbum?.rgMbid ?? null,
            matchedRgMbid: row.albumMatchedRgMbid,
            matchedInLibrary: row.albumMatchedInLibrary,
            coverArt,
            coverUrl: coverArt,
            artistId: normalized.artist.id,
            artist: normalized.artist,
        },
    };
}
