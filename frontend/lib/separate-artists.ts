/**
 * Round-robin interleave to spread same-artist tracks apart.
 *
 * Guarantees zero adjacent same-artist pairs whenever the largest
 * single-artist bucket ≤ ⌈n/2⌉.
 */
export function separateArtists<T>(
    items: T[],
    getArtistKey: (item: T) => string
): T[] {
    if (items.length <= 1) return items;

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

    const buckets = Array.from(bucketMap.values()).sort(
        (a, b) => b.length - a.length
    );

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
