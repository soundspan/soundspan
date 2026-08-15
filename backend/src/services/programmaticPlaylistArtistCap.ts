/** Minimal track shape supported by the default album-artist resolver. */
export type ArtistCapTrack = {
    id?: string;
    album?: {
        artist?: {
            id?: string | null;
        };
    };
};

/** Options for rank-preserving per-artist track selection. */
export type ApplyArtistCapOptions<T extends ArtistCapTrack = ArtistCapTrack> = {
    /** Strict maximum number of tracks per resolved artist. */
    maxPerArtist?: number;
    /** RNG used when input ranking is not preserved. */
    rng?: () => number;
    /** Number of tracks to select in this call. */
    targetCount?: number;
    /** Keep candidates in their supplied ranked order. */
    preserveInputOrder?: boolean;
    /** Optional bounded cap-relaxation behavior. */
    fallback?: ArtistCapFallbackOptions;
    /**
     * Resolve artist identity from a caller-specific track shape. When set,
     * this takes precedence over `album.artist.id`; empty values use the
     * deterministic unknown-track fallback.
     */
    getArtistId?: (track: T) => string | null | undefined;
    /**
     * Tracks chosen by an earlier pass whose artist counts must consume this
     * pass's caps. `targetCount` still counts only newly selected tracks.
     */
    alreadySelected?: T[];
};

/** Controlled cap-relaxation behavior for {@link applyArtistCap}. */
export type ArtistCapFallbackOptions = {
    /** Enable bounded passes above the strict artist cap. */
    enabled?: boolean;
    /** Amount added to the cap for each relaxation pass. */
    relaxationStep?: number;
    /** Highest absolute per-artist cap allowed during relaxation. */
    maxRelaxedPerArtist?: number;
    /** Run one final refill under the hard artist-share ceiling. */
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

function getArtistBucketKey<T extends ArtistCapTrack>(
    track: T,
    unknownFallbackKey: string,
    getArtistId?: (track: T) => string | null | undefined,
): string {
    const artistId = getArtistId ? getArtistId(track) : track.album?.artist?.id;
    if (typeof artistId === "string" && artistId.trim().length > 0) {
        return `artist:${artistId}`;
    }
    return `unknown:${unknownFallbackKey}`;
}

type IndexedTrack<T> = {
    track: T;
    unknownFallbackKey: string;
};

type ArtistCapSelectionState<T> = {
    candidates: IndexedTrack<T>[];
    artistCounts: Map<string, number>;
    selected: T[];
    selectedByIndex: boolean[];
    targetCount: number;
    getArtistId?: (track: T) => string | null | undefined;
};

function buildArtistCounts<T extends ArtistCapTrack>(
    tracks: T[],
    getArtistId?: (track: T) => string | null | undefined,
): Map<string, number> {
    const counts = new Map<string, number>();
    for (let index = 0; index < tracks.length; index += 1) {
        const track = tracks[index];
        const fallbackKey = track.id ?? `already:${index}`;
        const bucketKey = getArtistBucketKey(track, fallbackKey, getArtistId);
        counts.set(bucketKey, (counts.get(bucketKey) ?? 0) + 1);
    }
    return counts;
}

function selectUpToCap<T extends ArtistCapTrack>(
    state: ArtistCapSelectionState<T>,
    cap: number,
): void {
    for (let index = 0; index < state.candidates.length; index += 1) {
        if (state.selectedByIndex[index]) continue;
        const entry = state.candidates[index];
        const bucketKey = getArtistBucketKey(
            entry.track,
            entry.unknownFallbackKey,
            state.getArtistId,
        );
        const count = state.artistCounts.get(bucketKey) ?? 0;
        if (count >= cap) continue;

        state.artistCounts.set(bucketKey, count + 1);
        state.selectedByIndex[index] = true;
        state.selected.push(entry.track);
        if (state.selected.length >= state.targetCount) return;
    }
}

function relaxArtistCap<T extends ArtistCapTrack>(
    state: ArtistCapSelectionState<T>,
    initialCap: number,
    options: ApplyArtistCapOptions<T>,
): void {
    const relaxationStep = Math.max(
        1,
        Math.floor(options.fallback?.relaxationStep ?? DEFAULT_RELAXATION_STEP),
    );
    const maximumUsefulCap =
        (options.alreadySelected?.length ?? 0) + state.targetCount;
    const maxRelaxedPerArtist = Math.min(
        maximumUsefulCap,
        Math.max(
            initialCap,
            Math.floor(
                options.fallback?.maxRelaxedPerArtist ??
                    initialCap + DEFAULT_RELAXED_CAP_DELTA,
            ),
        ),
    );

    for (
        let cap = initialCap + relaxationStep;
        cap <= maxRelaxedPerArtist && state.selected.length < state.targetCount;
        cap += relaxationStep
    ) {
        selectUpToCap(state, cap);
    }

    if (
        state.selected.length >= state.targetCount ||
        !options.fallback?.refillFromExcludedAfterMaxRelaxation
    ) {
        return;
    }

    const refillCeiling = Math.max(
        maxRelaxedPerArtist,
        Math.floor(state.targetCount * REFILL_HARD_CEILING_SHARE),
        1,
    );
    selectUpToCap(state, refillCeiling);
}

/**
 * Enforce an artist cap across a randomized candidate set.
 *
 * Unknown/missing artist IDs are handled deterministically by falling back to
 * track ID (or original index if ID is unavailable), avoiding random bucket IDs.
 */
export function applyArtistCap<T extends ArtistCapTrack>(
    tracks: T[],
    options: ApplyArtistCapOptions<T> = {},
): T[] {
    if (!Array.isArray(tracks)) return [];

    const maxPerArtist = options.maxPerArtist ?? DEFAULT_MAX_PER_ARTIST;
    if (
        !Number.isFinite(maxPerArtist) ||
        maxPerArtist <= 0 ||
        tracks.length === 0
    ) {
        return [];
    }

    const integerCap = Math.floor(maxPerArtist);
    const rng = options.rng ?? Math.random;
    const preserveInputOrder = options.preserveInputOrder ?? false;
    const hasTargetCount = Number.isFinite(options.targetCount);
    const targetCount = hasTargetCount
        ? Math.max(
              0,
              Math.min(
                  tracks.length,
                  Math.floor(options.targetCount as number),
              ),
          )
        : tracks.length;
    if (targetCount === 0) {
        return [];
    }

    const indexedTracks = tracks.map((track, index) => ({
        track,
        unknownFallbackKey: track.id ?? `candidate:${index}`,
    }));

    const candidates = preserveInputOrder
        ? indexedTracks
        : shuffleWithRng(indexedTracks, rng);
    const state: ArtistCapSelectionState<T> = {
        candidates,
        artistCounts: buildArtistCounts(
            options.alreadySelected ?? [],
            options.getArtistId,
        ),
        selected: [],
        selectedByIndex: new Array(candidates.length).fill(false),
        targetCount,
        getArtistId: options.getArtistId,
    };

    selectUpToCap(state, integerCap);
    if (
        state.selected.length >= targetCount ||
        !(options.fallback?.enabled ?? false)
    ) {
        return state.selected;
    }

    relaxArtistCap(state, integerCap, options);
    return state.selected;
}
