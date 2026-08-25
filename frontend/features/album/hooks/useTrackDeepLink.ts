import { useEffect, useMemo, useRef } from "react";
import type { Album, Track } from "../types";

function escapeAttributeValue(value: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
        return CSS.escape(value);
    }
    return value.replace(/["\\]/g, "\\$&");
}

function scrollTrackIntoView(trackId: string): void {
    const row = document.querySelector(
        `[data-track-id="${escapeAttributeValue(trackId)}"]`,
    );
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
}

/**
 * Consume a `?track=<id>` deep link on the album page: once the track list is
 * ready, scroll the row into view, highlight it, and attempt playback. The
 * browser may block unmuted autoplay without a prior gesture — the audio
 * engine then leaves the track loaded and paused, which is the intended
 * fallback.
 */
export function useTrackDeepLink(
    album: Album | null,
    playTrack: (track: Track, index: number) => void,
    ready: boolean,
): { highlightTrackId: string | null } {
    const consumedRef = useRef(false);

    const requestedTrackId = useMemo(() => {
        if (typeof window === "undefined") return null;
        return new URLSearchParams(window.location.search).get("track");
    }, []);

    const highlightTrackId = useMemo(() => {
        if (!requestedTrackId || !ready) return null;
        const tracks = album?.tracks;
        if (!tracks?.some((track) => track.id === requestedTrackId)) {
            return null;
        }
        return requestedTrackId;
    }, [requestedTrackId, album, ready]);

    useEffect(() => {
        if (!highlightTrackId || consumedRef.current) return;
        consumedRef.current = true;

        scrollTrackIntoView(highlightTrackId);
        const tracks = album?.tracks ?? [];
        const index = tracks.findIndex(
            (track) => track.id === highlightTrackId,
        );
        if (index >= 0) playTrack(tracks[index], index);
    }, [highlightTrackId, album, playTrack]);

    return { highlightTrackId };
}
