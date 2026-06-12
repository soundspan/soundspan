import type { Track } from "@/lib/audio-state-context";

export interface RadioMosaicCandidate {
    id: string;
    artistKey: string;
    coverArt: string;
}

/**
 * Builds artwork candidates from radio tracks, skipping entries without cover art.
 */
export const createRadioMosaicCandidates = (
    tracks: Track[]
): RadioMosaicCandidate[] => {
    return tracks
        .filter((track) => Boolean(track?.album?.coverArt))
        .map((track) => ({
            id: track.id,
            artistKey:
                track.artist?.id ||
                track.artist?.name?.trim().toLowerCase() ||
                `unknown:${track.id}`,
            coverArt: track.album.coverArt as string,
        }));
};

/**
 * Selects mosaic tiles while maximizing unique artist and cover-art usage first.
 *
 * Uses the same multi-phase algorithm as `selectMosaicCovers` in
 * `@/utils/mosaicCoverSelection` — kept inline here because the unit test
 * runner (`--experimental-strip-types`) cannot resolve `@/` path aliases
 * for value imports. New call sites should use the shared utility directly.
 */
export const selectRadioMosaicTiles = (
    candidates: RadioMosaicCandidate[],
    tileCount = 6
): RadioMosaicCandidate[] => {
    if (tileCount <= 0 || candidates.length === 0) {
        return [];
    }

    const selected: RadioMosaicCandidate[] = [];
    const selectedKeys = new Set<string>();
    const usedArtists = new Set<string>();
    const usedCovers = new Set<string>();

    const pushCandidate = (candidate: RadioMosaicCandidate) => {
        const key = `${candidate.id}::${candidate.artistKey}::${candidate.coverArt}`;
        if (selectedKeys.has(key)) {
            return false;
        }
        selected.push(candidate);
        selectedKeys.add(key);
        usedArtists.add(candidate.artistKey);
        usedCovers.add(candidate.coverArt);
        return true;
    };

    for (const candidate of candidates) {
        if (selected.length >= tileCount) {
            break;
        }
        if (
            !usedArtists.has(candidate.artistKey) &&
            !usedCovers.has(candidate.coverArt)
        ) {
            pushCandidate(candidate);
        }
    }

    for (const candidate of candidates) {
        if (selected.length >= tileCount) {
            break;
        }
        if (usedCovers.has(candidate.coverArt)) {
            continue;
        }
        pushCandidate(candidate);
    }

    for (const candidate of candidates) {
        if (selected.length >= tileCount) {
            break;
        }
        pushCandidate(candidate);
    }

    if (selected.length === 0) {
        return [];
    }

    let recycleIndex = 0;
    while (selected.length < tileCount) {
        const fallback = selected[recycleIndex % selected.length];
        selected.push({
            id: `${fallback.id}::fallback-${recycleIndex}`,
            artistKey: fallback.artistKey,
            coverArt: fallback.coverArt,
        });
        recycleIndex += 1;
    }

    return selected.slice(0, tileCount);
};
