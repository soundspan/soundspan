const MBID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Return whether a value has the UUID shape required for MusicBrainz IDs. */
export function isValidMbid(value: unknown): value is string {
    return typeof value === "string" && MBID_PATTERN.test(value);
}

/** Return whether an artist ID is a real MusicBrainz ID, not a synthetic ID. */
export function isRealArtistMbid(mbid: string | null | undefined): boolean {
    if (!isValidMbid(mbid)) return false;
    return !mbid.startsWith("temp-") && !mbid.startsWith("temp-remote-");
}

/** Classify a persisted release-group identity by its namespace shape. */
export function rgMbidKind(
    rgMbid: string,
): "musicbrainz" | "remote" | "federation" | "temp" {
    if (rgMbid.startsWith("remote:")) return "remote";
    if (rgMbid.startsWith("federation:")) return "federation";
    if (rgMbid.startsWith("temp-")) return "temp";
    return "musicbrainz";
}
