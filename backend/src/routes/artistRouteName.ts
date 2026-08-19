const PERCENT_ESCAPE_PATTERN = /%[0-9a-f]{2}/i;

/**
 * Returns an Express-decoded artist name followed by its legacy
 * double-encoded fallback, when that fallback is valid and distinct.
 */
export function normalizeRouteName(raw: string): readonly string[] {
    if (!PERCENT_ESCAPE_PATTERN.test(raw)) {
        return [raw];
    }

    try {
        const decoded = decodeURIComponent(raw);
        return decoded === raw ? [raw] : [raw, decoded];
    } catch {
        return [raw];
    }
}

/**
 * Looks up an artist route name raw-first. When provided, `matchesCandidate`
 * allows an exact legacy match to replace a fuzzy raw match while preserving
 * the raw result when neither candidate matches exactly.
 */
export async function findRouteNameMatch<T>(
    raw: string,
    lookup: (candidate: string) => Promise<T | null>,
    matchesCandidate?: (candidate: string, match: T) => boolean,
): Promise<T | null> {
    const [routeName, legacyName] = normalizeRouteName(raw);
    const rawMatch = await lookup(routeName);
    const rawMatches =
        rawMatch !== null &&
        (!matchesCandidate || matchesCandidate(routeName, rawMatch));
    if (!legacyName || rawMatches) {
        return rawMatch;
    }

    const legacyMatch = await lookup(legacyName);
    const legacyMatches =
        legacyMatch !== null &&
        (!matchesCandidate || matchesCandidate(legacyName, legacyMatch));
    return legacyMatches ? legacyMatch : rawMatch;
}
