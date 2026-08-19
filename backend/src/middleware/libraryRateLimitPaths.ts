const COVER_ART_MOUNT_PATH = "/cover-art";
const ALBUM_COVER_MOUNT_PATH = "/album-cover";
const COVER_ART_COLORS_MOUNT_PATH = "/cover-art-colors";
const LIBRARY_STREAM_MOUNT_PATH = /^\/tracks\/[^/]+\/stream(?:\/|$)/;

function isMountedAt(path: string, mountPath: string): boolean {
    return path === mountPath || path.startsWith(`${mountPath}/`);
}

/** Classifies media paths after Express strips the `/api/library` mount. */
export function isLibraryMediaPath(path: string): boolean {
    return (
        isMountedAt(path, COVER_ART_MOUNT_PATH) ||
        isMountedAt(path, ALBUM_COVER_MOUNT_PATH) ||
        isMountedAt(path, COVER_ART_COLORS_MOUNT_PATH) ||
        LIBRARY_STREAM_MOUNT_PATH.test(path)
    );
}
