/**
 * Pure policies for podcast-episode progress across queue media switches.
 *
 * When the player lands on an episode queue item, saved listening progress is
 * fetched asynchronously and must be baked into the media state before the
 * audio load so the engine starts at the resume position deterministically.
 * By the time the fetch settles the user may have skipped to other media;
 * {@link resolveEpisodeStartPosition} decides whether the episode may still
 * start (and from where), so a stale resolution can never (re)start media the
 * user has moved away from.
 *
 * Conversely, when the player switches OFF a playing episode (manual skip,
 * play-now, podcast-page selection) the episode's position must be persisted
 * first; {@link resolveEpisodeProgressSaveOnSwitch} decides whether and what
 * to save.
 */

import { clampPlaybackTimeToUpperBound } from "../audio-playback-normalization";

/** Saved progress shape of a podcast episode used for resume decisions. */
export interface EpisodeResumeProgress {
    currentTime: number;
    isFinished?: boolean;
}

/** Input for {@link resolveEpisodeStartPosition}. */
export interface ResolveEpisodeStartPositionInput {
    /** Composite "podcastId:episodeId" id the progress lookup was started for. */
    itemId: string;
    /** Id of the media that is active at the time the lookup settles. */
    activeMediaId: string | null;
    /** Saved progress of the fetched episode, when any. */
    progress: EpisodeResumeProgress | null | undefined;
    /** Episode duration in seconds, used as the start-position upper bound. */
    duration: number;
}

/**
 * Decides whether an episode queue item may still start once its saved
 * progress is known, and from which position. Returns `null` when the user
 * has already moved on to other media (stale lookup); otherwise returns the
 * resume position, falling back to the episode start when there is no
 * resumable progress.
 */
export function resolveEpisodeStartPosition(
    input: ResolveEpisodeStartPositionInput
): { startAt: number } | null {
    const { itemId, activeMediaId, progress, duration } = input;
    if (activeMediaId !== itemId) return null;
    if (!progress || progress.isFinished) return { startAt: 0 };

    const startAt = clampPlaybackTimeToUpperBound(
        progress.currentTime,
        duration || progress.currentTime
    );
    return { startAt };
}

/**
 * How close (seconds) to the episode end a position must be to count as a
 * natural end. The orchestrator's ended handler persists the finished state
 * itself; switch-saves inside this window are suppressed so they can never
 * race it and un-finish the episode.
 */
export const EPISODE_END_SAVE_EPSILON_SEC = 1.5;

/** Input for {@link resolveEpisodeProgressSaveOnSwitch}. */
export interface ResolveEpisodeProgressSaveOnSwitchInput {
    /** Playback type at the moment the player is about to switch media. */
    playbackType: "track" | "audiobook" | "podcast" | null;
    /** Composite "podcastId:episodeId" id of the playing episode, if any. */
    currentPodcastId: string | null;
    /** Id of the media the player is switching to. */
    nextMediaId: string | null;
    /** Playback position of the playing episode, in seconds. */
    currentTime: number;
    /** Engine-reported duration in seconds, preferred when available. */
    engineDuration: number;
    /** Episode duration from metadata, used when the engine has none. */
    episodeDuration: number;
}

/**
 * Decides whether the playing episode's position should be persisted before
 * the player switches to other media, and with what payload. Returns `null`
 * when no episode is playing, when the "switch" targets the same episode,
 * when there is nothing worth saving yet, or when the episode just ended
 * naturally (the ended handler owns the finished save).
 */
export function resolveEpisodeProgressSaveOnSwitch(
    input: ResolveEpisodeProgressSaveOnSwitchInput
): {
    podcastId: string;
    episodeId: string;
    currentTime: number;
    duration: number;
} | null {
    const {
        playbackType,
        currentPodcastId,
        nextMediaId,
        currentTime,
        engineDuration,
        episodeDuration,
    } = input;
    if (playbackType !== "podcast" || !currentPodcastId) return null;
    if (nextMediaId === currentPodcastId) return null;
    if (!(currentTime > 0)) return null;

    const [podcastId, episodeId] = currentPodcastId.split(":");
    if (!podcastId || !episodeId) return null;

    const duration = engineDuration || episodeDuration || 0;
    if (duration > 0 && currentTime >= duration - EPISODE_END_SAVE_EPSILON_SEC) {
        return null;
    }

    return { podcastId, episodeId, currentTime, duration };
}
