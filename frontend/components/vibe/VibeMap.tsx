"use client";

/**
 * VibeMap — thin container for the vibe map.
 *
 * Wires: data load (raw useEffect + api.getVibeMap, the accepted pattern),
 * viewport state (mapViewport math), non-destructive filters (useMapFilters),
 * now-playing beacon + session trail (MapOverlay / useSessionTrail), and the
 * spotlight lens (SpotlightSearch). Interaction (cursor-anchored wheel zoom,
 * click-vs-drag threshold, transform-aware hit-test) lives here; rendering is
 * delegated to MapCanvas + MapOverlay.
 *
 * F2 interaction (travel / journey / alchemy) is delegated to `useVibeMode`,
 * whose views drive the mode panels + `<MapOverlay decorations>` (MapDecorations).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Crosshair,
    Loader2,
    RotateCcw,
    Route,
    ZoomIn,
    ZoomOut,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { MapCanvas } from "./MapCanvas";
import { MapOverlay } from "./MapOverlay";
import { MapDecorations } from "./MapDecorations";
import { SpotlightSearch } from "./SpotlightSearch";
import { TravelPanel } from "./TravelPanel";
import { JourneyPanel } from "./JourneyPanel";
import { AlchemyTray } from "./AlchemyTray";
import { useMapFilters } from "./useMapFilters";
import { useSessionTrail } from "./useSessionTrail";
import { useVibeMode } from "./useVibeMode";
import {
    fitViewport,
    flyTo,
    worldToScreen,
    zoomAt,
    clampViewport,
    type MapDims,
    type Viewport,
} from "./mapViewport";
import type { MapTrack } from "./types";
import { MOOD_COLORS, getMoodColor, moodLabel } from "./types";

const CLICK_MOVE_THRESHOLD = 4; // px between down/up to still count as a click
const HOVER_HIT_RADIUS = 12; // px

interface DragState {
    active: boolean;
    lastX: number;
    lastY: number;
    moved: number;
}

/** Compact min/max dual-range control (no external deps). */
function DualRange({
    label,
    value,
    onChange,
}: {
    label: string;
    value: [number, number];
    onChange: (v: [number, number]) => void;
}) {
    const [lo, hi] = value;
    return (
        <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-500 w-10">{label}</span>
            <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={lo}
                aria-label={`${label} minimum`}
                onChange={(e) =>
                    onChange([Math.min(parseFloat(e.target.value), hi), hi])
                }
                className="w-14 accent-indigo-400"
            />
            <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={hi}
                aria-label={`${label} maximum`}
                onChange={(e) =>
                    onChange([lo, Math.max(parseFloat(e.target.value), lo)])
                }
                className="w-14 accent-indigo-400"
            />
            <span className="text-[10px] text-gray-600 tabular-nums w-14">
                {lo.toFixed(2)}–{hi.toFixed(2)}
            </span>
        </div>
    );
}

/**
 * Canvas-based 2D navigator over the library's CLAP embedding projections.
 */
