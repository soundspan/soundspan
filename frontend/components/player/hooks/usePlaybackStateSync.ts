import { useEffect } from "react";
import { api } from "@/lib/api";
import type { Track } from "@/lib/audio-state-context";
import type { PlaybackStreamProfile } from "@/lib/audio-playback-context";
import { toAddToPlaylistRef } from "@/lib/trackRef";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { resolveDirectTrackSourceType } from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import type { usePlaybackRecoveryHelpers } from "./usePlaybackRecoveryHelpers";

interface UsePlaybackStateSyncOptions {
    refs: PlaybackOrchestratorRefs;
    playbackRecoveryHelpers: ReturnType<typeof usePlaybackRecoveryHelpers>;
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
    currentTrack,
    playbackType,
    queueLength,
    isPlaying,
    isBuffering,
    setStreamProfile,
}: UsePlaybackStateSyncOptions): void {
    const { clearTransientTrackRecovery } = playbackRecoveryHelpers;
    const {
        currentTrackRef,
        trackEndWatchdogRef,
        startupRecoveryAttemptedTrackIdRef,
        transientTrackRecoveryTrackIdRef,
        lastLoggedRemotePlayKeyRef,
        queueLengthRef,
        playbackTypeRef,
    } = refs;

    useEffect(() => {
        const previousTrackId = currentTrackRef.current?.id ?? null;
        currentTrackRef.current = currentTrack;
        const currentTrackId = currentTrack?.id ?? null;
        if (previousTrackId !== currentTrackId) {
            trackEndWatchdogRef.current?.clear();
        }
        if (currentTrack?.id !== startupRecoveryAttemptedTrackIdRef.current) {
            startupRecoveryAttemptedTrackIdRef.current = null;
        }
        if (currentTrack?.id !== transientTrackRecoveryTrackIdRef.current) {
            clearTransientTrackRecovery(true);
        }
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
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [currentTrack, clearTransientTrackRecovery, setStreamProfile]);

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
            setStreamProfile(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [playbackType, setStreamProfile]);
}
