import { SpotifyImportPendingTrackService } from "./pendingTracks";
import {
    createPrismaRetryProxy,
    isRetryableSpotifyImportPrismaError,
    isRetryableSpotifyImportRedisError,
} from "./state";

export type {
    AlbumToDownload,
    ImportJob,
    ImportPreview,
    MatchedTrack,
} from "./types";

class SpotifyImportService extends SpotifyImportPendingTrackService {}

export const spotifyImportService = new SpotifyImportService();

export const __spotifyImportTestables = {
    createPrismaRetryProxy,
    isRetryableSpotifyImportPrismaError,
    isRetryableSpotifyImportRedisError,
};
