"use client";

import { memo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { useLyrics } from "@/hooks/useLyrics";
import { SyncedLyrics } from "../SyncedLyrics";
import { buildTabTransitionProps } from "./overlayTabMotion";

interface LyricsLookupTrack {
    id: string;
    artist?: string;
    title: string;
    album?: string;
    duration?: number;
}

interface OverlayLyricsTabProps {
    /** The playing library track, or null when lyrics can't apply. */
    lookupTrack: LyricsLookupTrack | null;
    currentTime: number;
    isPlaying: boolean;
    onSeek: (time: number) => void;
}

/**
 * The overlay drawer's Lyrics tab (GH #787). Owns its lyrics fetch, so the
 * request only happens while this panel is mounted.
 */
export const OverlayLyricsTab = memo(function OverlayLyricsTab({
    lookupTrack,
    currentTime,
    isPlaying,
    onSeek,
}: OverlayLyricsTabProps) {
    const shouldReduceMotion = useReducedMotion();
    const {
        data: lyricsData,
        isLoading: isLyricsLoading,
        isError: isLyricsError,
    } = useLyrics(
        lookupTrack?.id,
        lookupTrack
            ? {
                  artist: lookupTrack.artist,
                  title: lookupTrack.title,
                  album: lookupTrack.album,
                  duration: lookupTrack.duration,
              }
            : undefined,
    );

    return (
        <motion.section
            key="lyrics"
            {...buildTabTransitionProps(shouldReduceMotion)}
            className="h-full overflow-hidden"
        >
            {isLyricsLoading ? (
                <div className="flex h-full items-center justify-center gap-2 text-gray-400">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-sm">Loading lyrics...</span>
                </div>
            ) : isLyricsError ? (
                <div className="flex h-full items-center justify-center px-4">
                    <p className="text-center text-sm text-gray-400">
                        Failed to load lyrics
                    </p>
                </div>
            ) : (
                <SyncedLyrics
                    syncedLyrics={lyricsData?.syncedLyrics ?? null}
                    plainLyrics={lyricsData?.plainLyrics ?? null}
                    currentTime={currentTime}
                    isPlaying={isPlaying}
                    onSeek={onSeek}
                    className="h-full"
                />
            )}
        </motion.section>
    );
});
