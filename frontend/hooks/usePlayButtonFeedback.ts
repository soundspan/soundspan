import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Provides short-lived spinner feedback for play-button taps/clicks,
 * even when playback state updates asynchronously.
 */
export function usePlayButtonFeedback(durationMs: number = 450) {
    const [showSpinner, setShowSpinner] = useState(false);
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const trigger = useCallback(() => {
        setShowSpinner(true);
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(() => {
            setShowSpinner(false);
            timeoutRef.current = null;
        }, durationMs);
    }, [durationMs]);

    useEffect(() => {
        return () => {
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
            }
        };
    }, []);

    return { showSpinner, trigger, triggerPlayFeedback: trigger };
}
