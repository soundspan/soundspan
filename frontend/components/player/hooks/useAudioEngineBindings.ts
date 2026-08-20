import { useEffect } from "react";
import type {
    AudioEngineErrorPayload,
    AudioEngineEventHandler,
} from "@/lib/audio-engine/types";
import { audioEngine } from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { transitionPlaybackProgressConfirmation } from "@/lib/audio-engine/playbackProgressConfirmation";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import { setPlaybackAutoRestartSuppressed } from "@/lib/audio-engine/playbackAdvanceOrigin";

interface UseAudioEngineBindingsOptions {
    refs: PlaybackOrchestratorRefs;
}

const createPlaybackConfirmationTimeUpdateHandler = (
    refs: PlaybackOrchestratorRefs,
): AudioEngineEventHandler<"timeupdate"> => {
    return (payload) => {
        const mediaId =
            refs.playbackTypeRef.current === "track"
                ? (refs.currentTrackRef.current?.id ?? null)
                : null;
        const result = transitionPlaybackProgressConfirmation(
            refs.playbackProgressConfirmationRef.current,
            {
                type: "position",
                mediaId,
                currentTimeSeconds: payload.timeSec,
                isPlaying: audioEngine.isPlaying(),
            },
        );
        refs.playbackProgressConfirmationRef.current = result.nextState;
        if (result.confirmed) {
            refs.consecutiveErrorBreakerRef.current.recordSuccess();
            setPlaybackAutoRestartSuppressed(false);
        }
    };
};

const createPlaybackConfirmationSeekHandler = (
    refs: PlaybackOrchestratorRefs,
): AudioEngineEventHandler<"seek"> => {
    return (payload) => {
        const mediaId =
            refs.playbackTypeRef.current === "track"
                ? (refs.currentTrackRef.current?.id ?? null)
                : null;
        refs.playbackProgressConfirmationRef.current =
            transitionPlaybackProgressConfirmation(
                refs.playbackProgressConfirmationRef.current,
                {
                    type: "seek",
                    mediaId,
                    currentTimeSeconds: payload.timeSec,
                    isPlaying: audioEngine.isPlaying(),
                },
            ).nextState;
    };
};

/** Binds the stable runtime-engine facade to the latest delegated handlers. */
export function useAudioEngineBindings({
    refs,
}: UseAudioEngineBindingsOptions): void {
    const { engineEventHandlersRef, trackEndWatchdogRef } = refs;

    // The shared hybrid facade keeps its identity while inner engines swap.
    // Bind once per facade identity and dispatch into the latest closures.
    useEffect(() => {
        const confirmPlaybackProgress =
            createPlaybackConfirmationTimeUpdateHandler(refs);
        const stableHandleTimeUpdate: AudioEngineEventHandler<"timeupdate"> = (
            payload,
        ) => {
            confirmPlaybackProgress(payload);
            engineEventHandlersRef.current?.handleTimeUpdate(payload);
        };
        const stableHandleLoad: AudioEngineEventHandler<"load"> = (payload) =>
            engineEventHandlersRef.current?.handleLoad(payload);
        const stableHandleEnd: AudioEngineEventHandler<"end"> = () =>
            engineEventHandlersRef.current?.handleEnd(false);
        const stableHandleError = (payload: AudioEngineErrorPayload) =>
            engineEventHandlersRef.current?.handleError(payload);
        const stableHandlePlay: AudioEngineEventHandler<"play"> = () =>
            engineEventHandlersRef.current?.handlePlay();
        const stableHandlePause: AudioEngineEventHandler<"pause"> = () =>
            engineEventHandlersRef.current?.handlePause();
        const stableHandleSeek = createPlaybackConfirmationSeekHandler(refs);

        audioEngine.on("timeupdate", stableHandleTimeUpdate);
        audioEngine.on("load", stableHandleLoad);
        audioEngine.on("end", stableHandleEnd);
        audioEngine.on("loaderror", stableHandleError);
        audioEngine.on("playerror", stableHandleError);
        audioEngine.on("play", stableHandlePlay);
        audioEngine.on("pause", stableHandlePause);
        audioEngine.on("seek", stableHandleSeek);

        return () => {
            // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
            engineEventHandlersRef.current?.cleanup();
            // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
            trackEndWatchdogRef.current?.clear();
            audioEngine.off("timeupdate", stableHandleTimeUpdate);
            audioEngine.off("load", stableHandleLoad);
            audioEngine.off("end", stableHandleEnd);
            audioEngine.off("loaderror", stableHandleError);
            audioEngine.off("playerror", stableHandleError);
            audioEngine.off("play", stableHandlePlay);
            audioEngine.off("pause", stableHandlePause);
            audioEngine.off("seek", stableHandleSeek);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, []);
}
