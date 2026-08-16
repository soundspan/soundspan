import { useEffect } from "react";
import { api } from "@/lib/api";
import type { Track } from "@/lib/audio-state-context";
import type { PlaybackStreamProfile } from "@/lib/audio-playback-context";
import { toAddToPlaylistRef } from "@/lib/trackRef";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import {
    resolveDirectTrackSourceType,
    resolveSegmentedTrackContext,
} from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import { createEmptySegmentedStartupRecoveryStageAttempts } from "../audioPlaybackOrchestratorPolicy";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import type { usePlaybackRecoveryHelpers } from "./usePlaybackRecoveryHelpers";
import type { useSegmentedStartupCallbacks } from "./useSegmentedStartupCallbacks";

interface UsePlaybackStateSyncOptions {
    refs: PlaybackOrchestratorRefs;
    playbackRecoveryHelpers: ReturnType<typeof usePlaybackRecoveryHelpers>;
    segmentedStartupCallbacks: ReturnType<typeof useSegmentedStartupCallbacks>;
    currentTrack: Track | null;
    playbackType: "track" | "audiobook" | "podcast" | null;
    queueLength: number;
    isPlaying: boolean;
    isBuffering: boolean;
    setStreamProfile: (profile: PlaybackStreamProfile | null) => void;
}

