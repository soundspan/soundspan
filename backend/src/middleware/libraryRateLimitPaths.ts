const COVER_ART_MOUNT_PATH = "/cover-art";
const ALBUM_COVER_MOUNT_PATH = "/album-cover";
const COVER_ART_COLORS_MOUNT_PATH = "/cover-art-colors";
const LIBRARY_STREAM_MOUNT_PATH = /^\/tracks\/[^/]+\/stream(?:\/|$)/;

function isMountedAt(path: string, mountPath: string): boolean {
    return path === mountPath || path.startsWith(`${mountPath}/`);
}

/**
 * Classifies media paths after Express strips the `/api/library` mount.
 * Express route matching is case-insensitive by default, so the classifier
 * lowercases the path to keep parity with the path-scoped limiter mounts.
 */
export function isLibraryMediaPath(path: string): boolean {
    const normalizedPath = path.toLowerCase();
    return (
        isMountedAt(normalizedPath, COVER_ART_MOUNT_PATH) ||
        isMountedAt(normalizedPath, ALBUM_COVER_MOUNT_PATH) ||
        isMountedAt(normalizedPath, COVER_ART_COLORS_MOUNT_PATH) ||
        LIBRARY_STREAM_MOUNT_PATH.test(normalizedPath)
    );
}
