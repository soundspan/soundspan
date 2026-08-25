import { isPlainObject } from "../../utils/plainObject";

/** Result of applying the artist download expansion policy to a release group. */
export type ReleaseGroupEligibility =
    | { eligible: true }
    | {
          eligible: false;
          reason:
              | "wrong_primary_type"
              | "secondary_type"
              | "not_primary_credit"
              | "missing_credits";
      };

function readFirstArtistId(
    releaseGroup: Record<string, unknown>,
): string | null {
    const credits = releaseGroup["artist-credit"];
    if (!Array.isArray(credits) || credits.length === 0) return null;

    const firstCredit = credits[0];
    if (!isPlainObject(firstCredit)) return null;

    const artist = firstCredit.artist;
    if (!isPlainObject(artist)) return null;

    const artistId = artist.id;
    return typeof artistId === "string" && artistId.length > 0
        ? artistId
        : null;
}

/**
 * Classify an untrusted MusicBrainz release group for artist expansion.
 *
 * Eligible groups are Albums or EPs without secondary types and must credit
 * the requested artist first. Missing or malformed credit data fails closed.
 */
export function classifyReleaseGroup(
    releaseGroup: unknown,
    artistMbid: string,
): ReleaseGroupEligibility {
    if (!isPlainObject(releaseGroup)) {
        return { eligible: false, reason: "wrong_primary_type" };
    }
    const primaryType = releaseGroup["primary-type"];
    if (primaryType !== "Album" && primaryType !== "EP") {
        return { eligible: false, reason: "wrong_primary_type" };
    }
    const secondaryTypes = releaseGroup["secondary-types"];
    if (!Array.isArray(secondaryTypes) || secondaryTypes.length > 0) {
        return { eligible: false, reason: "secondary_type" };
    }
    const firstArtistId = readFirstArtistId(releaseGroup);
    if (firstArtistId === null) {
        return { eligible: false, reason: "missing_credits" };
    }
    const requestedArtistMbid = artistMbid.toLowerCase();
    if (firstArtistId.toLowerCase() !== requestedArtistMbid) {
        return { eligible: false, reason: "not_primary_credit" };
    }
    return { eligible: true };
}
