import { getSystemSettings } from "./systemSettings";

// Maximum items per request to prevent DoS attacks while supporting large libraries
/** Maximum page size accepted by unbounded library list endpoints. */
export const MAX_LIMIT = 10000;
/** Default page size for the synthetic My Liked playlist. */
export const DEFAULT_MY_LIKED_LIMIT = 100;
/** Stable identifier for the synthetic My Liked playlist. */
export const MY_LIKED_PLAYLIST_ID = "my-liked";
/** Display name for the synthetic My Liked playlist. */
export const MY_LIKED_PLAYLIST_NAME = "My Liked";
/** Display description for the synthetic My Liked playlist. */
export const MY_LIKED_PLAYLIST_DESCRIPTION = "All your thumbs-up tracks";

/** Parses the boolean spellings accepted by library query parameters. */
export const parseBooleanQueryParam = (
    value: unknown,
    defaultValue = true,
): boolean => {
    if (typeof value === "boolean") {
        return value;
    }

    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (
            normalized === "true" ||
            normalized === "1" ||
            normalized === "yes" ||
            normalized === "on"
        ) {
            return true;
        }
        if (
            normalized === "false" ||
            normalized === "0" ||
            normalized === "no" ||
            normalized === "off"
        ) {
            return false;
        }
    }

    return defaultValue;
};

/** Resolves whether destructive library operations are enabled. */
export const isLibraryDeletionEnabled = async (): Promise<boolean> => {
    const settings = await getSystemSettings();
    return settings?.libraryDeletionEnabled !== false;
};
