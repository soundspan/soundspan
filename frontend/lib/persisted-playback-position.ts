import {
    createMigratingStorageKey,
    writeMigratingStorageItem,
} from "./storage-migration";

const CURRENT_TIME_KEY = createMigratingStorageKey("current_time");
const CURRENT_TIME_TRACK_ID_KEY = createMigratingStorageKey(
    "current_time_track_id",
);

export function resetPersistedTrackStartPosition(trackId: string): void {
    if (!trackId || typeof window === "undefined") return;
    try {
        writeMigratingStorageItem(CURRENT_TIME_KEY, "0");
        writeMigratingStorageItem(CURRENT_TIME_TRACK_ID_KEY, trackId);
    } catch {
        // Ignore storage failures (private mode/quota/etc.)
    }
}
