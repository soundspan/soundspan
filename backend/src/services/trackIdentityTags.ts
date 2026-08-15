type ParsedTrackIdentityMetadata = Readonly<{
    common: Readonly<{
        musicbrainz_recordingid?: string;
        isrc?: string | readonly string[];
    }>;
}>;

/** Extracts normalized durable track identity keys from parsed audio metadata. */
export function extractTrackIdentityTags(
    metadata: ParsedTrackIdentityMetadata,
): { recordingMbid: string | null; isrc: string | null } {
    const recordingMbid =
        metadata.common.musicbrainz_recordingid?.trim() || null;
    const rawIsrc = metadata.common.isrc;
    const firstIsrc = typeof rawIsrc === "string" ? rawIsrc : rawIsrc?.[0];
    return {
        recordingMbid,
        isrc: firstIsrc?.trim() || null,
    };
}
