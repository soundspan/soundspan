import {
    normalizeTrackTitle,
    stripTrackSuffix,
} from "../../utils/trackMatching";
import {
    normalizeAlbumTitle,
    stripAlbumEdition,
} from "../../utils/artistNormalization";
import { stripDelimitedSegments } from "../../utils/stripDelimitedSegments";

type Titled = Readonly<{ title: string }>;
const FEATURE_SUFFIX = /^(?:feat\.?|ft\.?|featuring)\b/i;

function stripFeatureSuffix(title: string): string {
    return stripDelimitedSegments(
        stripTrackSuffix(title),
        "(",
        ")",
        (segment) => FEATURE_SUFFIX.test(segment.trim()),
        " ",
    );
}

function trackTitleKeys(title: string): readonly string[] {
    const rawFallback = title.toLowerCase();
    const normalizedTitle = normalizeTrackTitle(title) || rawFallback;
    const normalizedWithoutSuffix =
        normalizeTrackTitle(stripFeatureSuffix(title)) || rawFallback;
    return normalizedTitle === normalizedWithoutSuffix
        ? [normalizedTitle]
        : [normalizedTitle, normalizedWithoutSuffix];
}

/** Builds a first-writer-wins lookup for normalized artist-page track titles. */
export function buildArtistTrackTitleIndex<T extends Titled>(
    tracks: readonly T[],
): ReadonlyMap<string, T> {
    const tracksByTitle = new Map<string, T>();
    for (const track of tracks) {
        for (const key of trackTitleKeys(track.title)) {
            if (!tracksByTitle.has(key)) tracksByTitle.set(key, track);
        }
    }
    return tracksByTitle;
}

/** Finds a library track through the same normalized title variants. */
export function findArtistTrackByTitle<T extends Titled>(
    tracksByTitle: ReadonlyMap<string, T>,
    title: string,
): T | undefined {
    for (const key of trackTitleKeys(title)) {
        const track = tracksByTitle.get(key);
        if (track) return track;
    }
    return undefined;
}

function normalizeDiscographyAlbumTitle(title: string): string {
    return normalizeAlbumTitle(stripAlbumEdition(title));
}

/**
 * Removes discography rows an owned album stands for: by release group, or by
 * edition-stripped title for albums that are not remote placeholders.
 */
export function filterDistinctDiscographyAlbums<
    TOwned extends Titled & {
        source?: string;
        rgMbid?: string | null;
        matchedRgMbid?: string | null;
    },
    TRemote extends Titled & { rgMbid: string },
>(ownedAlbums: readonly TOwned[], remoteAlbums: readonly TRemote[]): TRemote[] {
    const ownedTitles = new Set(
        ownedAlbums
            .filter((album) => album.source !== "remote")
            .map((album) => normalizeDiscographyAlbumTitle(album.title)),
    );
    const ownedRgMbids = new Set(
        ownedAlbums.flatMap((album) =>
            [album.rgMbid, album.matchedRgMbid].filter(
                (rgMbid): rgMbid is string => Boolean(rgMbid),
            ),
        ),
    );
    return remoteAlbums.filter(
        (album) =>
            !ownedRgMbids.has(album.rgMbid) &&
            !ownedTitles.has(normalizeDiscographyAlbumTitle(album.title)),
    );
}
