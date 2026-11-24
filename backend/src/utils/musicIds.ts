const MBID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Return whether a value has the UUID shape required for MusicBrainz IDs. */
export function isValidMbid(value: unknown): value is string {
    return typeof value === "string" && MBID_PATTERN.test(value);
}

/** Return whether an artist ID is a real MusicBrainz ID, not a synthetic ID. */
export function isRealArtistMbid(
    mbid: string | null | undefined,
): mbid is string {
    if (!isValidMbid(mbid)) return false;
    return !mbid.startsWith("temp-") && !mbid.startsWith("temp-remote-");
}

/** Classify a persisted release-group identity by its namespace shape. */
export function rgMbidKind(
    rgMbid: string | null | undefined,
): "musicbrainz" | "remote" | "federation" | "temp" | "none" {
    if (!rgMbid) return "none";
    if (rgMbid.startsWith("remote:")) return "remote";
    if (rgMbid.startsWith("federation:")) return "federation";
    if (rgMbid.startsWith("temp-")) return "temp";
    return "musicbrainz";
}

const SYNTHETIC_ID_PREFIX = "temp-";

/**
 * Return the MusicBrainz id, or a stable `temp-<row id>` key for a row that has
 * none, for payloads and tables that require a non-empty identity string.
 */
export function musicBrainzIdOrSynthetic(
    rowId: string,
    mbid: string | null,
): string {
    return mbid ?? `${SYNTHETIC_ID_PREFIX}${rowId}`;
}

/** Return the row id encoded in a synthetic key, or null for any other value. */
export function rowIdFromSyntheticId(value: string): string | null {
    return value.startsWith(SYNTHETIC_ID_PREFIX)
        ? value.slice(SYNTHETIC_ID_PREFIX.length) || null
        : null;
}
