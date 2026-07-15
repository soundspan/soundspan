"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * useLatest — mirror `value` into a ref via a `useEffect`, so callbacks that
 * must avoid re-subscribing on every render (rAF loops, native event
 * listeners) can still read the latest value through `.current` without
 * putting it in their own dependency array.
 *
 * Effect-based (not written during render) so the mirror always happens after
 * commit — the same timing every hand-rolled `useRef` + `useEffect` mirror in
 * this file previously had, just collapsed into one reusable hook. Callers
 * that also need to write the ref directly and synchronously (e.g. VibeMap's
 * camera rAF loop, which can't wait for React to re-render before its next
 * frame) may still do so — the returned ref is an ordinary mutable
 * `RefObject`; this hook only adds the passive mirror-on-change behaviour.
 */
export function useLatest<T>(value: T): RefObject<T> {
    const ref = useRef(value);
    useEffect(() => {
        ref.current = value;
    }, [value]);
    return ref;
}
