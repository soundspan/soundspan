"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/utils/cn";

interface LyricLine {
    time: number; // milliseconds
    text: string;
}

const LYRICS_HIGHLIGHT_LEAD_MS = 450;

interface SyncedLyricsProps {
    /** LRC-format synced lyrics string */
    syncedLyrics?: string | null;
    /** Plain text lyrics (fallback when no synced lyrics) */
    plainLyrics?: string | null;
    /** Current playback position in seconds */
    currentTime: number;
    /** Whether playback is active */
    isPlaying: boolean;
    /** Callback to seek to a specific time (seconds) */
    onSeek?: (time: number) => void;
    /** Additional class names */
    className?: string;
}

/**
 * Parse LRC-format lyrics into timestamped lines.
 * LRC format: [mm:ss.xx] Lyric text
 */
function parseLrc(lrc: string): LyricLine[] {
    const lines: LyricLine[] = [];
    const regex = /\[(\d{2}):(\d{2})[.:](\d{2,3})\]\s*(.*)/;

    for (const rawLine of lrc.split("\n")) {
        const match = rawLine.trim().match(regex);
        if (match) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            let milliseconds = parseInt(match[3], 10);
            // If only 2 digits (centiseconds), convert to milliseconds
            if (match[3].length === 2) {
                milliseconds *= 10;
            }
            const time = minutes * 60 * 1000 + seconds * 1000 + milliseconds;
            const text = match[4];
            lines.push({ time, text });
        }
    }

    // Sort by timestamp
    lines.sort((a, b) => a.time - b.time);
    return lines;
}

/**
 * Find the index of the currently active line based on playback position.
 */
function findActiveLine(lines: LyricLine[], currentTimeMs: number): number {
    // Binary search for the last line whose time <= currentTimeMs
    let low = 0;
    let high = lines.length - 1;
    let result = -1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (lines[mid].time <= currentTimeMs) {
            result = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return result;
}

export function SyncedLyrics({
    syncedLyrics,
    plainLyrics,
    currentTime,
    isPlaying,
    onSeek,
    className,
}: SyncedLyricsProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const activeLineRef = useRef<HTMLDivElement>(null);
    const [userScrolling, setUserScrolling] = useState(false);
    const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const lastAutoScrollRef = useRef(0);

    // Parse synced lyrics
    const lines = useMemo(() => {
        if (!syncedLyrics) return [];
        return parseLrc(syncedLyrics);
    }, [syncedLyrics]);

    const currentTimeMs = currentTime * 1000;
    const activeTimeMs = Math.max(0, currentTimeMs + LYRICS_HIGHLIGHT_LEAD_MS);
    const activeIndex = lines.length > 0 ? findActiveLine(lines, activeTimeMs) : -1;

    // Handle user scroll detection
    const handleScroll = useCallback(() => {
        // If the scroll happened very recently after an auto-scroll, ignore it
        if (Date.now() - lastAutoScrollRef.current < 100) return;

        setUserScrolling(true);

        // Clear any existing timeout
        if (scrollTimeoutRef.current) {
            clearTimeout(scrollTimeoutRef.current);
        }

        // Resume auto-scroll after 4 seconds of inactivity
        scrollTimeoutRef.current = setTimeout(() => {
            setUserScrolling(false);
        }, 4000);
    }, []);

    // Auto-scroll to active line
    useEffect(() => {
        if (userScrolling || !activeLineRef.current || !containerRef.current) return;

        lastAutoScrollRef.current = Date.now();
        activeLineRef.current.scrollIntoView({
            behavior: "smooth",
            block: "center",
        });
    }, [activeIndex, userScrolling]);

    // Cleanup timeout on unmount
    useEffect(() => {
        return () => {
            if (scrollTimeoutRef.current) {
                clearTimeout(scrollTimeoutRef.current);
            }
        };
    }, []);

    // Handle clicking on a lyric line to seek
    const handleLineClick = useCallback(
        (timeMs: number) => {
            if (onSeek) {
                onSeek(timeMs / 1000);
            }
        },
        [onSeek]
    );

    // No lyrics at all
    if (!syncedLyrics && !plainLyrics) {
        return (
            <div
                className={cn(
                    "flex items-center justify-center h-full text-gray-500",
                    className
                )}
            >
                <p className="text-sm">No lyrics available</p>
            </div>
        );
    }

    // Plain lyrics fallback (no timestamps)
    if (!syncedLyrics && plainLyrics) {
        return (
            <div
                ref={containerRef}
                className={cn(
                    "overflow-y-auto h-full px-4 py-6 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent",
                    className
                )}
            >
                <div className="space-y-2 max-w-3xl mx-auto">
                    {plainLyrics.split("\n").map((line, i) => (
                        <p
                            key={i}
                            className={cn(
                                "text-base text-gray-300 leading-relaxed transition-colors text-center",
                                line.trim() === "" && "h-4"
                            )}
                        >
                            {line || "\u00A0"}
                        </p>
                    ))}
                </div>
            </div>
        );
    }

    // Synced lyrics
    return (
        <div
            ref={containerRef}
            onScroll={handleScroll}
            className={cn(
                "overflow-y-auto h-full px-4 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent",
                className
            )}
        >
            {/* Top padding so first line can be centered */}
            <div className="h-[40%]" />

            <div className="space-y-1 max-w-3xl mx-auto">
                {lines.map((line, i) => {
                    const isActive = i === activeIndex;
                    const isPast = i < activeIndex;
                    const isEmpty = line.text.trim() === "";

                    return (
                        <div
                            key={i}
                            ref={isActive ? activeLineRef : undefined}
                            onClick={() => !isEmpty && handleLineClick(line.time)}
                            className={cn(
                                "py-1.5 transition-all duration-300 cursor-pointer rounded-lg px-2 text-center",
                                isEmpty && "h-6 cursor-default",
                                !isEmpty && "hover:bg-white/5",
                                isActive &&
                                    "text-white text-lg font-semibold scale-[1.02] origin-center",
                                isPast && !isActive && "text-gray-500 text-base",
                                !isPast && !isActive && "text-gray-400/60 text-base"
                            )}
                        >
                            {line.text || "\u00A0"}
                        </div>
                    );
                })}
            </div>

            {/* Bottom padding so last line can be centered */}
            <div className="h-[40%]" />
        </div>
    );
}
