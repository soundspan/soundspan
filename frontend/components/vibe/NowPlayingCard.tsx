"use client";

/**
 * NowPlayingCard — the top-left floating "what's playing" card. This is the
 * fullscreen-visibility fix: whenever something is playing it floats over the
 * viz so the track is always readable, in normal and fullscreen alike.
 *
 * Deliberately (mostly) presentational so it renders + tests in static markup:
 * the live audio subscriptions (isPlaying, currentTime/duration, play/pause,
 * on-map lookup) are wired by a thin connected wrapper in VibeMap. Clicking
 * the cover/title flies the viewport to the track's dot (disabled with a
 * tooltip when it isn't on the map). The pulsing dot uses the track's
 * dominant-mood colour (the map's beacon colour logic) and goes static under
 * prefers-reduced-motion via CSS. A hairline progress strip along the bottom
 * edge (fill = the mood colour) gives "how far along is this" at a glance —
 * purely indicative, hidden when duration is unknown/0, no seek interaction.
 */

import { Crosshair, Music, Pause, Play } from "lucide-react";
import { VIBE_ACCENTS } from "./types";

export interface NowPlayingCardTrack {
    id: string;
    title: string;
    artist?: { name?: string | null } | null;
    album?: { coverArt?: string | null } | null;
}

export interface NowPlayingCardProps {
    /** The currently-playing track (audio Track shape). Renders nothing if null. */
    track: NowPlayingCardTrack | null;
    isPlaying: boolean;
    /** Whether this track has a dot on the current map sample. */
    onMapPresent: boolean;
    /** Dominant-mood colour for the on-map pulse dot + cover fallback. */
    moodColor?: string | null;
    /** Fly the viewport to the track's dot (only meaningful when on-map). */
    onFlyTo: () => void;
    /** Toggle play/pause using the real audio controls. */
    onTogglePlay: () => void;
    /** Elapsed playback seconds — pairs with `duration` to draw the tiny
     *  progress strip along the card's bottom edge. Purely indicative (no
     *  seek interaction — a 2px hit target over a pan surface would misfire;
     *  the full player owns seeking). */
    currentTime?: number;
    /** Track duration in seconds. The strip is hidden entirely when this is
     *  0, NaN, or unset — there's nothing meaningful to show. */
    duration?: number;
}

const DEFAULT_COLOR = VIBE_ACCENTS.edge;

export function NowPlayingCard({
    track,
    isPlaying,
    onMapPresent,
    moodColor,
    onFlyTo,
    onTogglePlay,
    currentTime,
    duration,
}: NowPlayingCardProps) {
    if (!track) return null;
    const cover = track.album?.coverArt ?? null;
    const color = moodColor ?? DEFAULT_COLOR;
    const artist = track.artist?.name ?? "";

    const hasProgress =
        typeof duration === "number" && Number.isFinite(duration) && duration > 0;
    const safeCurrentTime = hasProgress
        ? Math.min(Math.max(currentTime ?? 0, 0), duration!)
        : 0;
    const progressPct = hasProgress ? (safeCurrentTime / duration!) * 100 : 0;

    return (
        <div className="pointer-events-auto relative flex items-center gap-2 bg-black/60 backdrop-blur-md border border-white/10 rounded-xl shadow-lg p-2">
            <button
                type="button"
                onClick={onMapPresent ? onFlyTo : undefined}
                disabled={!onMapPresent}
                aria-disabled={!onMapPresent}
                title={
                    onMapPresent
                        ? "Fly to now playing on the map"
                        : "Now playing isn't on the map"
                }
                aria-label={
                    onMapPresent
                        ? `Fly to ${track.title} on the map`
                        : `${track.title} — not on the map`
                }
                className="group flex items-center gap-2 min-w-0 max-w-[min(60vw,15rem)] text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 disabled:cursor-default"
            >
                <span className="relative flex-shrink-0">
                    {cover ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                            src={cover}
                            alt=""
                            loading="lazy"
                            className="w-12 h-12 rounded-lg object-cover"
                        />
                    ) : (
                        <span
                            className="w-12 h-12 rounded-lg grid place-items-center"
                            style={{ backgroundColor: `${color}33` }}
                        >
                            <Music className="w-5 h-5" style={{ color }} />
                        </span>
                    )}
                    {onMapPresent && (
                        <span
                            className="vibe-np-dot"
                            style={{
                                backgroundColor: color,
                                boxShadow: `0 0 6px 1px ${color}`,
                            }}
                            aria-hidden="true"
                        />
                    )}
                </span>
                <span className="min-w-0 flex flex-col">
                    <span className="truncate text-sm text-gray-100">
                        {track.title}
                    </span>
                    {artist && (
                        <span className="hidden sm:block truncate text-xs text-gray-400">
                            {artist}
                        </span>
                    )}
                </span>
            </button>

            {/* The explicit find-me affordance. The cover/title click above
                also flies, but nothing about it LOOKS clickable — with 15k
                dots, "where is this song?" needs a labeled, mood-tinted
                button you can spot without knowing the map's grammar.
                Icon-only below sm (the card competes with the search pill
                for width there); tooltip/aria carry the label everywhere. */}
            {onMapPresent && (
                <button
                    type="button"
                    onClick={onFlyTo}
                    title={`Fly to "${track.title}" on the map`}
                    aria-label={`Find ${track.title} on the map`}
                    className="flex flex-shrink-0 items-center gap-1.5 h-10 px-2.5 sm:px-3 rounded-lg text-xs font-semibold transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                    style={{ backgroundColor: `${color}26`, color }}
                >
                    <Crosshair className="w-4 h-4" />
                    <span className="hidden sm:inline whitespace-nowrap">
                        Find on map
                    </span>
                </button>
            )}

            {/* Play/pause renders at every width: in fullscreen the map covers
                the mini player, making this card the only transport on mobile. */}
            <button
                type="button"
                onClick={onTogglePlay}
                aria-label={isPlaying ? "Pause" : "Play"}
                title={isPlaying ? "Pause" : "Play"}
                className="flex flex-shrink-0 items-center justify-center w-10 h-10 rounded-lg text-gray-200 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 transition-colors"
            >
                {isPlaying ? (
                    <Pause className="w-5 h-5" />
                ) : (
                    <Play className="w-5 h-5" />
                )}
            </button>

            {/* Tiny playback-progress strip along the bottom edge, inset from
                the rounded corners. Purely indicative — no seek interaction;
                the full player owns seeking. Hidden entirely when duration is
                0/NaN/unset (nothing meaningful to show). */}
            {hasProgress && (
                <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(progressPct)}
                    aria-label="Playback progress"
                    className="absolute inset-x-2 bottom-1 h-[2px] rounded-full bg-white/10 overflow-hidden"
                >
                    <div
                        className="h-full rounded-full"
                        style={{
                            width: `${progressPct}%`,
                            backgroundColor: color,
                        }}
                    />
                </div>
            )}

            <style>{`
                .vibe-np-dot {
                    position: absolute;
                    top: -2px;
                    right: -2px;
                    width: 10px;
                    height: 10px;
                    border-radius: 9999px;
                    border: 2px solid rgba(10, 10, 10, 0.8);
                    animation: vibe-np-pulse 1.8s ease-out infinite;
                }
                @keyframes vibe-np-pulse {
                    0%, 100% { transform: scale(1); opacity: 1; }
                    50% { transform: scale(1.35); opacity: 0.55; }
                }
                @media (prefers-reduced-motion: reduce) {
                    .vibe-np-dot { animation: none; }
                }
            `}</style>
        </div>
    );
}
