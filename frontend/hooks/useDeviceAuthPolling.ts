"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Lifecycle phase for a device-code authentication attempt. */
export type DeviceAuthPhase =
    | "idle"
    | "loading"
    | "polling"
    | "success"
    | "error";

/** Normalized device-code session returned by an authentication initiator. */
export interface DeviceAuthSession {
    deviceCode: string;
    verificationUri: string;
    userCode?: string;
    pollIntervalMs: number;
    expiresAtMs: number;
}

/** Result of one device-code authentication poll. */
export type DeviceAuthPollOutcome =
    | { status: "pending" }
    | { status: "success" }
    | { status: "error"; message: string };

/** Callbacks and messages used by the device authentication polling state machine. */
export interface UseDeviceAuthPollingOptions {
    initiate: () => Promise<DeviceAuthSession>;
    poll: (deviceCode: string) => Promise<DeviceAuthPollOutcome>;
    onSessionStarted?: (session: DeviceAuthSession) => void;
    onSuccess?: () => void;
    expiredMessage?: string;
    startErrorMessage?: string;
}

/** Observable state and controls returned by {@link useDeviceAuthPolling}. */
export interface UseDeviceAuthPollingReturn {
    phase: DeviceAuthPhase;
    session: DeviceAuthSession | null;
    error: string | null;
    timeLeftSeconds: number | null;
    start: () => Promise<void>;
    cancel: () => void;
}

interface TimerStore {
    schedulePoll: (callback: () => void, delay: number) => void;
    scheduleCountdown: (callback: () => void) => void;
    clearPoll: () => void;
    clearCountdown: () => void;
    clearAll: () => void;
}

function createTimerStore(): TimerStore {
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let countdownTimer: ReturnType<typeof setInterval> | null = null;
    const clearPoll = () => {
        if (pollTimer === null) return;
        clearTimeout(pollTimer);
        pollTimer = null;
    };
    const clearCountdown = () => {
        if (countdownTimer === null) return;
        clearInterval(countdownTimer);
        countdownTimer = null;
    };
    return {
        schedulePoll: (callback, delay) => {
            clearPoll();
            pollTimer = setTimeout(callback, delay);
        },
        scheduleCountdown: (callback) => {
            clearCountdown();
            countdownTimer = setInterval(callback, 1_000);
        },
        clearPoll,
        clearCountdown,
        clearAll: () => {
            clearPoll();
            clearCountdown();
        },
    };
}

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

/** Owns initiation, recursive polling, expiry, cancellation, and timer cleanup. */
export function useDeviceAuthPolling(
    options: UseDeviceAuthPollingOptions,
): UseDeviceAuthPollingReturn {
    const [phase, setPhase] = useState<DeviceAuthPhase>("idle");
    const [session, setSession] = useState<DeviceAuthSession | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [timeLeftSeconds, setTimeLeftSeconds] = useState<number | null>(null);
    const [timers] = useState(createTimerStore);
    const optionsRef = useRef(options);
    const generationRef = useRef(0);
    const mountedRef = useRef(true);

    useEffect(() => {
        optionsRef.current = options;
    }, [options]);

    const invalidate = useCallback((): number => {
        generationRef.current += 1;
        timers.clearAll();
        return generationRef.current;
    }, [timers]);

    const cancel = useCallback(() => {
        invalidate();
        setPhase("idle");
        setSession(null);
        setError(null);
        setTimeLeftSeconds(null);
    }, [invalidate]);

    const start = useCallback(async () => {
        const runId = invalidate();
        setPhase("loading");
        setSession(null);
        setError(null);
        setTimeLeftSeconds(null);
        try {
            const nextSession = await optionsRef.current.initiate();
            if (!mountedRef.current || generationRef.current !== runId) return;
            setSession(nextSession);
            setPhase("polling");
            optionsRef.current.onSessionStarted?.(nextSession);
        } catch (caught) {
            if (!mountedRef.current || generationRef.current !== runId) return;
            const fallback =
                optionsRef.current.startErrorMessage ??
                "Failed to start device authentication";
            setPhase("error");
            setError(errorMessage(caught, fallback));
        }
    }, [invalidate]);

    usePolling({
        phase,
        session,
        generationRef,
        timers,
        invalidate,
        optionsRef,
        setPhase,
        setError,
        setTimeLeftSeconds,
    });
    useExpiry({
        phase,
        session,
        generationRef,
        timers,
        invalidate,
        optionsRef,
        setPhase,
        setError,
        setTimeLeftSeconds,
    });

    useEffect(() => {
        // Re-arm on every mount so Strict Mode's simulated unmount/remount
        // cycle cannot leave the hook permanently marked as unmounted.
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            invalidate();
        };
    }, [invalidate]);

    return { phase, session, error, timeLeftSeconds, start, cancel };
}

