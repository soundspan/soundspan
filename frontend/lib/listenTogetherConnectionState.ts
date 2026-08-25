/**
 * Pure reducer for Listen Together socket connection events (GH #787).
 * Each socket lifecycle event maps to one directive describing the state
 * writes and grace-timer transitions the provider must apply. Kept free of
 * React, sockets, and timers so the connection rules are unit-testable.
 */

/** Brief reconnects should not flash the UI grey. */
export const LT_DISCONNECT_GRACE_MS = 2000;

export type ListenTogetherConnectionEvent =
    | { type: "connect" }
    | { type: "reconnect" }
    | { type: "reconnect-attempt"; attempt: number }
    | { type: "reconnect-failed" }
    | { type: "disconnect" }
    /** A previously armed grace timer expired without a reconnect. */
    | { type: "grace-expired"; cause: "reconnect-attempt" | "disconnect" };

export interface ListenTogetherConnectionDirective {
    setIsConnected?: boolean;
    setHasConnectedOnce?: true;
    setReconnectAttempt?: number;
    setSocketRouteStatus?: "ok" | "checking";
    clearSocketRouteError?: true;
    setError?: string;
    /** Cancel a pending visual-disconnect grace timer. */
    clearGraceTimer?: true;
    /**
     * Defer the visual disconnect by LT_DISCONNECT_GRACE_MS. Arm only when
     * no grace timer is already pending — later events just update counters.
     */
    armGraceTimer?: "reconnect-attempt" | "disconnect";
    /** The next group:state event is the hydration snapshot. */
    markAwaitingInitialState?: true;
    /** The reconnect path owns the audio reload/resume. */
    markPendingAudioRecovery?: true;
    /** Re-probe the socket route health. */
    validateRoute?: true;
}

const RECONNECT_FAILED_ERROR =
    "Listen Together reconnect failed. Check route/proxy health and try rejoining.";

/** The provider-visible consequences of one socket lifecycle event. */
export function resolveConnectionEvent(
    event: ListenTogetherConnectionEvent,
): ListenTogetherConnectionDirective {
    switch (event.type) {
        case "connect":
            return {
                clearGraceTimer: true,
                setIsConnected: true,
                setHasConnectedOnce: true,
                setReconnectAttempt: 0,
                setSocketRouteStatus: "ok",
                clearSocketRouteError: true,
                markAwaitingInitialState: true,
            };
        case "reconnect":
            return {
                clearGraceTimer: true,
                setIsConnected: true,
                setReconnectAttempt: 0,
                setSocketRouteStatus: "ok",
                clearSocketRouteError: true,
                markPendingAudioRecovery: true,
            };
        case "reconnect-attempt":
            return {
                setReconnectAttempt: event.attempt,
                markPendingAudioRecovery: true,
                armGraceTimer: "reconnect-attempt",
            };
        case "reconnect-failed":
            return {
                clearGraceTimer: true,
                setIsConnected: false,
                setError: RECONNECT_FAILED_ERROR,
                validateRoute: true,
            };
        case "disconnect":
            return { armGraceTimer: "disconnect" };
        case "grace-expired":
            return event.cause === "reconnect-attempt"
                ? { setIsConnected: false, setSocketRouteStatus: "checking" }
                : { setIsConnected: false };
    }
}
