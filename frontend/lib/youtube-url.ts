/**
 * YouTube URL detection and video ID extraction utilities.
 *
 * Supports:
 * - https://www.youtube.com/watch?v=VIDEO_ID
 * - https://youtu.be/VIDEO_ID
 * - https://m.youtube.com/watch?v=VIDEO_ID
 * - https://youtube.com/embed/VIDEO_ID
 * - https://youtube.com/shorts/VIDEO_ID
 *
 * Does NOT match YouTube Music URLs (music.youtube.com) — those are
 * handled by the existing ytmusic integration.
 */

const YT_URL_PATTERNS = [
    /(?:youtube\.com|m\.youtube\.com)\/watch\?.*?v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
];

/**
 * Extract a YouTube video ID from a URL string.
 * Returns null if the string is not a recognized YouTube URL.
 * Excludes YouTube Music URLs (music.youtube.com).
 */
export function extractYouTubeVideoId(text: string): string | null {
    const trimmed = text.trim();

    // Exclude YouTube Music URLs — those go through the ytmusic flow
    if (/music\.youtube\.com/i.test(trimmed)) {
        return null;
    }

    for (const pattern of YT_URL_PATTERNS) {
        const match = pattern.exec(trimmed);
        if (match) {
            return match[1];
        }
    }

    return null;
}

/**
 * Check whether the given text looks like a YouTube URL.
 */
export function isYouTubeUrl(text: string): boolean {
    return extractYouTubeVideoId(text) !== null;
}

/**
 * Classification of a pasted YouTube URL, used to route a paste to either the
 * single-video preview or the playlist/channel bulk-download preview.
 *
 * - "video":    a single video.
 * - "playlist": an enumerable playlist (a real, non-RD `list=`). A real list
 *               wins over the focused `v=`, so a watch URL opened from inside
 *               a playlist still offers "download all".
 * - "channel":  a channel (@handle, /channel/UC…, /c/…, /user/…).
 * - "mix":      an auto-generated radio/mix (`list=RD…`), which cannot be
 *               enumerated as a set — falls back to its focused video.
 * - "unknown":  anything else (incl. music.youtube.com, handled elsewhere).
 */
export type YouTubeUrlClassification =
    | { kind: "video"; videoId: string }
    | { kind: "playlist"; playlistId: string }
    | { kind: "channel"; channel: string }
    | { kind: "mix"; videoId: string | null; listId: string }
    | { kind: "unknown" };

const LIST_PARAM_PATTERN = /[?&]list=([A-Za-z0-9_-]+)/;
const CHANNEL_HANDLE_PATTERN = /youtube\.com\/(@[A-Za-z0-9_.-]+)/;
const CHANNEL_ID_PATTERN = /youtube\.com\/channel\/(UC[A-Za-z0-9_-]+)/;
const CHANNEL_LEGACY_PATTERN = /youtube\.com\/(c|user)\/([A-Za-z0-9_.-]+)/;

/**
 * Classify a pasted YouTube URL. Mirrors the sidecar's classify_youtube_url
 * (the sidecar re-derives the canonical enumeration URL from the raw string),
 * so the frontend only needs the kind to decide which preview to render.
 */
export function classifyYouTubeUrl(text: string): YouTubeUrlClassification {
    const trimmed = text.trim();
    if (!trimmed || /music\.youtube\.com/i.test(trimmed)) {
        return { kind: "unknown" };
    }
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
        return { kind: "video", videoId: trimmed };
    }
    if (!trimmed.includes("youtube.com/") && !trimmed.includes("youtu.be/")) {
        return { kind: "unknown" };
    }

    const listMatch = LIST_PARAM_PATTERN.exec(trimmed);
    if (listMatch) {
        const listId = listMatch[1];
        if (listId.startsWith("RD")) {
            return {
                kind: "mix",
                videoId: extractYouTubeVideoId(trimmed),
                listId,
            };
        }
        return { kind: "playlist", playlistId: listId };
    }

    const videoId = extractYouTubeVideoId(trimmed);
    if (videoId) {
        return { kind: "video", videoId };
    }

    const handle = CHANNEL_HANDLE_PATTERN.exec(trimmed);
    if (handle) {
        return { kind: "channel", channel: handle[1] };
    }
    const channelId = CHANNEL_ID_PATTERN.exec(trimmed);
    if (channelId) {
        return { kind: "channel", channel: channelId[1] };
    }
    const legacy = CHANNEL_LEGACY_PATTERN.exec(trimmed);
    if (legacy) {
        return { kind: "channel", channel: legacy[2] };
    }

    return { kind: "unknown" };
}

/** Whether the text is a YouTube playlist or channel URL (bulk-downloadable). */
export function isYouTubePlaylistOrChannelUrl(text: string): boolean {
    const { kind } = classifyYouTubeUrl(text);
    return kind === "playlist" || kind === "channel";
}
