/**
 * Consecutive Error Circuit Breaker
 *
 * Tracks consecutive playback errors across track transitions.
 * When the threshold is reached, auto-advance should be halted
 * to prevent infinite rapid error loops.
 *
 * Counter resets on any successful playback.
 */

/** Default number of consecutive errors before the breaker trips. */
export const DEFAULT_CONSECUTIVE_ERROR_THRESHOLD = 3;

export interface ConsecutiveErrorBreakerState {
  consecutiveErrors: number;
  tripped: boolean;
}

export interface ConsecutiveErrorBreaker {
  /** Record a playback error. Returns true if the breaker just tripped. */
  recordError(): boolean;
  /** Record a successful play — resets the error counter. */
  recordSuccess(): void;
  /** Check whether the breaker is currently tripped. */
  isTripped(): boolean;
  /** Get the current consecutive error count. */
  getErrorCount(): number;
  /** Manually reset the breaker state. */
  reset(): void;
}

/**
 * Creates a consecutive error circuit breaker.
 */
export function createConsecutiveErrorBreaker(
  threshold: number = DEFAULT_CONSECUTIVE_ERROR_THRESHOLD,
): ConsecutiveErrorBreaker {
  let consecutiveErrors = 0;
  let tripped = false;

  return {
    recordError(): boolean {
      consecutiveErrors += 1;
      if (consecutiveErrors >= threshold && !tripped) {
        tripped = true;
        return true;
      }
      return false;
    },

    recordSuccess(): void {
      consecutiveErrors = 0;
      tripped = false;
    },

    isTripped(): boolean {
      return tripped;
    },

    getErrorCount(): number {
      return consecutiveErrors;
    },

    reset(): void {
      consecutiveErrors = 0;
      tripped = false;
    },
  };
}
