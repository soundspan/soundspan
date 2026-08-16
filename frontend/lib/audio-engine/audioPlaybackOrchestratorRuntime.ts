import { api } from "@/lib/api";
import { createRuntimeAudioEngine } from "@/lib/audio-engine";
import { resolveStreamingEngineMode } from "@/lib/audio-engine/engineMode";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import {
    PODCAST_DEBUG_STORAGE_KEY,
    readMigratingStorageItem,
} from "@/lib/storage-migration";

const PLAYBACK_CLIENT_SIGNAL_EVENTS = new Set<string>([
    "player.engine_startup",
    "player.rebuffer",
    "player.rebuffer_timeout",
    "player.rebuffer_timeout_deferred",
    "player.rebuffer_recovered",
    "player.startup_timeline",
    "player.unexpected_stop",
    "player.unexpected_pause",
    "player.load_autoplay_decision",
    "player.autoplay_intent_conflict",
    "player.track_end_rejected",
    "player.track_end_advanced",
    "player.playback_error",
    "player.segment_quarantined",
    "session.prewarm_validation_aborted",
    "session.prewarm_validation_failed",
    "session.handoff_attempt",
    "session.handoff_skipped",
    "session.handoff_failure",
    "session.handoff_load_error",
]);

/** Stable runtime audio-engine facade shared by every orchestrator concern. */
export const audioEngine = createRuntimeAudioEngine();
/** Structured logger scoped to audio playback orchestration. */
export const orchestratorLogger = sharedFrontendLogger.child(
    "AudioPlaybackOrchestrator",
);

/** Emits client playback telemetry and forwards high-signal events. */
export function logPlaybackClientMetric(
    event: string,
    fields: Record<string, unknown>,
): void {
    if (typeof window === "undefined") {
        return;
    }

    // Engine tags for the native-engine soak (GH #42): engineMode is the
    // deployment flag (cohort), activeEngine is what is actually driving
    // playback at this moment — platform pins, the Tauri upgrade, and
    // per-source videojs routing make the two legitimately diverge, and
    // the disagreements are themselves diagnostic. Read at event time so
    // errors are attributed to the engine that produced them, not to
    // whatever a recovery switch installs afterwards.
    const activeEngine = audioEngine.getActiveEngineDescriptor();
    sharedFrontendLogger.info("[Playback][ClientMetric]", {
        event,
        timestamp: new Date().toISOString(),
        engineMode: resolveStreamingEngineMode(),
        activeEngine,
        ...fields,
    });

    // Temporary high-signal beaconing to backend for live stall diagnostics.
    if (!PLAYBACK_CLIENT_SIGNAL_EVENTS.has(event)) {
        return;
    }

    void api
        .reportPlaybackClientMetric({
            event,
            fields: {
                engineMode: resolveStreamingEngineMode(),
                activeEngine,
                ...fields,
            },
        })
        .catch(() => undefined);
}

function podcastDebugEnabled(): boolean {
    try {
        return (
            typeof window !== "undefined" &&
            readMigratingStorageItem(PODCAST_DEBUG_STORAGE_KEY) === "1"
        );
    } catch {
        return false;
    }
}

/** Writes opt-in podcast playback diagnostics. */
export function podcastDebugLog(
    message: string,
    data?: Record<string, unknown>,
): void {
    if (!podcastDebugEnabled()) return;
    sharedFrontendLogger.info(`[PodcastDebug] ${message}`, data || {});
}
