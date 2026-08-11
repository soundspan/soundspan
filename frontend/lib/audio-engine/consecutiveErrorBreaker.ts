/**
 * Consecutive Error Circuit Breaker
 *
 * Tracks consecutive playback errors across track transitions.
 * When the threshold is reached, auto-advance should be halted
 * to prevent infinite rapid error loops. After a cooldown, one
 * half-open probe is allowed so transient failures can recover.
 *
 * Counter resets on any successful playback.
 */

/** Default number of consecutive errors before the breaker trips. */
export const DEFAULT_CONSECUTIVE_ERROR_THRESHOLD = 3;

const DEFAULT_HALF_OPEN_COOLDOWN_MS = 60_000;

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
 *
 * @param threshold Consecutive errors required to trip the breaker.
 * @param cooldownMs Time before one half-open probe is allowed.
 * @param now Clock returning epoch milliseconds.
 */
export function createConsecutiveErrorBreaker(
    threshold: number = DEFAULT_CONSECUTIVE_ERROR_THRESHOLD,
    cooldownMs: number = DEFAULT_HALF_OPEN_COOLDOWN_MS,
    now: () => number = Date.now,
): ConsecutiveErrorBreaker {
    let consecutiveErrors = 0;
    let tripped = false;
    let trippedAtMs: number | null = null;
    let halfOpenProbeInFlight = false;

    const trip = (): void => {
        tripped = true;
        trippedAtMs = now();
        halfOpenProbeInFlight = false;
    };

    const clear = (): void => {
        consecutiveErrors = 0;
        tripped = false;
        trippedAtMs = null;
        halfOpenProbeInFlight = false;
    };

    return {
        recordError(): boolean {
            consecutiveErrors += 1;
            if (
                halfOpenProbeInFlight ||
                (consecutiveErrors >= threshold && !tripped)
            ) {
                trip();
                return true;
            }
            return false;
        },

        recordSuccess(): void {
            clear();
        },

        isTripped(): boolean {
            if (!tripped) {
                return false;
            }
            if (halfOpenProbeInFlight || trippedAtMs === null) {
                return true;
            }
            if (now() - trippedAtMs < cooldownMs) {
                return true;
            }
            halfOpenProbeInFlight = true;
            return false;
        },

        getErrorCount(): number {
            return consecutiveErrors;
        },

        reset(): void {
            clear();
        },
    };
}