/** Keeps orchestrator refs synchronized with React playback state. */
export function usePlaybackStateSync({
    refs,
    playbackRecoveryHelpers,
    segmentedStartupCallbacks,
    currentTrack,
    playbackType,
    queueLength,
    isPlaying,
    isBuffering,
    setStreamProfile,
}: UsePlaybackStateSyncOptions): void {
    const {
        clearTransientTrackRecovery,
        clearSegmentedHandoffLoadListeners,
        resetSegmentedHandoffCircuit,
    } = playbackRecoveryHelpers;
    const {
        abortAllSegmentedPrewarmValidations,
        markSegmentedStartupRampWindow,
    } = segmentedStartupCallbacks;
    const {
        currentTrackRef,
        trackEndWatchdogRef,
        segmentedHandoffListenerContextRef,
        startupSegmentedSessionRef,
        segmentedProactiveHandoffAttemptedTrackIdRef,
        segmentedProactiveHandoffAttemptCountRef,
        segmentedProactiveHandoffLastAttemptAtRef,
        segmentedProactiveHandoffCompletedTrackIdRef,
        segmentedProactiveHandoffLastSkipKeyRef,
        startupRecoveryAttemptedTrackIdRef,
        transientTrackRecoveryTrackIdRef,
        activeSegmentedPlaybackTrackIdRef,
        activeSegmentedSessionRef,
        segmentedHeartbeatConsecutiveFailureCountRef,
        segmentedHeartbeatLastGuardedRefreshAtMsRef,
        segmentedHeartbeatSessionIdRef,
        segmentedColdStartRebufferDeferralRef,
        segmentedHandoffAttemptRef,
        segmentedHandoffLastAttemptAtRef,
        segmentedSessionCreateFallbackAttemptRef,
        segmentedSessionCreateFallbackLastAttemptAtRef,
        segmentedChunkQuarantineRef,
        segmentedChunkQuarantineLastRecoveryAtRef,
        segmentedLastFailedChunkRef,
        segmentedHandoffInProgressRef,
        segmentedHandoffLastRecoveryRef,
        lastLoggedRemotePlayKeyRef,
        queueLengthRef,
        playbackTypeRef,
        segmentedStartupRetryCountRef,
        segmentedStartupStageAttemptsRef,
        segmentedStartupRecoveryWindowStartedAtMsRef,
        segmentedStartupSessionResetCountRef,
    } = refs;

    useEffect(() => {
        const previousTrackId = currentTrackRef.current?.id ?? null;
        currentTrackRef.current = currentTrack;
        const currentTrackId = currentTrack?.id ?? null;
        if (previousTrackId !== currentTrackId) {
            trackEndWatchdogRef.current?.clear();
            abortAllSegmentedPrewarmValidations("track_change");
        }
        const handoffListenerTrackId =
            segmentedHandoffListenerContextRef.current?.trackId ?? null;
        if (
            handoffListenerTrackId &&
            handoffListenerTrackId !== currentTrack?.id
        ) {
            clearSegmentedHandoffLoadListeners("track_change");
        }
        if (startupSegmentedSessionRef.current?.trackId !== currentTrack?.id) {
            startupSegmentedSessionRef.current = null;
        }
        if (
            currentTrack?.id !==
            segmentedProactiveHandoffAttemptedTrackIdRef.current
        ) {
            segmentedProactiveHandoffAttemptedTrackIdRef.current = null;
            segmentedProactiveHandoffAttemptCountRef.current = 0;
            segmentedProactiveHandoffLastAttemptAtRef.current = 0;
            segmentedProactiveHandoffCompletedTrackIdRef.current = null;
            segmentedProactiveHandoffLastSkipKeyRef.current = null;
        }
        if (currentTrack?.id !== startupRecoveryAttemptedTrackIdRef.current) {
            startupRecoveryAttemptedTrackIdRef.current = null;
        }
        if (currentTrack?.id !== transientTrackRecoveryTrackIdRef.current) {
            clearTransientTrackRecovery(true);
        }
        if (
            activeSegmentedPlaybackTrackIdRef.current &&
            activeSegmentedPlaybackTrackIdRef.current !== currentTrack?.id
        ) {
            activeSegmentedPlaybackTrackIdRef.current = null;
        }
        if (!currentTrack || !resolveSegmentedTrackContext(currentTrack)) {
            activeSegmentedSessionRef.current = null;
            activeSegmentedPlaybackTrackIdRef.current = null;
            segmentedHeartbeatConsecutiveFailureCountRef.current = 0;
            segmentedHeartbeatLastGuardedRefreshAtMsRef.current = 0;
            segmentedHeartbeatSessionIdRef.current = null;
            segmentedColdStartRebufferDeferralRef.current = {
                trackId: null,
                count: 0,
            };
            segmentedHandoffAttemptRef.current = 0;
            segmentedHandoffLastAttemptAtRef.current = 0;
            segmentedSessionCreateFallbackAttemptRef.current = 0;
            segmentedSessionCreateFallbackLastAttemptAtRef.current = 0;
            segmentedChunkQuarantineRef.current.clear();
            segmentedChunkQuarantineLastRecoveryAtRef.current = 0;
            segmentedLastFailedChunkRef.current = {
                trackId: null,
                sessionId: null,
                chunkName: null,
                statusCode: null,
                observedAtMs: 0,
            };
            resetSegmentedHandoffCircuit(null);
            segmentedHandoffInProgressRef.current = false;
            segmentedHandoffLastRecoveryRef.current = {
                trackId: null,
                resumeAtSec: 0,
                recoveredAtMs: 0,
            };
            segmentedProactiveHandoffAttemptedTrackIdRef.current = null;
            segmentedProactiveHandoffAttemptCountRef.current = 0;
            segmentedProactiveHandoffLastAttemptAtRef.current = 0;
            segmentedProactiveHandoffCompletedTrackIdRef.current = null;
            segmentedProactiveHandoffLastSkipKeyRef.current = null;
            startupSegmentedSessionRef.current = null;
            if (currentTrack) {
                setStreamProfile({
                    mode: "direct",
                    sourceType: resolveDirectTrackSourceType(currentTrack),
                    codec: null,
                    bitrateKbps: null,
                });
            } else {
                setStreamProfile(null);
            }
            return;
        }

        if (
            activeSegmentedSessionRef.current &&
            activeSegmentedSessionRef.current.trackId !== currentTrack.id
        ) {
            clearSegmentedHandoffLoadListeners("track_change");
            activeSegmentedSessionRef.current = null;
            segmentedHeartbeatConsecutiveFailureCountRef.current = 0;
            segmentedHeartbeatLastGuardedRefreshAtMsRef.current = 0;
            segmentedHeartbeatSessionIdRef.current = null;
            segmentedColdStartRebufferDeferralRef.current = {
                trackId: null,
                count: 0,
            };
            segmentedHandoffAttemptRef.current = 0;
            segmentedHandoffLastAttemptAtRef.current = 0;
            segmentedSessionCreateFallbackAttemptRef.current = 0;
            segmentedSessionCreateFallbackLastAttemptAtRef.current = 0;
            segmentedChunkQuarantineRef.current.clear();
            segmentedChunkQuarantineLastRecoveryAtRef.current = 0;
            segmentedLastFailedChunkRef.current = {
                trackId: null,
                sessionId: null,
                chunkName: null,
                statusCode: null,
                observedAtMs: 0,
            };
            resetSegmentedHandoffCircuit(null);
            segmentedHandoffInProgressRef.current = false;
            segmentedHandoffLastRecoveryRef.current = {
                trackId: null,
                resumeAtSec: 0,
                recoveredAtMs: 0,
            };
            segmentedProactiveHandoffAttemptedTrackIdRef.current = null;
            segmentedProactiveHandoffAttemptCountRef.current = 0;
            segmentedProactiveHandoffLastAttemptAtRef.current = 0;
            segmentedProactiveHandoffCompletedTrackIdRef.current = null;
            segmentedProactiveHandoffLastSkipKeyRef.current = null;
            startupSegmentedSessionRef.current = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [
        abortAllSegmentedPrewarmValidations,
        currentTrack,
        clearTransientTrackRecovery,
        clearSegmentedHandoffLoadListeners,
        setStreamProfile,
        resetSegmentedHandoffCircuit,
    ]);

    useEffect(() => {
        if (playbackType !== "track" || !currentTrack) {
            lastLoggedRemotePlayKeyRef.current = null;
            return;
        }
        if (
            currentTrack.streamSource !== "tidal" &&
            currentTrack.streamSource !== "youtube"
        ) {
            lastLoggedRemotePlayKeyRef.current = null;
            return;
        }
        if (!isPlaying || isBuffering) {
            return;
        }

        try {
            const playRef = toAddToPlaylistRef(currentTrack);
            const playKey = JSON.stringify(playRef);
            if (playKey === lastLoggedRemotePlayKeyRef.current) {
                return;
            }
            lastLoggedRemotePlayKeyRef.current = playKey;
            void api.logPlay(playRef).catch((error) => {
                sharedFrontendLogger.warn(
                    "[AudioPlaybackOrchestrator] remote play logging failed",
                    {
                        trackId: currentTrack.id,
                        streamSource: currentTrack.streamSource,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    },
                );
            });
        } catch (error) {
            sharedFrontendLogger.warn(
                "[AudioPlaybackOrchestrator] remote play logging payload failed",
                {
                    trackId: currentTrack.id,
                    streamSource: currentTrack.streamSource,
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            );
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [
        currentTrack,
        currentTrack?.id,
        currentTrack?.streamSource,
        currentTrack?.tidalTrackId,
        currentTrack?.youtubeVideoId,
        isPlaying,
        isBuffering,
        playbackType,
    ]);

    useEffect(() => {
        queueLengthRef.current = queueLength;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [queueLength]);

    useEffect(() => {
        playbackTypeRef.current = playbackType;
        if (playbackType !== "track") {
            trackEndWatchdogRef.current?.clear();
            abortAllSegmentedPrewarmValidations("track_change");
            clearSegmentedHandoffLoadListeners("playback_type_change");
            segmentedStartupRetryCountRef.current = 0;
            segmentedStartupStageAttemptsRef.current =
                createEmptySegmentedStartupRecoveryStageAttempts();
            segmentedStartupRecoveryWindowStartedAtMsRef.current = null;
            segmentedStartupSessionResetCountRef.current = 0;
            markSegmentedStartupRampWindow(null, "playback_type_not_track");
            activeSegmentedSessionRef.current = null;
            activeSegmentedPlaybackTrackIdRef.current = null;
            segmentedHeartbeatConsecutiveFailureCountRef.current = 0;
            segmentedHeartbeatLastGuardedRefreshAtMsRef.current = 0;
            segmentedHeartbeatSessionIdRef.current = null;
            segmentedColdStartRebufferDeferralRef.current = {
                trackId: null,
                count: 0,
            };
            segmentedHandoffAttemptRef.current = 0;
            segmentedHandoffLastAttemptAtRef.current = 0;
            segmentedSessionCreateFallbackAttemptRef.current = 0;
            segmentedSessionCreateFallbackLastAttemptAtRef.current = 0;
            segmentedChunkQuarantineRef.current.clear();
            segmentedChunkQuarantineLastRecoveryAtRef.current = 0;
            segmentedLastFailedChunkRef.current = {
                trackId: null,
                sessionId: null,
                chunkName: null,
                statusCode: null,
                observedAtMs: 0,
            };
            resetSegmentedHandoffCircuit(null);
            segmentedHandoffInProgressRef.current = false;
            segmentedHandoffLastRecoveryRef.current = {
                trackId: null,
                resumeAtSec: 0,
                recoveredAtMs: 0,
            };
            segmentedProactiveHandoffAttemptedTrackIdRef.current = null;
            segmentedProactiveHandoffAttemptCountRef.current = 0;
            segmentedProactiveHandoffLastAttemptAtRef.current = 0;
            segmentedProactiveHandoffCompletedTrackIdRef.current = null;
            segmentedProactiveHandoffLastSkipKeyRef.current = null;
            startupSegmentedSessionRef.current = null;
            setStreamProfile(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [
        abortAllSegmentedPrewarmValidations,
        playbackType,
        setStreamProfile,
        markSegmentedStartupRampWindow,
        resetSegmentedHandoffCircuit,
        clearSegmentedHandoffLoadListeners,
    ]);
}
