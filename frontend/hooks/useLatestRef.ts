"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * A ref that always holds the latest committed value (GH #787). Lets a
 * long-lived closure (socket handlers, timers) read fresh state without
 * appearing in dependency arrays — replacing hand-rolled mirror effects.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
    const ref = useRef(value);
    useEffect(() => {
        ref.current = value;
    });
    return ref;
}
