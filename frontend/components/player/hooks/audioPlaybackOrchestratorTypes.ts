import type { AudioEngineEventHandler } from "@/lib/audio-engine/types";

/** Delegated handlers installed on the stable runtime audio-engine facade. */
export interface OrchestratorEngineEventHandlers {
    handleTimeUpdate: AudioEngineEventHandler<"timeupdate">;
    handleLoad: AudioEngineEventHandler<"load">;
    handleEnd: (viaWatchdog: boolean) => void;
    handleError: AudioEngineEventHandler<"loaderror">;
    handlePlay: AudioEngineEventHandler<"play">;
    handlePause: AudioEngineEventHandler<"pause">;
    cleanup: () => void;
}

/** Autoplay decision bound to a specific engine load generation. */
export interface DesiredLoadPlayIntent {
    loadId: number;
    shouldPlay: boolean;
    decidedAtMs: number;
}
