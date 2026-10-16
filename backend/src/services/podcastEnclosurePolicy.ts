/** Supported playback category for a podcast enclosure MIME type. */
export type PodcastEnclosureKind = "audio" | "video" | "unsupported";

/** Classification and normalized MIME type for a podcast enclosure. */
export type PodcastEnclosureMimeClassification =
    | Readonly<{
          kind: Exclude<PodcastEnclosureKind, "unsupported">;
          mimeType: string;
      }>
    | Readonly<{ kind: "unsupported" }>;

const SUPPORTED_VIDEO_MIME_TYPES = new Set([
    "video/mp4",
    "video/x-m4v",
    "video/m4v",
    "video/webm",
]);

function normalizeMimeType(mimeType: string): string {
    return mimeType.split(";", 1)[0].trim().toLowerCase();
}

function isLegacyAudioMimeType(mimeType: string): boolean {
    return (
        mimeType.startsWith("audio/") ||
        mimeType.includes("mpeg") ||
        mimeType.includes("mp3") ||
        mimeType.includes("m4a")
    );
}

/**
 * Classifies a podcast enclosure MIME type for browser audio playback.
 * Existing audio matching remains case-sensitive for compatibility.
 */
export function classifyPodcastEnclosureMimeType(
    mimeType?: string,
): PodcastEnclosureMimeClassification {
    if (!mimeType) return { kind: "unsupported" };

    const normalizedMimeType = normalizeMimeType(mimeType);
    if (isLegacyAudioMimeType(mimeType)) {
        return { kind: "audio", mimeType: normalizedMimeType };
    }
    if (SUPPORTED_VIDEO_MIME_TYPES.has(normalizedMimeType)) {
        return { kind: "video", mimeType: normalizedMimeType };
    }
    return { kind: "unsupported" };
}
