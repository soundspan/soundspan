"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface SleepTimerState {
    /** Whether the timer is active. */
    isActive: boolean;
    /** Remaining time in seconds (null when inactive). */
    remainingSeconds: number | null;
    /** The originally set duration in minutes (null when inactive). */
    durationMinutes: number | null;
}

export interface SleepTimerActions {
    /** Start or restart the timer with the given duration in minutes. */
    set: (minutes: number) => void;
    /** Clear the active timer. */
    clear: () => void;
}

/**
 * A sleep timer hook that triggers `onExpire` when the countdown reaches zero.
 *
 * The timer persists across player mode switches within a session because
 * state is held in the hook, not in the audio element.
 */
export function useSleepTimer(onExpire: () => void): [SleepTimerState, SleepTimerActions] {
    const [durationMinutes, setDurationMinutes] = useState<number | null>(null);
    const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const onExpireRef = useRef(onExpire);

    // Keep callback ref fresh without re-triggering the interval.
    useEffect(() => {
        onExpireRef.current = onExpire;
    }, [onExpire]);

    const clearTimer = useCallback(() => {
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
        setDurationMinutes(null);
        setRemainingSeconds(null);
    }, []);

    const setTimer = useCallback(
        (minutes: number) => {
            // Clear any existing timer first.
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
            }

            const totalSeconds = Math.max(1, Math.round(minutes * 60));
            setDurationMinutes(minutes);
            setRemainingSeconds(totalSeconds);

            intervalRef.current = setInterval(() => {
                setRemainingSeconds((prev) => {
                    if (prev === null || prev <= 1) {
                        // Timer expired.
                        if (intervalRef.current) {
                            clearInterval(intervalRef.current);
                            intervalRef.current = null;
                        }
                        setDurationMinutes(null);
                        onExpireRef.current();
                        return null;
                    }
                    return prev - 1;
                });
            }, 1000);
        },
        []
    );

    // Cleanup on unmount.
    useEffect(() => {
        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
            }
        };
    }, []);

    const state: SleepTimerState = {
        isActive: remainingSeconds !== null,
        remainingSeconds,
        durationMinutes,
    };

    const actions: SleepTimerActions = {
        set: setTimer,
        clear: clearTimer,
    };

    return [state, actions];
}

/** Common sleep timer preset durations in minutes. */
export const SLEEP_TIMER_PRESETS = [15, 30, 45, 60, 90, 120] as const;

/** Format remaining seconds as "Xh Ym Zs" or "Ym Zs". */
export function formatSleepTimerRemaining(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}
