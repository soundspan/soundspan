import type { SegmentedStreamingSessionResponse } from "@/lib/api";
import type {
    AudioEngineEventHandler,
    AudioEngineManifestStallPayload,
} from "@/lib/audio-engine/types";
import type { SegmentedTrackContext } from "@/lib/audio-engine/audioPlaybackTrackPolicy";

/** Delegated handlers installed on the stable runtime audio-engine facade. */
export interface OrchestratorEngineEventHandlers {
    handleTimeUpdate: AudioEngineEventHandler<"timeupdate">;
    handleLoad: AudioEngineEventHandler<"load">;
    handleEnd: (viaWatchdog: boolean) => void;
    handleError: AudioEngineEventHandler<"loaderror">;
    handlePlay: AudioEngineEventHandler<"play">;
    handlePause: AudioEngineEventHandler<"pause">;
    handleVhsResponse: AudioEngineEventHandler<"vhsresponse">;
    handleManifestStall: (payload: AudioEngineManifestStallPayload) => void;
    cleanup: () => void;
}

/** Active segmented-session identity retained across render cycles. */
export interface ActiveSegmentedSessionSnapshot {
    sessionId: string;
    sessionToken: string;
    trackId: string;
    sourceType: "local" | "tidal" | "ytmusic";
    manifestUrl: string;
    expiresAt: string;
    assetBuildInFlight: boolean;
    manifestProfile: "startup_single" | "steady_state_dual" | null;
}

/** Inputs required to prewarm one segmented playback session. */
export interface SegmentedSessionPrewarmOptions {
    sessionKey: string;
    context: SegmentedTrackContext;
    trackId: string;
    reason: "startup_background" | "next_track";
    retryCount?: number;
}

/** Segmented session prepared for the current startup track. */
export interface StartupSegmentedSessionSnapshot {
    trackId: string;
    sourceType: "local" | "tidal" | "ytmusic";
    session: SegmentedStreamingSessionResponse;
}

/** Timing and correlation state for one segmented startup attempt. */
export interface SegmentedStartupTimelineSnapshot {
    trackId: string;
    loadId: number;
    startupCorrelationId: string;
    sessionId: string | null;
    sourceType: "local" | "tidal" | "ytmusic" | "unknown";
    initSource: "prewarm" | "startup" | "on_demand" | null;
    loadAttemptStartedAtMs: number;
    createRequestedAtMs: number | null;
    createResolvedAtMs: number | null;
    manifestFirstResponseAtMs: number | null;
    firstChunkResponseAtMs: number | null;
    firstChunkName: string | null;
    audibleAtMs: number | null;
    startupRetryCount: number;
    emitted: boolean;
}

/** Autoplay decision bound to a specific engine load generation. */
export interface DesiredLoadPlayIntent {
    loadId: number;
    shouldPlay: boolean;
    decidedAtMs: number;
}

/** Recovery path that owns a segmented handoff listener registration. */
export type SegmentedHandoffListenerPhase =
    | "handoff_recovery"
    | "session_create_recovery";

/** Listener identity used to reject stale segmented handoff callbacks. */
export interface SegmentedHandoffListenerRegistration {
    trackId: string;
    sourceType: "local" | "tidal" | "ytmusic";
    sessionId: string;
    expectedLoadId: number;
    phase: SegmentedHandoffListenerPhase;
}
