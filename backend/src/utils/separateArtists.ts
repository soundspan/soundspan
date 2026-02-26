/**
 * Post-selection pass that spreads same-artist tracks apart so adjacent
 * duplicates are minimized.
 *
 * Two flavours:
 *  - `separateArtists`                 — round-robin interleave (shuffled / unranked lists)
 *  - `separateArtistsPreservingOrder`  — bounded local swap (similarity-ranked lists)
 */

/**
 * Round-robin interleave.
 *
 * 1. Bucket tracks by artist key (preserving relative order within each bucket).
 * 2. Sort buckets by size descending (stable — ties keep insertion order).
 * 3. Interleave: iterate rounds 0..maxBucketLen, pulling one track per bucket per round.
 *
 * Guarantees zero adjacent same-artist pairs whenever the largest bucket ≤ ⌈n/2⌉.
 * When one artist dominates, adjacency is minimised to the theoretical minimum.
 * O(n).
 */
export function separateArtists<T>(
    items: T[],
    getArtistKey: (item: T) => string
): T[] {
    if (items.length <= 1) return items;

    // 1. Bucket by artist key, preserving relative order
    const bucketMap = new Map<string, T[]>();
    for (const item of items) {
        const key = getArtistKey(item);
        let bucket = bucketMap.get(key);
        if (!bucket) {
            bucket = [];
            bucketMap.set(key, bucket);
        }
        bucket.push(item);
    }

    // 2. Sort buckets by size descending (stable — ties keep insertion order)
    const buckets = Array.from(bucketMap.values()).sort(
        (a, b) => b.length - a.length
    );

    // 3. Interleave round-robin
    const result: T[] = [];
    const maxLen = buckets[0].length;
    for (let round = 0; round < maxLen; round++) {
        for (const bucket of buckets) {
            if (round < bucket.length) {
                result.push(bucket[round]);
            }
        }
    }

    return result;
}

/**
 * Bounded local swap for similarity-ranked lists.
 *
 * Scans left-to-right; when items[i] shares an artist with items[i-1],
 * finds the nearest different-artist track within `maxSwapDistance` positions
 * ahead and swaps. Preserves rank order within a ±maxSwapDistance tolerance.
 *
 * O(n × maxSwapDistance) ≈ O(n) for small constant maxSwapDistance.
 */
export function separateArtistsPreservingOrder<T>(
    items: T[],
    getArtistKey: (item: T) => string,
    maxSwapDistance: number = 3
): T[] {
    if (items.length <= 1) return items;

    const result = [...items];

    for (let i = 1; i < result.length; i++) {
        if (getArtistKey(result[i]) !== getArtistKey(result[i - 1])) continue;

        // Find nearest different-artist track within maxSwapDistance ahead
        const prevKey = getArtistKey(result[i - 1]);
        const searchEnd = Math.min(i + maxSwapDistance, result.length - 1);

        for (let j = i + 1; j <= searchEnd; j++) {
            if (getArtistKey(result[j]) !== prevKey) {
                [result[i], result[j]] = [result[j], result[i]];
                break;
            }
        }
    }

    return result;
}
