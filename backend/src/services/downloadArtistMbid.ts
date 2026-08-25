import { logger } from "../utils/logger";
import { musicBrainzService } from "./musicbrainz";

const log = logger.child?.("DownloadArtistMbid") ?? logger;

/** Return a known artist MBID or resolve it from an album release group. */
export async function resolveDownloadArtistMbid(
    albumMbid: string,
    providedArtistMbid?: string,
): Promise<string | undefined> {
    if (providedArtistMbid) return providedArtistMbid;
    try {
        const releaseGroup =
            await musicBrainzService.getReleaseGroup(albumMbid);
        const artistMbid = releaseGroup?.["artist-credit"]?.[0]?.artist?.id;
        if (artistMbid) {
            log.debug("Resolved artist MBID for album download", {
                albumMbid,
                artistMbid,
            });
        } else {
            log.warn("Release group has no artist MBID", { albumMbid });
        }
        return artistMbid;
    } catch (error) {
        log.error("Failed to resolve artist MBID for album download", {
            albumMbid,
            error,
        });
        return undefined;
    }
}
