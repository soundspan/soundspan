import { resolveRemoteAlbumMbids } from "../../services/remoteAlbumMbidResolution";
import { runWithSchedulerClaim } from "../../utils/schedulerClaim";

const CLAIM_TTL_MS = 90 * 60_000;

/** Run remote-album MusicBrainz resolution under the cluster scheduler claim. */
export async function processRemoteAlbumMbidResolution(): Promise<boolean> {
    const claim = await runWithSchedulerClaim(
        "scheduler-claim:remote-album-mbid-resolution",
        CLAIM_TTL_MS,
        "remote album MusicBrainz resolution",
        () => resolveRemoteAlbumMbids(),
    );
    return claim.acquired;
}
