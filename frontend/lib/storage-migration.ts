import { BRAND_SLUG } from "@/lib/brand";

export interface MigratingStorageKey {
    current: string;
    legacy: string;
}

/**
 * Executes createMigratingStorageKey.
 */
export function createMigratingStorageKey(
    suffix: string,
    legacySuffix?: string
): MigratingStorageKey {
    const current = `${BRAND_SLUG}_${suffix}`;
    return {
        current,
        legacy:
            typeof legacySuffix === "string"
                ? `${BRAND_SLUG}_${legacySuffix}`
                : current,
    };
}

/**
 * Executes createExplicitMigratingStorageKey.
 */
export function createExplicitMigratingStorageKey(
    current: string,
    legacy: string
): MigratingStorageKey {
    return { current, legacy };
}

export const PODCAST_DEBUG_STORAGE_KEY = createExplicitMigratingStorageKey(
    "soundspanPodcastDebug",
    "soundspanPodcastDebug"
);

export const OVERLAY_ACTIVE_TAB_STORAGE_KEY = createExplicitMigratingStorageKey(
    "soundspan.overlay.activeTab",
    "soundspan.overlay.activeTab"
);

/**
 * Executes readMigratingStorageItem.
 */
export function readMigratingStorageItem(key: MigratingStorageKey): string | null {
    if (typeof window === "undefined") {
        return null;
    }

    try {
        const currentValue = localStorage.getItem(key.current);
        if (currentValue !== null) {
            return currentValue;
        }

        if (key.legacy !== key.current) {
            const legacyValue = localStorage.getItem(key.legacy);
            if (legacyValue !== null) {
                try {
                    localStorage.setItem(key.current, legacyValue);
                } catch {
                    // Ignore storage write failures in restricted contexts.
                }
                return legacyValue;
            }
        }
    } catch {
        // Ignore storage access failures in restricted contexts.
    }

    return null;
}

/**
 * Executes writeMigratingStorageItem.
 */
export function writeMigratingStorageItem(
    key: MigratingStorageKey,
    value: string
): void {
    if (typeof window === "undefined") {
        return;
    }

    try {
        localStorage.setItem(key.current, value);
    } catch {
        // Ignore storage write failures in restricted contexts.
    }
}

/**
 * Executes removeMigratingStorageItem.
 */
export function removeMigratingStorageItem(key: MigratingStorageKey): void {
    if (typeof window === "undefined") {
        return;
    }

    try {
        localStorage.removeItem(key.current);
        if (key.legacy !== key.current) {
            localStorage.removeItem(key.legacy);
        }
    } catch {
        // Ignore storage write failures in restricted contexts.
    }
}
