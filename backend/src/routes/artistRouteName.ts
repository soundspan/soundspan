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
 * Looks up an artist route name raw-first, then uses the valid legacy
 * double-encoded candidate only when the raw name has no match.
 */
export async function findRouteNameMatch<T>(
    raw: string,
    lookup: (candidate: string) => Promise<T | null>,
): Promise<T | null> {
    const [routeName, legacyName] = normalizeRouteName(raw);
    const match = await lookup(routeName);
    if (match !== null || !legacyName) {
        return match;
    }
    return lookup(legacyName);
}
