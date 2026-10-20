/**
 * Deep link for a notification's "View" action, derived from its type and
 * untrusted metadata. Returns null when the notification has nowhere to go.
 */
export function notificationLink(
    type: string,
    metadata: unknown,
): string | null {
    if (typeof metadata !== "object" || metadata === null) return null;
    const fields = metadata as Record<string, unknown>;
    const albumId = typeof fields.albumId === "string" ? fields.albumId : null;
    if (typeof fields.requestId === "string") {
        return type === "request_fulfilled" && albumId
            ? `/album/${albumId}`
            : "/requests";
    }
    if (typeof fields.playlistId === "string") {
        return `/playlist/${fields.playlistId}`;
    }
    if (albumId) return `/album/${albumId}`;
    if (typeof fields.artistId === "string") {
        return `/artist/${fields.artistId}`;
    }
    return null;
}
