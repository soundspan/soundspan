/** Persisted owner value for rows managed by the album-download queue. */
export const ALBUM_DOWNLOAD_QUEUE_OWNER = "album-download-queue" as const;

/** Return whether persisted metadata assigns lifecycle ownership to the queue. */
export function isAlbumDownloadQueueOwned(metadata: unknown): boolean {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        return false;
    }
    return (
        (metadata as Record<string, unknown>).queuedVia ===
        ALBUM_DOWNLOAD_QUEUE_OWNER
    );
}
