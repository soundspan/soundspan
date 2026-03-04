/**
 * iOS Foreground Recovery Policy
 *
 * When iOS reclaims the audio session (e.g., user switches apps and returns),
 * the audio element may silently stop playing. This module detects the resume
 * via visibilitychange and determines whether playback should be retried.
 *
 * Recovery is attempted only when:
 * 1. The page transitions from hidden → visible
 * 2. Audio was actively playing at the moment the page went hidden
 * 3. The audio engine reports it is no longer playing
 *
 * The wasPlayingWhenHidden snapshot is captured on the hidden→visible
 * transition, not from a persistent "ever played" flag. This prevents
 * spurious recovery on desktop when a user pauses and then switches tabs.
 */

export interface ForegroundRecoveryInput {
  /** Whether the page is now visible (document.visibilityState === "visible"). */
  isVisible: boolean;
  /** Whether audio was actively playing when the page last went hidden. */
  wasPlayingWhenHidden: boolean;
  /** Whether the audio engine reports it is currently playing. */
  engineIsPlaying: boolean;
  /** Current playback state machine state. */
  machineState: string;
}

export interface ForegroundRecoveryDecision {
  shouldRecover: boolean;
  reason: string;
}

/**
 * Determines whether foreground recovery should be attempted.
 */
export function resolveForegroundRecoveryDecision(
  input: ForegroundRecoveryInput,
): ForegroundRecoveryDecision {
  if (!input.isVisible) {
    return { shouldRecover: false, reason: "page_not_visible" };
  }

  if (!input.wasPlayingWhenHidden) {
    return { shouldRecover: false, reason: "not_playing_when_hidden" };
  }

  if (input.engineIsPlaying) {
    return { shouldRecover: false, reason: "engine_still_playing" };
  }

  // Don't recover if already in a recovery/loading path
  if (input.machineState === "LOADING" || input.machineState === "RECOVERING") {
    return { shouldRecover: false, reason: "already_recovering" };
  }

  return { shouldRecover: true, reason: "foreground_resume" };
}

/**
 * Determines whether a media error code represents a network error
 * that should preserve the current track rather than clearing it.
 * MEDIA_ERR_NETWORK (code 2) is the canonical iOS audio session reclaim error.
 */
export function isPreservableNetworkError(errorCode: number | null): boolean {
  return errorCode === 2; // MediaError.MEDIA_ERR_NETWORK
}

const FOREGROUND_RECOVERY_COOLDOWN_MS = 2000;
let lastRecoveryAttemptMs = 0;

/**
 * Rate-limits foreground recovery attempts to prevent rapid-fire retries.
 */
export function shouldThrottleForegroundRecovery(): boolean {
  const now = Date.now();
  if (now - lastRecoveryAttemptMs < FOREGROUND_RECOVERY_COOLDOWN_MS) {
    return true;
  }
  lastRecoveryAttemptMs = now;
  return false;
}

/**
 * Resets the throttle state (for testing).
 */
export function resetForegroundRecoveryThrottle(): void {
  lastRecoveryAttemptMs = 0;
}
