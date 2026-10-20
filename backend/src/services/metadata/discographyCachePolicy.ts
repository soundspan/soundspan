const EMPTY_DISCOGRAPHY_TTL_SECONDS = 120;
const POPULATED_DISCOGRAPHY_TTL_SECONDS = 86_400;

/** Returns the Redis TTL for a provider discography result. */
export function discographyCacheTtlSeconds(releaseGroupCount: number): number {
    const validCount =
        Number.isSafeInteger(releaseGroupCount) && releaseGroupCount >= 0
            ? releaseGroupCount
            : 0;
    return validCount === 0
        ? EMPTY_DISCOGRAPHY_TTL_SECONDS
        : POPULATED_DISCOGRAPHY_TTL_SECONDS;
}
