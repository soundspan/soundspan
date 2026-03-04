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
