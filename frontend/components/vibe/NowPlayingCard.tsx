"use client";

/**
 * NowPlayingCard — the top-left floating "what's playing" card. This is the
 * fullscreen-visibility fix: whenever something is playing it floats over the
 * viz so the track is always readable, in normal and fullscreen alike.
 *
 * Deliberately (mostly) presentational so it renders + tests in static markup:
 * the live audio subscriptions (isPlaying, play/pause, on-map lookup) are wired
 * by a thin connected wrapper in VibeMap. Clicking the cover/title flies the
 * viewport to the track's dot (disabled with a tooltip when it isn't on the
 * map). The pulsing dot uses the track's dominant-mood colour (the map's beacon
 * colour logic) and goes static under prefers-reduced-motion via CSS.
 */

import { Music, Pause, Play } from "lucide-react";

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
}

const DEFAULT_COLOR = "#818cf8";

export function NowPlayingCard({
    track,
    isPlaying,
    onMapPresent,
    moodColor,
    onFlyTo,
    onTogglePlay,
}: NowPlayingCardProps) {
    if (!track) return null;
    const cover = track.album?.coverArt ?? null;
    const color = moodColor ?? DEFAULT_COLOR;
    const artist = track.artist?.name ?? "";

    return (
        <div className="pointer-events-auto flex items-center gap-2 bg-black/60 backdrop-blur-md border border-white/10 rounded-xl shadow-lg p-2">
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
