import path from "path";
import { config } from "../config";
import { safeResolvePath } from "./safeResolvePath";
import { logger } from "./logger";

/** Resolved, validated filesystem target for a persisted track path. */
export interface PersistedTrackDeletionPath {
    absolutePath: string;
    pathParts: string[];
}

/** Resolves a persisted relative track path beneath the configured music root. */
export const resolvePersistedTrackDeletionPath = (
    persistedPath: string,
): PersistedTrackDeletionPath | null => {
    const normalizedPath = persistedPath.replace(/\\/g, "/");
    if (
        path.posix.isAbsolute(normalizedPath) ||
        path.win32.isAbsolute(persistedPath)
    ) {
        return null;
    }

    const pathParts = normalizedPath.split("/").filter(Boolean);
    if (
        pathParts.length === 0 ||
        pathParts.some((part) => part === "." || part === "..")
    ) {
        return null;
    }

    const absolutePath = safeResolvePath(
        config.music.musicPath,
        normalizedPath,
    );
    return absolutePath ? { absolutePath, pathParts } : null;
};

/** Returns whether a recursive deletion target remains beneath the music root. */
export const isSafeRecursiveDeletionTarget = (targetPath: string): boolean => {
    const musicPath = path.resolve(config.music.musicPath);
    const resolvedTarget = path.resolve(targetPath);
    const relativeTarget = path.relative(musicPath, resolvedTarget);
    return (
        safeResolvePath(config.music.musicPath, relativeTarget) ===
        resolvedTarget
    );
};

/** Scoped logger shared by library deletion handlers. */
export const libraryDeletionLogger = logger.child("LibraryDeletion");
