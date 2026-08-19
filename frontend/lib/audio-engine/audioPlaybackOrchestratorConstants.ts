import { createMigratingStorageKey } from "@/lib/storage-migration";

export const CURRENT_TIME_KEY = createMigratingStorageKey("current_time");
export const CURRENT_TIME_TRACK_ID_KEY = createMigratingStorageKey(
    "current_time_track_id",
);
export const AUDIO_LOAD_TIMEOUT_MS = 20_000;
export const AUDIO_LOAD_TIMEOUT_RETRIES = 1;
// First audible progress at or past this position counts as a completed
// load even when the engine's synthetic "load" event has not fired yet.
export const STARTUP_AUDIBLE_THRESHOLD_SEC = 0.2;
export const UNEXPECTED_PAUSE_RECOVERY_DEBOUNCE_MS = 600;
export const UNEXPECTED_PAUSE_RECOVERY_MIN_SILENCE_MS = 1200;
export const UNEXPECTED_PAUSE_RECOVERY_MAX_BUFFERED_AHEAD_SEC = 1.0;
export const AUDIO_LOAD_RETRY_DELAY_MS = 350;
export const TRACK_ERROR_SKIP_DELAY_MS = 1200;
export const TRANSIENT_TRACK_ERROR_RECOVERY_DELAY_MS = 450;
export const TRANSIENT_TRACK_ERROR_RECOVERY_WINDOW_MS = 15_000;
export const TRANSIENT_TRACK_ERROR_RECOVERY_MAX_ATTEMPTS = 4;
export const LISTEN_TOGETHER_FOLLOWER_RECOVERY_COOLDOWN_MS = 1_500;
export const STARTUP_PLAYBACK_RECOVERY_DELAY_MS = 1400;
export const STARTUP_PLAYBACK_RECOVERY_RECHECK_DELAY_MS = 900;
export const STARTUP_PLAYBACK_RECOVERY_MAX_RECHECKS = 2;
export const AUTOPLAY_INTENT_CONFLICT_WINDOW_MS = 3_000;
export const AUTO_MATCH_VIBE_RETRY_COOLDOWN_MS = 8000;
export const HEARTBEAT_BUFFER_TIMEOUT_MS = 7_000;
// Suppress unexpected-stop recovery this long after a load starts so a slow
// startup is retried through startup recovery, not misread as a mid-play stop.
export const UNEXPECTED_STOP_STARTUP_GUARD_MS = 20_000;
export const TRACK_END_WATCHDOG_TIMEOUT_MS = 2_000;
export const TRACK_END_WATCHDOG_BOUNDARY_SEC = 0.75;

export const FORMAT_TO_CODEC: Record<string, string> = {
    mp3: "MP3",
    mp4: "AAC",
    flac: "FLAC",
    webm: "OPUS",
    wav: "WAV",
};
