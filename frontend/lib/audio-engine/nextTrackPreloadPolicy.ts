/**
 * Next Track Preload Policy
 *
 * Determines whether and how the next track should be pre-loaded
 * at the point when the current track ends, before the React state
 * update cycle. This eliminates the silence gap on iOS where the OS
 * reclaims the audio session between tracks.
 */

export interface NextTrackPreloadInput {
  /** Current playback type. */
  playbackType: string | null;
  /** Repeat mode. */
  repeatMode: "off" | "one" | "all";
  /** Whether this is a listen-together session. */
  isListenTogether: boolean;
  /** Whether the engine is currently loading. */
  isLoading: boolean;
}

export interface NextTrackPreloadDecision {
  shouldPreload: boolean;
  reason: string;
}

/**
 * Determines whether the next track should be eagerly loaded
 * from the ended handler before React state transitions.
 */
export function resolveNextTrackPreloadDecision(
  input: NextTrackPreloadInput,
): NextTrackPreloadDecision {
  if (input.playbackType !== "track") {
    return { shouldPreload: false, reason: "not_track_playback" };
  }

  if (input.repeatMode === "one") {
    return { shouldPreload: false, reason: "repeat_one_handles_itself" };
  }

  if (input.isListenTogether) {
    return { shouldPreload: false, reason: "listen_together_controlled" };
  }

  if (input.isLoading) {
    return { shouldPreload: false, reason: "already_loading" };
  }

  return { shouldPreload: true, reason: "eligible" };
}