export function VibeMap() {
    const containerRef = useRef<HTMLDivElement>(null);
    const [tracks, setTracks] = useState<MapTrack[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [dims, setDims] = useState<MapDims>({ width: 0, height: 0 });
    const [viewport, setViewport] = useState<Viewport | null>(null);
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const [highlightIds, setHighlightIds] = useState<Set<string> | null>(null);
    const drag = useRef<DragState>({ active: false, lastX: 0, lastY: 0, moved: 0 });

    const { currentTrack } = useAudioState();
    const { playTrack, playTracks, addToQueue } = useAudioControls();
    const filters = useMapFilters(tracks);
    const trailIds = useSessionTrail();

    // --- Data load (accepted raw useEffect + api pattern) -------------------
    useEffect(() => {
        let cancelled = false;
        async function load() {
            try {
                const data = await api.getVibeMap();
                if (!cancelled) setTracks(data.tracks);
            } catch {
                if (!cancelled) setError("Failed to load vibe map data");
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        }
        void load();
        return () => {
            cancelled = true;
        };
    }, []);

    // --- Measure container + initialise viewport ---------------------------
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const measure = () => {
            const rect = container.getBoundingClientRect();
            setDims({ width: rect.width, height: rect.height });
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (dims.width > 0 && dims.height > 0) {
            setViewport((vp) => vp ?? fitViewport(dims));
        }
    }, [dims]);

    // --- Lookups ------------------------------------------------------------
    const trackById = useMemo(() => {
        const m = new Map<string, MapTrack>();
        for (const t of tracks) m.set(t.id, t);
        return m;
    }, [tracks]);

    const controls = useMemo(
        () => ({ playTrack, playTracks, addToQueue }),
        [playTrack, playTracks, addToQueue]
    );
    const vibe = useVibeMode({ trackById, currentTrack, controls });

    const beaconTrack = currentTrack ? trackById.get(currentTrack.id) : undefined;
    const beaconOnMap = !!beaconTrack;

    const trailPoints = useMemo(() => {
        const pts: { x: number; y: number }[] = [];
        for (const id of trailIds) {
            const t = trackById.get(id);
            if (t) pts.push({ x: t.x, y: t.y });
        }
        return pts;
    }, [trailIds, trackById]);

    // Alchemy result glow takes over the canvas highlight while blending; the
    // spotlight owns it otherwise.
    const effectiveHighlightIds = vibe.highlightIds ?? highlightIds;
    const effectiveDim = vibe.highlightIds !== null || highlightIds !== null;

    // --- Interaction --------------------------------------------------------
    const cursorFromEvent = useCallback((clientX: number, clientY: number) => {
        const container = containerRef.current;
        if (!container) return { x: 0, y: 0 };
        const rect = container.getBoundingClientRect();
        return { x: clientX - rect.left, y: clientY - rect.top };
    }, []);

    const handleWheel = useCallback(
        (e: React.WheelEvent<HTMLCanvasElement>) => {
            e.preventDefault();
            const cursor = cursorFromEvent(e.clientX, e.clientY);
            const factor = Math.exp(-e.deltaY * 0.0015);
            setViewport((vp) => (vp ? zoomAt(vp, cursor, factor, dims) : vp));
        },
        [cursorFromEvent, dims]
    );

    const handlePointerDown = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>) => {
            drag.current = {
                active: true,
                lastX: e.clientX,
                lastY: e.clientY,
                moved: 0,
            };
            e.currentTarget.setPointerCapture?.(e.pointerId);
        },
        []
    );

    const handlePointerMove = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>) => {
            if (!viewport) return;
            const d = drag.current;
            if (d.active) {
                const dx = e.clientX - d.lastX;
                const dy = e.clientY - d.lastY;
                d.lastX = e.clientX;
                d.lastY = e.clientY;
                d.moved += Math.hypot(dx, dy);
                setViewport((vp) =>
                    vp
                        ? clampViewport(
                              { scale: vp.scale, tx: vp.tx + dx, ty: vp.ty + dy },
                              dims
                          )
                        : vp
                );
                return;
            }

            // Hover hit-test in screen space, skipping filtered-out dots.
            const cursor = cursorFromEvent(e.clientX, e.clientY);
            let closest: string | null = null;
            let closestDist = HOVER_HIT_RADIUS;
            const mask = filters.mask;
            for (let i = 0; i < tracks.length; i++) {
                if (mask[i] === 0) continue;
                const s = worldToScreen(viewport, tracks[i]);
                const dist = Math.hypot(cursor.x - s.x, cursor.y - s.y);
                if (dist < closestDist) {
                    closest = tracks[i].id;
                    closestDist = dist;
                }
            }
            setHoveredId(closest);
        },
        [viewport, dims, cursorFromEvent, tracks, filters.mask]
    );

    const endDrag = useCallback(() => {
        drag.current.active = false;
    }, []);

    const handlePointerUp = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>) => {
            const wasClick = drag.current.active && drag.current.moved < CLICK_MOVE_THRESHOLD;
            drag.current.active = false;
            e.currentTarget.releasePointerCapture?.(e.pointerId);
            if (wasClick && hoveredId) {
                vibe.onDotClick(hoveredId, {
                    ctrlOrMeta: e.ctrlKey || e.metaKey,
                    shift: e.shiftKey,
                });
            }
        },
        [hoveredId, vibe]
    );

    const zoomByCenter = useCallback(
        (factor: number) => {
            setViewport((vp) =>
                vp
                    ? zoomAt(
                          vp,
                          { x: dims.width / 2, y: dims.height / 2 },
                          factor,
                          dims
                      )
                    : vp
            );
        },
        [dims]
    );

    const resetView = useCallback(() => {
        if (dims.width > 0) setViewport(fitViewport(dims));
    }, [dims]);

    const locateNowPlaying = useCallback(() => {
        if (!viewport || !beaconTrack) return;
        const targetScale = Math.max(viewport.scale, fitViewport(dims).scale * 3);
        setViewport(
            flyTo(viewport, { x: beaconTrack.x, y: beaconTrack.y }, targetScale, dims)
        );
    }, [viewport, beaconTrack, dims]);

    // Esc always returns to explore, tearing down the active mode's overlay.
    const vibeMode = vibe.mode;
    const exitToExplore = vibe.exitToExplore;
    useEffect(() => {
        if (vibeMode === "explore") return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") exitToExplore();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [vibeMode, exitToExplore]);

    const hoveredTrack = hoveredId ? trackById.get(hoveredId) : undefined;
    const mapReady = viewport !== null && dims.width > 0 && dims.height > 0;

    return (
        <div className="flex flex-col h-full" data-vibe-mode={vibe.mode}>
            {/* Top bar: spotlight + view controls */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5">
                <SpotlightSearch
                    className="relative flex-1 max-w-xs"
                    onResults={(ids) => setHighlightIds(ids)}
                    onClear={() => setHighlightIds(null)}
                />
                <p className="text-xs text-gray-500 ml-auto whitespace-nowrap tabular-nums">
                    {filters.visibleCount} of {tracks.length} visible
                </p>
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={vibe.startJourney}
                        disabled={!vibe.canStartJourney}
                        title={
                            vibe.canStartJourney
                                ? "Plan a journey from the current track"
                                : "Play a track (or pick one in Travel) to start a journey"
                        }
                        className="flex items-center gap-1 px-2 py-1.5 text-gray-400 hover:text-white hover:bg-white/5 rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400"
                    >
                        <Route className="w-4 h-4" />
                        <span className="text-xs">Journey</span>
                    </button>
                    <button
                        type="button"
                        onClick={locateNowPlaying}
                        disabled={!beaconOnMap}
                        title={
                            beaconOnMap
                                ? "Fly to now playing"
                                : currentTrack
                                  ? "Now playing isn't on the map"
                                  : "Nothing playing"
                        }
                        className="p-1.5 text-gray-500 hover:text-white hover:bg-white/5 rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-500"
                    >
                        <Crosshair className="w-4 h-4" />
                    </button>
                    <button
                        type="button"
                        onClick={() => zoomByCenter(1.3)}
                        className="p-1.5 text-gray-500 hover:text-white hover:bg-white/5 rounded transition-colors"
                        title="Zoom in"
                    >
                        <ZoomIn className="w-4 h-4" />
                    </button>
                    <button
                        type="button"
                        onClick={() => zoomByCenter(1 / 1.3)}
                        className="p-1.5 text-gray-500 hover:text-white hover:bg-white/5 rounded transition-colors"
                        title="Zoom out"
                    >
                        <ZoomOut className="w-4 h-4" />
                    </button>
                    <button
                        type="button"
                        onClick={resetView}
                        className="p-1.5 text-gray-500 hover:text-white hover:bg-white/5 rounded transition-colors"
                        title="Reset view"
                    >
                        <RotateCcw className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Filter bar: mood chips (toggles) + energy/valence ranges */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 border-b border-white/5">
                {Object.keys(MOOD_COLORS).map((mood) => {
                    const active =
                        filters.activeMoods.size === 0 ||
                        filters.activeMoods.has(mood);
                    return (
                        <button
                            key={mood}
                            type="button"
                            onClick={() => filters.toggleMood(mood)}
                            aria-pressed={filters.activeMoods.has(mood)}
                            className={`flex items-center gap-1.5 transition-opacity ${
                                active ? "opacity-100" : "opacity-30"
                            }`}
                            title={`Toggle ${moodLabel(mood)}`}
                        >
                            <span
                                className="w-2 h-2 rounded-full"
                                style={{ backgroundColor: getMoodColor(mood) }}
                            />
                            <span className="text-[10px] text-gray-400">
                                {moodLabel(mood)}
                            </span>
                        </button>
                    );
                })}
                <div className="h-3 w-px bg-white/10 mx-1" />
                <DualRange
                    label="Energy"
                    value={filters.energyRange}
                    onChange={filters.setEnergyRange}
                />
                <DualRange
                    label="Valence"
                    value={filters.valenceRange}
                    onChange={filters.setValenceRange}
                />
            </div>

            {/* Map area */}
            <div ref={containerRef} className="flex-1 relative overflow-hidden">
                {mapReady && (
                    <>
                        <MapCanvas
                            tracks={tracks}
                            viewport={viewport}
                            width={dims.width}
                            height={dims.height}
                            mask={filters.mask}
                            highlightIds={effectiveHighlightIds}
                            dimUnhighlighted={effectiveDim}
                            hoveredId={hoveredId}
                            onWheel={handleWheel}
                            onPointerDown={handlePointerDown}
                            onPointerMove={handlePointerMove}
                            onPointerUp={handlePointerUp}
                            onPointerLeave={endDrag}
                        />
                        <MapOverlay
                            viewport={viewport}
                            width={dims.width}
                            height={dims.height}
                            beacon={
                                beaconTrack
                                    ? { x: beaconTrack.x, y: beaconTrack.y }
                                    : null
                            }
                            trail={trailPoints}
                            decorations={
                                <MapDecorations
                                    viewport={viewport}
                                    trackById={trackById}
                                    travel={
                                        vibe.travel
                                            ? {
                                                  currentId:
                                                      vibe.travel.currentId,
                                                  breadcrumbIds:
                                                      vibe.travel.breadcrumbTitles.map(
                                                          (b) => b.id
                                                      ),
                                                  onMapNeighbors:
                                                      vibe.travel.onMapNeighbors,
                                                  onNavigate:
                                                      vibe.travel.navigate,
                                                  onQueue: vibe.travel.queue,
                                              }
                                            : null
                                    }
                                    journey={
                                        vibe.journey
                                            ? {
                                                  fromId: vibe.journey.fromId,
                                                  waypoints:
                                                      vibe.journey.waypoints,
                                              }
                                            : null
                                    }
                                />
                            }
                        />
                    </>
                )}

                {/* Mode panels (compact overlays / mobile bottom-sheet). */}
                {vibe.travel && <TravelPanel view={vibe.travel} />}
                {vibe.journey && <JourneyPanel view={vibe.journey} />}
                {vibe.alchemy && <AlchemyTray view={vibe.alchemy} />}

                {/* Status overlays in the map area (do not hide the controls). */}
                {isLoading && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <Loader2 className="w-8 h-8 text-gray-500 animate-spin" />
                    </div>
                )}
                {!isLoading && (error || tracks.length === 0) && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4 pointer-events-none">
                        <p className="text-gray-400 text-sm">
                            {error ||
                                "No tracks with embeddings available for the map"}
                        </p>
                    </div>
                )}

                {/* Hover tooltip */}
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
        </div>
    );
}
