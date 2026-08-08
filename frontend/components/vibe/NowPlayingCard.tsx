"use client";

/** Presentational now-playing card that stays visible over the map. */

import type { ReactNode } from "react";
import Link from "next/link";
import { Crosshair, Music, Pause, Play } from "lucide-react";
import { VIBE_ACCENTS } from "./types";

export interface NowPlayingCardTrack {
    id: string;
    title: string;
    artist?: { name?: string | null; id?: string | null } | null;
    album?: { coverArt?: string | null; id?: string | null } | null;
}

export interface NowPlayingCardProps {
    track: NowPlayingCardTrack | null;
    isPlaying: boolean;
    onMapPresent: boolean;
    moodColor?: string | null;
    onFlyTo: () => void;
    onTogglePlay: () => void;
    currentTime?: number;
    duration?: number;
    likeSlot?: ReactNode;
}

const DEFAULT_COLOR = VIBE_ACCENTS.edge;
const NOW_PLAYING_STYLES = (
    <style>{`
        .vibe-np-dot {
            position: absolute; top: -2px; right: -2px; width: 10px; height: 10px;
            border-radius: 9999px; border: 2px solid rgba(10, 10, 10, 0.8);
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
);

function CoverButton({ track, onMap, color, onFlyTo }: {
    track: NowPlayingCardTrack;
    onMap: boolean;
    color: string;
    onFlyTo: () => void;
}) {
    const cover = track.album?.coverArt ?? null;
    return (
        <button type="button" onClick={onMap ? onFlyTo : undefined} disabled={!onMap}
            aria-disabled={!onMap}
            title={onMap ? "Fly to now playing on the map" : "Now playing isn't on the map"}
            aria-label={onMap ? `Fly to ${track.title} on the map` : `${track.title} — not on the map`}
            className="group flex-shrink-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 disabled:cursor-default">
            <span className="relative flex-shrink-0 block">
                {cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={cover} alt="" loading="lazy" className="w-12 h-12 rounded-lg object-cover" />
                ) : (
                    <span className="w-12 h-12 rounded-lg grid place-items-center"
                        style={{ backgroundColor: `${color}33` }}>
                        <Music className="w-5 h-5" style={{ color }} />
                    </span>
                )}
                {onMap && <span className="vibe-np-dot"
                    style={{ backgroundColor: color, boxShadow: `0 0 6px 1px ${color}` }}
                    aria-hidden="true" />}
            </span>
        </button>
    );
}

function TrackLabels({ track }: { track: NowPlayingCardTrack }) {
    const artist = track.artist?.name ?? "";
    const artistId = track.artist?.id ?? "";
    const albumId = track.album?.id ?? "";
    const title = albumId ? (
        <Link href={`/album/${albumId}`} className="truncate text-sm text-gray-100 hover:underline">
            {track.title}
        </Link>
    ) : <span className="truncate text-sm text-gray-100">{track.title}</span>;
    const artistLabel = artistId ? (
        <Link href={`/artist/${artistId}`}
            className="hidden sm:block truncate text-xs text-gray-400 hover:underline">{artist}</Link>
    ) : <span className="hidden sm:block truncate text-xs text-gray-400">{artist}</span>;
    return (
        <span className="min-w-0 max-w-[min(38vw,9rem)] flex flex-col">
            {title}
            {artist && artistLabel}
        </span>
    );
}

function FindButton({ track, color, onFlyTo }: {
    track: NowPlayingCardTrack;
    color: string;
    onFlyTo: () => void;
}) {
    return (
        <button type="button" onClick={onFlyTo} title={`Fly to "${track.title}" on the map`}
            aria-label={`Find ${track.title} on the map`}
            className="flex flex-shrink-0 items-center gap-1.5 h-10 px-2.5 sm:px-3 rounded-lg text-xs font-semibold transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
            style={{ backgroundColor: `${color}26`, color }}>
            <Crosshair className="w-4 h-4" />
            <span className="hidden sm:inline whitespace-nowrap">Find on map</span>
        </button>
    );
}

function PlayButton({ playing, toggle }: { playing: boolean; toggle: () => void }) {
    return (
        <button type="button" onClick={toggle} aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause" : "Play"}
            className="flex flex-shrink-0 items-center justify-center w-10 h-10 rounded-lg text-gray-200 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 transition-colors">
            {playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
        </button>
    );
}

function ProgressStrip({ currentTime = 0, duration, color }: {
    currentTime?: number;
    duration?: number;
    color: string;
}) {
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return null;
    const elapsed = Math.min(Math.max(currentTime, 0), duration);
    const percent = (elapsed / duration) * 100;
    return (
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={Math.round(percent)} aria-label="Playback progress"
            className="absolute inset-x-2 bottom-1 h-[2px] rounded-full bg-white/10 overflow-hidden">
            <div className="h-full rounded-full"
                style={{ width: `${percent}%`, backgroundColor: color }} />
        </div>
    );
}

export function NowPlayingCard(props: NowPlayingCardProps) {
    if (!props.track) return null;
    const color = props.moodColor ?? DEFAULT_COLOR;
    return (
        <div className="pointer-events-auto relative flex items-center gap-1.5 sm:gap-2 bg-black/60 backdrop-blur-md border border-white/10 rounded-xl shadow-lg p-2">
            <CoverButton track={props.track} onMap={props.onMapPresent}
                color={color} onFlyTo={props.onFlyTo} />
            <TrackLabels track={props.track} />
            {props.likeSlot && <span className="flex-shrink-0">{props.likeSlot}</span>}
            {props.onMapPresent && <FindButton track={props.track} color={color} onFlyTo={props.onFlyTo} />}
            <PlayButton playing={props.isPlaying} toggle={props.onTogglePlay} />
            <ProgressStrip currentTime={props.currentTime} duration={props.duration} color={color} />
            {NOW_PLAYING_STYLES}
        </div>
    );
}
