"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Loader2, ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { useAudio } from "@/lib/audio-context";

interface MapTrack {
    id: string;
    x: number;
    y: number;
    title: string;
    artist: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    dominantMood: string;
    moodScore: number;
    energy: number | null;
    valence: number | null;
}

const MOOD_COLORS: Record<string, string> = {
    moodHappy: "#facc15",
    moodSad: "#60a5fa",
    moodRelaxed: "#34d399",
    moodAggressive: "#ef4444",
    moodParty: "#f97316",
    moodAcoustic: "#c084fc",
    moodElectronic: "#f472b6",
};

function getMoodColor(mood: string): string {
    return MOOD_COLORS[mood] ?? "#6b7280";
}

/**
 * Canvas-based 2D scatter plot of the library's CLAP embedding projections.
 */
export function VibeMap() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [tracks, setTracks] = useState<MapTrack[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [hoveredTrack, setHoveredTrack] = useState<MapTrack | null>(null);
    const [zoom, setZoom] = useState(1);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const isDragging = useRef(false);
    const lastMouse = useRef({ x: 0, y: 0 });
    const { playTrack } = useAudio();

    useEffect(() => {
        async function load() {
            try {
                const data = await api.getVibeMap();
                setTracks(data.tracks);
            } catch {
                setError("Failed to load vibe map data");
            } finally {
                setIsLoading(false);
            }
        }
        void load();
    }, []);

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container || tracks.length === 0) return;

        const rect = container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, rect.width, rect.height);

        const w = rect.width;
        const h = rect.height;
        const padding = 40;

        for (const track of tracks) {
            const px = padding + (track.x * (w - 2 * padding) + offset.x) * zoom;
            const py = padding + (track.y * (h - 2 * padding) + offset.y) * zoom;

            if (px < -10 || px > w + 10 || py < -10 || py > h + 10) continue;

            const radius = hoveredTrack?.id === track.id ? 6 : 3.5;
            const color = getMoodColor(track.dominantMood);
            const alpha = hoveredTrack?.id === track.id ? 1 : 0.7;

            ctx.beginPath();
            ctx.arc(px, py, radius, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.globalAlpha = alpha;
            ctx.fill();
            ctx.globalAlpha = 1;
        }
    }, [tracks, hoveredTrack, zoom, offset]);

    useEffect(() => {
        draw();
    }, [draw]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const observer = new ResizeObserver(() => draw());
        observer.observe(container);
        return () => observer.disconnect();
    }, [draw]);

    const handleMouseMove = useCallback(
        (e: React.MouseEvent<HTMLCanvasElement>) => {
            const canvas = canvasRef.current;
            const container = containerRef.current;
            if (!canvas || !container) return;

            if (isDragging.current) {
                const dx = e.clientX - lastMouse.current.x;
                const dy = e.clientY - lastMouse.current.y;
                lastMouse.current = { x: e.clientX, y: e.clientY };
                setOffset((prev) => ({
                    x: prev.x + dx / zoom,
                    y: prev.y + dy / zoom,
                }));
                return;
            }

            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const w = rect.width;
            const h = rect.height;
            const padding = 40;

            let closest: MapTrack | null = null;
            let closestDist = 20;

            for (const track of tracks) {
                const px = padding + (track.x * (w - 2 * padding) + offset.x) * zoom;
                const py = padding + (track.y * (h - 2 * padding) + offset.y) * zoom;
                const dist = Math.sqrt((mx - px) ** 2 + (my - py) ** 2);
                if (dist < closestDist) {
                    closest = track;
                    closestDist = dist;
                }
            }

            setHoveredTrack(closest);
            canvas.style.cursor = closest ? "pointer" : isDragging.current ? "grabbing" : "grab";
        },
        [tracks, zoom, offset]
    );

    const handleClick = useCallback(() => {
        if (!hoveredTrack) return;
        playTrack({
            id: hoveredTrack.id,
            title: hoveredTrack.title,
            artist: hoveredTrack.artist,
            artistId: hoveredTrack.artistId,
            albumId: hoveredTrack.albumId,
            coverUrl: hoveredTrack.coverUrl,
        } as any);
    }, [hoveredTrack, playTrack]);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        isDragging.current = true;
        lastMouse.current = { x: e.clientX, y: e.clientY };
    }, []);

    const handleMouseUp = useCallback(() => {
        isDragging.current = false;
    }, []);

    const handleWheel = useCallback((e: React.WheelEvent) => {
        e.preventDefault();
        setZoom((prev) => Math.max(0.5, Math.min(5, prev - e.deltaY * 0.001)));
    }, []);

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-full">
                <Loader2 className="w-8 h-8 text-gray-500 animate-spin" />
            </div>
        );
    }

    if (error || tracks.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
                <p className="text-gray-400 text-sm">
                    {error || "No tracks with embeddings available for the map"}
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Controls */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-white/5">
                <p className="text-xs text-gray-500">
                    {tracks.length} tracks &middot; Click to play
                </p>
                <div className="flex items-center gap-1">
                    <button
                        onClick={() => setZoom((z) => Math.min(5, z * 1.3))}
                        className="p-1.5 text-gray-500 hover:text-white hover:bg-white/5 rounded transition-colors"
                        title="Zoom in"
                    >
                        <ZoomIn className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => setZoom((z) => Math.max(0.5, z / 1.3))}
                        className="p-1.5 text-gray-500 hover:text-white hover:bg-white/5 rounded transition-colors"
                        title="Zoom out"
                    >
                        <ZoomOut className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}
                        className="p-1.5 text-gray-500 hover:text-white hover:bg-white/5 rounded transition-colors"
                        title="Reset view"
                    >
                        <RotateCcw className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Canvas */}
            <div ref={containerRef} className="flex-1 relative">
                <canvas
                    ref={canvasRef}
                    className="absolute inset-0"
                    onMouseMove={handleMouseMove}
                    onMouseDown={handleMouseDown}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    onWheel={handleWheel}
                    onClick={handleClick}
                />

                {/* Tooltip */}
                {hoveredTrack && (
                    <div className="absolute bottom-4 left-4 right-4 pointer-events-none">
                        <div className="bg-black/90 border border-white/10 rounded-lg px-3 py-2 inline-block">
                            <p className="text-sm text-white font-medium">
                                {hoveredTrack.title}
                            </p>
                            <p className="text-xs text-gray-400">
                                {hoveredTrack.artist}
                            </p>
                        </div>
                    </div>
                )}
            </div>

            {/* Legend */}
            <div className="flex flex-wrap gap-3 px-4 py-2 border-t border-white/5">
                {Object.entries(MOOD_COLORS).map(([mood, color]) => (
                    <div key={mood} className="flex items-center gap-1.5">
                        <span
                            className="w-2 h-2 rounded-full"
                            style={{ backgroundColor: color }}
                        />
                        <span className="text-[10px] text-gray-500">
                            {mood.replace("mood", "")}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
