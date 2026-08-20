import { isPlaybackAutoRestartSuppressed } from "./playbackAdvanceOrigin";

interface ListenTogetherResumeOptions {
    suppressListenTogetherBroadcast: true;
    listenTogetherForceIsPlaying: true;
    listenTogetherPositionMs: number;
    listenTogetherServerTimeMs: number;
}

type ResumePlayback = (options: ListenTogetherResumeOptions) => void;

interface ListenTogetherPlaybackPosition {
    positionMs: number;
    serverTime: number;
}

/** Resumes synchronized playback unless the local failure breaker is open. */
export function resumeListenTogetherPlayback(
    resume: ResumePlayback,
    playback: ListenTogetherPlaybackPosition,
): boolean {
    if (isPlaybackAutoRestartSuppressed()) return false;
    resume({
        suppressListenTogetherBroadcast: true,
        listenTogetherForceIsPlaying: true,
        listenTogetherPositionMs: playback.positionMs,
        listenTogetherServerTimeMs: playback.serverTime,
    });
    return true;
}