interface PollingEffectArgs {
    phase: DeviceAuthPhase;
    session: DeviceAuthSession | null;
    generationRef: React.MutableRefObject<number>;
    timers: TimerStore;
    invalidate: () => number;
    optionsRef: React.MutableRefObject<UseDeviceAuthPollingOptions>;
    setPhase: React.Dispatch<React.SetStateAction<DeviceAuthPhase>>;
    setError: React.Dispatch<React.SetStateAction<string | null>>;
    setTimeLeftSeconds: React.Dispatch<React.SetStateAction<number | null>>;
}

function usePolling({
    phase,
    session,
    generationRef,
    timers,
    invalidate,
    optionsRef,
    setPhase,
    setError,
    setTimeLeftSeconds,
}: PollingEffectArgs): void {
    useEffect(() => {
        if (phase !== "polling" || !session) return;
        const activeSession = session;
        const runId = generationRef.current;
        const delay = Math.max(1, session.pollIntervalMs);
        const active = () => generationRef.current === runId;
        const schedule = () => {
            timers.schedulePoll(execute, delay);
        };
        const finish = (
            outcome: Exclude<DeviceAuthPollOutcome, { status: "pending" }>,
        ) => {
            invalidate();
            setTimeLeftSeconds(null);
            setPhase(outcome.status);
            if (outcome.status === "error") setError(outcome.message);
            else optionsRef.current.onSuccess?.();
        };
        async function execute() {
            if (!active()) return;
            let outcome: DeviceAuthPollOutcome;
            try {
                outcome = await optionsRef.current.poll(
                    activeSession.deviceCode,
                );
            } catch {
                if (active()) schedule();
                return;
            }
            if (!active()) return;
            if (outcome.status === "pending") schedule();
            else finish(outcome);
        }
        schedule();
        return timers.clearPoll;
    }, [
        phase,
        session,
        generationRef,
        timers,
        invalidate,
        optionsRef,
        setPhase,
        setError,
        setTimeLeftSeconds,
    ]);
}

interface ExpiryEffectArgs {
    phase: DeviceAuthPhase;
    session: DeviceAuthSession | null;
    generationRef: React.MutableRefObject<number>;
    timers: TimerStore;
    invalidate: () => number;
    optionsRef: React.MutableRefObject<UseDeviceAuthPollingOptions>;
    setPhase: React.Dispatch<React.SetStateAction<DeviceAuthPhase>>;
    setError: React.Dispatch<React.SetStateAction<string | null>>;
    setTimeLeftSeconds: React.Dispatch<React.SetStateAction<number | null>>;
}

function useExpiry({
    phase,
    session,
    generationRef,
    timers,
    invalidate,
    optionsRef,
    setPhase,
    setError,
    setTimeLeftSeconds,
}: ExpiryEffectArgs): void {
    useEffect(() => {
        if (phase !== "polling" || !session) {
            setTimeLeftSeconds(null);
            return;
        }
        const runId = generationRef.current;
        const tick = () => {
            if (generationRef.current !== runId) return;
            const remaining = Math.max(
                0,
                Math.floor((session.expiresAtMs - Date.now()) / 1_000),
            );
            if (remaining > 0) {
                setTimeLeftSeconds(remaining);
                return;
            }
            invalidate();
            setTimeLeftSeconds(null);
            setPhase("error");
            setError(
                optionsRef.current.expiredMessage ?? "Device code expired",
            );
        };
        tick();
        timers.scheduleCountdown(tick);
        return timers.clearCountdown;
    }, [
        phase,
        session,
        generationRef,
        timers,
        invalidate,
        optionsRef,
        setPhase,
        setError,
        setTimeLeftSeconds,
    ]);
}
