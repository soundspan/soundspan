export type ArtistCapTrack = {
    id?: string;
    album?: {
        artist?: {
            id?: string | null;
        };
    };
};

export type ApplyArtistCapOptions = {
    maxPerArtist?: number;
    rng?: () => number;
    targetCount?: number;
    preserveInputOrder?: boolean;
    fallback?: ArtistCapFallbackOptions;
};

export type ArtistCapFallbackOptions = {
    enabled?: boolean;
    relaxationStep?: number;
    maxRelaxedPerArtist?: number;
    refillFromExcludedAfterMaxRelaxation?: boolean;
};

const DEFAULT_MAX_PER_ARTIST = 2;
const DEFAULT_RELAXATION_STEP = 1;
const DEFAULT_RELAXED_CAP_DELTA = 2;
// Hard per-artist ceiling (share of targetCount) applied when refilling
// from excluded tracks after max relaxation (GH #46).
const REFILL_HARD_CEILING_SHARE = 0.3;

function clampRandomValue(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 0.999999999999;
    return value;
}

function shuffleWithRng<T>(items: T[], rng: () => number): T[] {
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(clampRandomValue(rng()) * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function getArtistBucketKey(track: ArtistCapTrack, unknownFallbackKey: string): string {
    const artistId = track.album?.artist?.id;
    if (typeof artistId === "string" && artistId.trim().length > 0) {
        return `artist:${artistId}`;
    }
    return `unknown:${unknownFallbackKey}`;
}

/**
 * Enforce an artist cap across a randomized candidate set.
 *
 * Unknown/missing artist IDs are handled deterministically by falling back to
 * track ID (or original index if ID is unavailable), avoiding random bucket IDs.
 */
export function applyArtistCap<T extends ArtistCapTrack>(
    tracks: T[],
    options: ApplyArtistCapOptions = {}
): T[] {
    const maxPerArtist = options.maxPerArtist ?? DEFAULT_MAX_PER_ARTIST;
    if (!Number.isFinite(maxPerArtist) || maxPerArtist <= 0 || tracks.length === 0) {
        return [];
    }

    const integerCap = Math.floor(maxPerArtist);
    const rng = options.rng ?? Math.random;
    const preserveInputOrder = options.preserveInputOrder ?? false;
    const fallbackEnabled = options.fallback?.enabled ?? false;
    const hasTargetCount = Number.isFinite(options.targetCount);
    const targetCount = hasTargetCount ?
            Math.max(0, Math.min(tracks.length, Math.floor(options.targetCount as number)))
        :   tracks.length;
    if (targetCount === 0) {
        return [];
    }

    const indexedTracks = tracks.map((track, index) => ({
        track,
        unknownFallbackKey: track.id ?? `index:${index}`,
    }));

    const candidates =
        preserveInputOrder ? indexedTracks : shuffleWithRng(indexedTracks, rng);
    const artistCounts = new Map<string, number>();
    const selected: T[] = [];
    const selectedByIndex = new Array(candidates.length).fill(false);

    const trySelectUpToCap = (cap: number): void => {
        for (let i = 0; i < candidates.length; i += 1) {
            if (selectedByIndex[i]) continue;

            const entry = candidates[i];
            const bucketKey = getArtistBucketKey(entry.track, entry.unknownFallbackKey);
            const count = artistCounts.get(bucketKey) ?? 0;
            if (count >= cap) {
                continue;
            }

            artistCounts.set(bucketKey, count + 1);
            selectedByIndex[i] = true;
            selected.push(entry.track);
            if (selected.length >= targetCount) {
                return;
            }
        }
    };

    trySelectUpToCap(integerCap);
    if (selected.length >= targetCount) {
        return selected;
    }

    if (!fallbackEnabled) {
        return selected;
    }

    const relaxationStep = Math.max(
        1,
        Math.floor(options.fallback?.relaxationStep ?? DEFAULT_RELAXATION_STEP)
    );
    const maxRelaxedPerArtist = Math.max(
        integerCap,
        Math.floor(
            options.fallback?.maxRelaxedPerArtist ??
                integerCap + DEFAULT_RELAXED_CAP_DELTA
        )
    );
    const refillFromExcluded =
        options.fallback?.refillFromExcludedAfterMaxRelaxation ?? false;

    for (
        let relaxedCap = integerCap + relaxationStep;
        relaxedCap <= maxRelaxedPerArtist && selected.length < targetCount;
        relaxedCap += relaxationStep
    ) {
        trySelectUpToCap(relaxedCap);
    }

    if (selected.length >= targetCount || !refillFromExcluded) {
        return selected;
    }

    // The refill previously ignored the artist cap entirely, so a narrow
    // pool was GUARANTEED to end up dominated by 1-2 artists (GH #46).
    // Refill now respects a hard ceiling (share of the target size);
    // when the pool is genuinely too narrow, a shorter diverse playlist
    // beats a full-length dominated one.
    const refillCeiling = Math.max(
        maxRelaxedPerArtist,
        Math.floor(targetCount * REFILL_HARD_CEILING_SHARE),
        1
    );
    trySelectUpToCap(refillCeiling);

    return selected;
}
