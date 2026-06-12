/**
 * Pure resume-seek policy for podcast episodes started from the play queue.
 *
 * When the player lands on an episode queue item, saved listening progress is
 * fetched asynchronously. By the time the fetch resolves the user may have
 * skipped to other media; this module decides whether the fetched progress
 * may still be applied as a seek, so a stale resolution can never seek (or
 * seek-lock) whatever is playing now to another episode's saved position.
 */

import { clampPlaybackTimeToUpperBound } from "../audio-playback-normalization";

/** Saved progress shape of a podcast episode used for resume decisions. */
export interface EpisodeResumeProgress {
    currentTime: number;
    isFinished?: boolean;
}

/** Input for {@link resolveEpisodeResumeSeek}. */
export interface ResolveEpisodeResumeSeekInput {
    /** Composite "podcastId:episodeId" id the progress fetch was started for. */
    itemId: string;
    /** Id of the media that is active at the time the fetch resolves. */
    activeMediaId: string | null;
    /** Saved progress of the fetched episode, when any. */
    progress: EpisodeResumeProgress | null | undefined;
    /** Episode duration in seconds, used as the seek upper bound. */
    duration: number;
}

/**
 * Decides whether freshly fetched episode progress should be applied as a
 * resume seek. Returns `null` when the user has already moved on to other
 * media (stale fetch), when there is no resumable progress, or when the
 * resume position is at the very start.
 */
export function resolveEpisodeResumeSeek(
    input: ResolveEpisodeResumeSeekInput
): { resumeAt: number } | null {
    const { itemId, activeMediaId, progress, duration } = input;
    if (activeMediaId !== itemId) return null;
    if (!progress || progress.isFinished) return null;

    const resumeAt = clampPlaybackTimeToUpperBound(
        progress.currentTime,
        duration || progress.currentTime
    );
    return resumeAt > 0 ? { resumeAt } : null;
}
