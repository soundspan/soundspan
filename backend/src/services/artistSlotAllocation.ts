/**
 * Shared primitives for the two artist-diversity selection problems (GH #46).
 *
 * `allocateTracksWithArtistWeighting` handles unranked sampled pools: generated
 * library-radio modes routed through `routes/library/radio.ts`, programmatic
 * playlists, and Subsonic `getRandomSongs`. It allocates damped proportional
 * artist slots under a hard share ceiling, then samples within each artist.
 *
 * Score-ranked pools instead preserve ranking through
 * `programmaticPlaylistArtistCap.applyArtistCap`: mood buckets, Discover Weekly,
 * and artist-radio similar tracks selected by `libraryRadioBuilder`. Ordered
 * vibe, liked, playlist, and tracks-radio queues intentionally skip artist
 * diversification so their source order remains intact.
 */

export interface ArtistAllocationOptions {
    /** Number of tracks to select. */
    targetCount: number;
    /**
     * Damping exponent in [0, 1] for artist weight `n^alpha`.
     * Defaults to the deployment's configured value (0.5).
     */
    alpha?: number;
    /**
     * Hard per-artist ceiling as a share of targetCount, in (0, 1].
     * Defaults to the deployment's configured value (0.3).
     */
    ceilingShare?: number;
    /** RNG in [0, 1); inject a seeded RNG for deterministic output. */
    rng?: () => number;
}

/** Default damping exponent (see ArtistAllocationOptions.alpha). */
export const DEFAULT_ARTIST_WEIGHT_ALPHA = 0.5;

/** Default per-artist ceiling share (see ArtistAllocationOptions.ceilingShare). */
export const DEFAULT_ARTIST_SHARE_CEILING = 0.3;

const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value));

/**
 * Uniformly sample `count` items without replacement (partial
 * Fisher-Yates). Never mutates the input; deterministic under an
 * injected RNG. Returns a shuffled copy when count >= length.
 */
export function sampleUniform<T>(
    items: T[],
    count: number,
    rng: () => number = Math.random,
): T[] {
    if (!Array.isArray(items) || items.length === 0 || count <= 0) {
        return [];
    }
    const pool = [...items];
    const takeCount = Math.min(count, pool.length);
    for (let i = 0; i < takeCount; i += 1) {
        const j = i + Math.floor(rng() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, takeCount);
}

interface ArtistBucket<T> {
    key: string;
    tracks: T[];
    weight: number;
    capacity: number;
    slots: number;
    remainder: number;
}

const groupByArtist = <T>(
    tracks: T[],
    getArtistKey: (track: T, index: number) => string,
): Map<string, T[]> => {
    const groups = new Map<string, T[]>();
    tracks.forEach((track, index) => {
        const rawKey = getArtistKey(track, index);
        const key =
            typeof rawKey === "string" && rawKey.length > 0
                ? rawKey
                : `unknown:${index}`;
        const bucket = groups.get(key);
        if (bucket) {
            bucket.push(track);
        } else {
            groups.set(key, [track]);
        }
    });
    return groups;
};

const distributeSlots = <T>(
    buckets: ArtistBucket<T>[],
    target: number,
): void => {
    const totalWeight = buckets.reduce((sum, b) => sum + b.weight, 0);
    if (totalWeight <= 0) {
        return;
    }

    let assigned = 0;
    for (const bucket of buckets) {
        const quota = (target * bucket.weight) / totalWeight;
        bucket.slots = Math.min(Math.floor(quota), bucket.capacity);
        bucket.remainder = quota - Math.floor(quota);
        assigned += bucket.slots;
    }

    // Largest-remainder distribution of the leftovers, bounded by the
    // target itself: each pass assigns at least one slot or exits.
    let remaining = target - assigned;
    const byRemainder = [...buckets].sort(
        (a, b) =>
            b.remainder - a.remainder ||
            b.weight - a.weight ||
            a.key.localeCompare(b.key),
    );
    let guard = target;
    while (remaining > 0 && guard > 0) {
        let assignedThisPass = 0;
        for (const bucket of byRemainder) {
            if (remaining <= 0) break;
            if (bucket.slots < bucket.capacity) {
                bucket.slots += 1;
                remaining -= 1;
                assignedThisPass += 1;
            }
        }
        if (assignedThisPass === 0) break;
        guard -= 1;
    }
};

/**
 * Select up to `targetCount` tracks with damped proportional artist
 * weighting and a hard per-artist ceiling. Output is round-robin
 * interleaved across artists (dominant artists spaced out); callers
 * that want a flat shuffle can shuffle the result.
 */
export function allocateTracksWithArtistWeighting<T>(
    tracks: T[],
    getArtistKey: (track: T, index: number) => string,
    options: ArtistAllocationOptions,
): T[] {
    const targetCount = Math.floor(options.targetCount);
    if (!Array.isArray(tracks) || tracks.length === 0 || targetCount <= 0) {
        return [];
    }

    const alpha = clamp(options.alpha ?? DEFAULT_ARTIST_WEIGHT_ALPHA, 0, 1);
    const ceilingShare = clamp(
        options.ceilingShare ?? DEFAULT_ARTIST_SHARE_CEILING,
        0,
        1,
    );
    const rng = options.rng ?? Math.random;
    const ceiling = Math.max(1, Math.floor(targetCount * ceilingShare));

    const buckets: ArtistBucket<T>[] = [];
    for (const [key, bucketTracks] of groupByArtist(tracks, getArtistKey)) {
        buckets.push({
            key,
            tracks: bucketTracks,
            weight: Math.pow(bucketTracks.length, alpha),
            capacity: Math.min(bucketTracks.length, ceiling),
            slots: 0,
            remainder: 0,
        });
    }

    const totalCapacity = buckets.reduce((sum, b) => sum + b.capacity, 0);
    const target = Math.min(targetCount, totalCapacity);
    distributeSlots(buckets, target);

    // Sample each artist's slots without replacement, then interleave
    // round-robin (largest allocation first) so repeats are spaced.
    const picks = buckets
        .filter((bucket) => bucket.slots > 0)
        .map((bucket) => sampleUniform(bucket.tracks, bucket.slots, rng))
        .sort((a, b) => b.length - a.length);

    const result: T[] = [];
    const maxRounds = ceiling;
    for (
        let round = 0;
        round < maxRounds && result.length < target;
        round += 1
    ) {
        for (const artistPicks of picks) {
            if (round < artistPicks.length) {
                result.push(artistPicks[round]);
            }
        }
    }
    return result;
}

/**
 * Deterministic hash of a seed key to a 32-bit unsigned int.
 */
export function getSeededRandom(seed: string): number {
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
        const char = seed.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

/**
 * LCG RNG in [0, 1), deterministic per numeric seed. Compose with
 * {@link getSeededRandom} for string seed keys.
 */
export function createSeededRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

/**
 * Seeded Fisher-Yates shuffle: deterministic per seed key, uniform, and
 * returns a fresh array (no in-place mutation).
 */
export function seededShuffle<T>(items: T[], seedKey: string): T[] {
    const shuffled = [...items];
    const rng = createSeededRng(getSeededRandom(seedKey));
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}
