"use client";

/**
 * VibeMap — thin container for the vibe map.
 *
 * Wires: data load (raw useEffect + api.getVibeMap, the accepted pattern),
 * viewport state (mapViewport math), non-destructive filters (useMapFilters),
 * now-playing beacon + session trail (MapOverlay / useSessionTrail), the
 * spotlight lens (SpotlightSearch), and the natural/spread layout toggle
 * (mapLayout). Interaction (cursor-anchored wheel zoom, click-vs-drag
 * threshold, transform-aware hit-test) lives here; rendering is delegated to
 * MapCanvas + MapOverlay.
 *
 * F2 interaction (travel / journey / alchemy) is delegated to `useVibeMode`,
 * whose views drive the mode panels + `<MapOverlay decorations>` (MapDecorations).
 *
 * SINGLE SOURCE OF POSITIONS: once tracks are loaded, `positions` (a flat
 * index-aligned Float32Array) is the only place any consumer reads a track's
 * on-map coordinates from — never `track.x`/`track.y` directly. `posOf(id)`
 * resolves it by id (via `indexById`) for consumers that only have an id
 * (beacon, trail, MapDecorations); MapCanvas and the hit-test read it by
 * index directly. This keeps every renderer in sync while the spread-layout
 * toggle animates `positions` between the natural and spread buffers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { MapCanvas } from "./MapCanvas";
import { MapOverlay } from "./MapOverlay";
import { MapDecorations } from "./MapDecorations";
import { SpotlightSearch } from "./SpotlightSearch";
import { NowPlayingCard, type NowPlayingCardTrack } from "./NowPlayingCard";
import { ViewControls } from "./ViewControls";
import { FiltersPanel } from "./FiltersPanel";
import { TravelPanel } from "./TravelPanel";
import { JourneyPanel } from "./JourneyPanel";
import { AlchemyTray } from "./AlchemyTray";
import { useMapFilters } from "./useMapFilters";
import { useSessionTrail } from "./useSessionTrail";
import { useVibeMode } from "./useVibeMode";
import {
    computeDotRadius,
    fitViewport,
    flyTo,
    worldToScreen,
    zoomAt,
    clampViewport,
    type MapDims,
    type Viewport,
} from "./mapViewport";
import { buildPositions, computeSpreadPositions, lerpPositions } from "./mapLayout";
import type { MapTrack } from "./types";
import { getMoodColor } from "./types";

const CLICK_MOVE_THRESHOLD = 4; // px between down/up to still count as a click
const MIN_HOVER_HIT_RADIUS = 8; // px — floor for touch-friendly hit-testing

type LayoutMode = "natural" | "spread";
const LAYOUT_STORAGE_KEY = "vibe:layout-mode";
const LAYOUT_ANIM_MS = 400;

function easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function readStoredLayoutMode(): LayoutMode {
    if (typeof window === "undefined") return "natural";
    try {
        return window.sessionStorage.getItem(LAYOUT_STORAGE_KEY) === "spread"
            ? "spread"
            : "natural";
    } catch {
        return "natural";
    }
}

interface DragState {
    active: boolean;
    lastX: number;
    lastY: number;
    moved: number;
}

/**
 * Thin connected wrapper for the now-playing card. It isolates the
 * frequently-changing `isPlaying` subscription (the audio playback clock ticks
 * several times a second) to just the card, so VibeMap — the 15k-dot canvas
 * host — never re-renders on the playback clock. Play/pause uses the verified
 * real controls (`pause()` / `play()`, matching the MiniPlayer toggle).
 */
function NowPlayingConnected({
    track,
    onMapPresent,
    moodColor,
    onFlyTo,
}: {
    track: NowPlayingCardTrack | null;
    onMapPresent: boolean;
    moodColor: string | null;
    onFlyTo: () => void;
}) {
    const { isPlaying } = useAudioPlayback();
    const { pause, play } = useAudioControls();
    const onTogglePlay = useCallback(
        () => (isPlaying ? pause() : play()),
        [isPlaying, pause, play]
    );
    return (
        <NowPlayingCard
            track={track}
            isPlaying={isPlaying}
            onMapPresent={onMapPresent}
            moodColor={moodColor}
            onFlyTo={onFlyTo}
            onTogglePlay={onTogglePlay}
        />
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
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [filtersExpanded, setFiltersExpanded] = useState(false);
    const [escHintVisible, setEscHintVisible] = useState(false);
    const drag = useRef<DragState>({ active: false, lastX: 0, lastY: 0, moved: 0 });

    const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
    const isSmall = useMediaQuery("(max-width: 639px)");

    const { currentTrack } = useAudioState();
    const { playTrack, playTracks, addToQueue } = useAudioControls();
    const filters = useMapFilters(tracks);
    const trailIds = useSessionTrail();

    // --- Layout (natural vs spread) — single source of positions -----------
    const naturalPositions = useMemo(() => buildPositions(tracks), [tracks]);
    const spreadPositions = useMemo(() => computeSpreadPositions(tracks), [tracks]);

    const [layoutMode, setLayoutMode] = useState<LayoutMode>(readStoredLayoutMode);
    const layoutModeRef = useRef(layoutMode);
    useEffect(() => {
        layoutModeRef.current = layoutMode;
    }, [layoutMode]);

    const [rawPositions, setRawPositions] = useState<Float32Array>(
        () => new Float32Array(0)
    );
    const layoutRafRef = useRef<number | null>(null);
    const layoutBuffersRef = useRef<[Float32Array, Float32Array]>([
        new Float32Array(0),
        new Float32Array(0),
    ]);
    const layoutFlipRef = useRef(0);

    // Hard-snap to the current mode's buffer whenever the track list changes
    // (initial load / reload) — no animation. Toggling layoutMode itself is
    // handled by toggleLayoutMode's own rAF loop, so this intentionally does
    // NOT depend on layoutMode (only on tracks / the buffers derived from it).
    useEffect(() => {
        if (layoutRafRef.current != null) {
            cancelAnimationFrame(layoutRafRef.current);
            layoutRafRef.current = null;
        }
        setRawPositions(
            layoutModeRef.current === "spread" ? spreadPositions : naturalPositions
        );
    }, [tracks, naturalPositions, spreadPositions]);

    useEffect(() => {
        return () => {
            if (layoutRafRef.current != null) {
                cancelAnimationFrame(layoutRafRef.current);
            }
        };
    }, []);

    // Guard against the one-render gap between `tracks` changing and the
    // snap effect committing: fall back to the (always correctly-sized)
    // natural buffer rather than ever exposing a mismatched positions array.
    const positions =
        rawPositions.length === tracks.length * 2 ? rawPositions : naturalPositions;

    const toggleLayoutMode = useCallback(() => {
        const next: LayoutMode = layoutMode === "spread" ? "natural" : "spread";
        const from = positions;
        const to = next === "spread" ? spreadPositions : naturalPositions;

        setLayoutMode(next);
        if (typeof window !== "undefined") {
            try {
                window.sessionStorage.setItem(LAYOUT_STORAGE_KEY, next);
            } catch {
                /* private mode / quota — layout choice is best-effort */
            }
        }

        if (layoutRafRef.current != null) {
            cancelAnimationFrame(layoutRafRef.current);
            layoutRafRef.current = null;
        }

        // Reduced motion: snap straight to the target buffer in a single
        // setState — no rAF loop, no interpolation.
        if (reducedMotion) {
            setRawPositions(to);
            return;
        }

        if (layoutBuffersRef.current[0].length !== to.length) {
            layoutBuffersRef.current = [
                new Float32Array(to.length),
                new Float32Array(to.length),
            ];
        }

        const start =
            typeof performance !== "undefined" ? performance.now() : Date.now();
        const tick = (now: number) => {
            const elapsed = now - start;
            const t = Math.min(1, elapsed / LAYOUT_ANIM_MS);
            const eased = easeInOutCubic(t);
            const outBuf = layoutBuffersRef.current[layoutFlipRef.current % 2];
            layoutFlipRef.current += 1;
            setRawPositions(lerpPositions(from, to, eased, outBuf));
            if (t < 1) {
                layoutRafRef.current = requestAnimationFrame(tick);
            } else {
                layoutRafRef.current = null;
            }
        };
        layoutRafRef.current = requestAnimationFrame(tick);
    }, [layoutMode, positions, spreadPositions, naturalPositions, reducedMotion]);

    const indexById = useMemo(() => {
        const m = new Map<string, number>();
        for (let i = 0; i < tracks.length; i++) m.set(tracks[i].id, i);
        return m;
    }, [tracks]);

    /** Live position resolver — the single source every id-based consumer reads through. */
    const posOf = useCallback(
        (id: string): { x: number; y: number } | null => {
            const idx = indexById.get(id);
            if (idx == null) return null;
            return { x: positions[idx * 2], y: positions[idx * 2 + 1] };
        },
        [indexById, positions]
    );

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
    const beaconPos = currentTrack ? posOf(currentTrack.id) : null;

    const trailPoints = useMemo(() => {
        const pts: { x: number; y: number }[] = [];
        for (const id of trailIds) {
            const p = posOf(id);
            if (p) pts.push(p);
        }
        return pts;
    }, [trailIds, posOf]);

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

    // A neighbour halo (MapDecorations) opts into pointer events so it can be
    // clicked, which means a drag that *starts* on a halo never reaches the
    // canvas's own onPointerDown. This arms the same drag state directly so
    // panning can still begin from a halo. Deliberately does not call
    // setPointerCapture (that belongs to the canvas, not this SVG circle).
    const handleHaloPointerDown = useCallback(
        (e: React.PointerEvent<SVGCircleElement>) => {
            drag.current = {
                active: true,
                lastX: e.clientX,
                lastY: e.clientY,
                moved: 0,
            };
        },
        []
    );

    // Shared hit-test (screen space, skipping filtered-out dots) used by both
    // hover (pointermove) and the touch click fallback (pointerup) below.
    // Reads the SAME `positions` buffer MapCanvas renders from, and the same
    // zoom-scaled radius it draws dots at (floored for touch-friendliness).
    const hitTest = useCallback(
        (clientX: number, clientY: number): string | null => {
            if (!viewport) return null;
            const cursor = cursorFromEvent(clientX, clientY);
            const fitScale = fitViewport(dims).scale;
            const dotRadius = computeDotRadius(viewport.scale, fitScale);
            const hitRadius = Math.max(dotRadius, MIN_HOVER_HIT_RADIUS);
            let closest: string | null = null;
            let closestDist = hitRadius;
            const mask = filters.mask;
            for (let i = 0; i < tracks.length; i++) {
                if (mask[i] === 0) continue;
                const world = { x: positions[i * 2], y: positions[i * 2 + 1] };
                const s = worldToScreen(viewport, world);
                const dist = Math.hypot(cursor.x - s.x, cursor.y - s.y);
                if (dist < closestDist) {
                    closest = tracks[i].id;
                    closestDist = dist;
                }
            }
            return closest;
        },
        [viewport, cursorFromEvent, tracks, filters.mask, dims, positions]
    );

    const handlePointerMove = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>) => {
            if (!viewport) return;
            const d = drag.current;
            if (d.active) {
                // Self-heal a drag armed by a halo pointerdown whose matching
                // pointerup landed on the halo itself (stationary tap — the
                // halo has no pointerup wiring back to this canvas): once no
                // button/touch is actually down, stop treating hover as a pan.
                if (e.buttons === 0) {
                    d.active = false;
                } else {
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
            }

            setHoveredId(hitTest(e.clientX, e.clientY));
        },
        [viewport, dims, hitTest]
    );

    const endDrag = useCallback(() => {
        drag.current.active = false;
    }, []);

    const handlePointerUp = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>) => {
            const wasClick = drag.current.active && drag.current.moved < CLICK_MOVE_THRESHOLD;
            drag.current.active = false;
            e.currentTarget.releasePointerCapture?.(e.pointerId);
            if (wasClick) {
                // Touch taps never set hoveredId (no hover concept on touch, and
                // pointermove during the tap takes the drag branch above), so
                // fall back to hit-testing at the pointerup coordinates.
                const clickedId = hoveredId ?? hitTest(e.clientX, e.clientY);
                if (clickedId) {
                    vibe.onDotClick(clickedId, {
                        ctrlOrMeta: e.ctrlKey || e.metaKey,
                        shift: e.shiftKey,
                    });
                }
            }
        },
        [hoveredId, hitTest, vibe]
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
        if (!viewport || !beaconTrack || !currentTrack) return;
        const pos = posOf(currentTrack.id);
        if (!pos) return;
        const targetScale = Math.max(viewport.scale, fitViewport(dims).scale * 3);
        setViewport(flyTo(viewport, pos, targetScale, dims));
    }, [viewport, beaconTrack, currentTrack, posOf, dims]);

    // Esc priority: (1) spotlight-input clearing swallows the event itself
    // (SpotlightSearch's own onKeyDown + stopPropagation, unchanged); (2) an
    // active mode (travel/journey/alchemy) exits to explore; (3) only once
    // back in explore does Esc close fullscreen.
    const vibeMode = vibe.mode;
    const exitToExplore = vibe.exitToExplore;
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            if (vibeMode !== "explore") {
                exitToExplore();
            } else if (isFullscreen) {
                setIsFullscreen(false);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [vibeMode, exitToExplore, isFullscreen]);

    // Fullscreen nicety: a bottom-center "Esc to exit" whisper that fades out
    // after ~2.5s. Under reduced motion the chip is static-then-removed (no
    // fade) — same timeout, the fade animation itself is disabled via CSS.
    useEffect(() => {
        if (!isFullscreen) {
            setEscHintVisible(false);
            return;
        }
        setEscHintVisible(true);
        const id = setTimeout(() => setEscHintVisible(false), 2500);
        return () => clearTimeout(id);
    }, [isFullscreen]);

    const hoveredTrack = hoveredId ? trackById.get(hoveredId) : undefined;
    const mapReady = viewport !== null && dims.width > 0 && dims.height > 0;
    // A mode panel (travel/journey/alchemy) takes over the right side / bottom
    // sheet; auto-collapse the filters so they can't collide with it.
    const modePanelOpen = vibe.mode !== "explore";
    const filtersOpen = filtersExpanded && !modePanelOpen;

    return (
        <div
            className={
                isFullscreen
                    ? "fixed inset-0 z-[100] bg-[#0a0a0a] overflow-hidden"
                    : "relative w-full h-full overflow-hidden"
            }
            data-vibe-mode={vibe.mode}
        >
            {/* Canvas fills the whole component; all controls float over it. */}
            <div ref={containerRef} className="absolute inset-0 overflow-hidden">
                {mapReady && (
                    <>
                        <MapCanvas
                            tracks={tracks}
                            viewport={viewport}
                            width={dims.width}
                            height={dims.height}
                            mask={filters.mask}
                            positions={positions}
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
                            beacon={beaconPos}
                            trail={trailPoints}
                            decorations={
                                <MapDecorations
                                    viewport={viewport}
                                    trackById={trackById}
                                    posOf={posOf}
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
                                    onHaloPointerDown={handleHaloPointerDown}
                                    onHaloAddIngredient={vibe.addIngredient}
                                />
                            }
                        />
                    </>
                )}

                {/* Status overlays. */}
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
            </div>

            {/* Floating control surface. The wrapper is pointer-events-none so
                the map still pans in the empty gaps; each panel opts its own
                surface back in with pointer-events-auto. */}
            <div className="pointer-events-none absolute inset-0 z-30">
                {/* TOP-LEFT — now playing (the fullscreen "what's playing" fix). */}
                {currentTrack && (
                    <div className="absolute top-3 left-3">
                        <NowPlayingConnected
                            track={currentTrack}
                            onMapPresent={beaconOnMap}
                            moodColor={
                                beaconTrack
                                    ? getMoodColor(beaconTrack.dominantMood)
                                    : null
                            }
                            onFlyTo={locateNowPlaying}
                        />
                    </div>
                )}

                {/* TOP-CENTER — spotlight. */}
                <div className="absolute top-3 left-1/2 -translate-x-1/2">
                    <SpotlightSearch
                        onResults={(ids) => setHighlightIds(ids)}
                        onClear={() => setHighlightIds(null)}
                    />
                </div>

                {/* TOP-RIGHT — view controls. */}
                <div className="absolute top-3 right-3">
                    <ViewControls
                        onZoomIn={() => zoomByCenter(1.3)}
                        onZoomOut={() => zoomByCenter(1 / 1.3)}
                        onReset={resetView}
                        layoutMode={layoutMode}
                        layoutDisabled={tracks.length === 0}
                        onToggleLayout={toggleLayoutMode}
                        canLocate={beaconOnMap}
                        locateHint={
                            beaconOnMap
                                ? "Fly to now playing"
                                : currentTrack
                                  ? "Now playing isn't on the map"
                                  : "Nothing playing"
                        }
                        onLocate={locateNowPlaying}
                        canStartJourney={vibe.canStartJourney}
                        journeyHint={
                            vibe.canStartJourney
                                ? "Plan a journey from the current track"
                                : "Play a track (or pick one in Travel) to start a journey"
                        }
                        onStartJourney={vibe.startJourney}
                        isFullscreen={isFullscreen}
                        onToggleFullscreen={() => setIsFullscreen((v) => !v)}
                    />
                </div>

                {/* BOTTOM-LEFT — filters (self-positioning pill / card / sheet). */}
                <FiltersPanel
                    filters={filters}
                    total={tracks.length}
                    expanded={filtersOpen}
                    onExpandedChange={setFiltersExpanded}
                    reducedMotion={reducedMotion}
                    compact={isSmall}
                />
            </div>

            {/* Mode panels (right side / mobile bottom-sheet), above controls. */}
            {vibe.travel && <TravelPanel view={vibe.travel} />}
            {vibe.journey && <JourneyPanel view={vibe.journey} />}
            {vibe.alchemy && <AlchemyTray view={vibe.alchemy} />}

            {/* Hover tooltip (bottom-center, clear of the bottom-left filters). */}
            {hoveredTrack && (
                <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 z-40 max-w-[80%]">
                    <div className="bg-black/60 backdrop-blur-md border border-white/10 rounded-xl px-3 py-2 shadow-lg inline-flex items-center gap-2">
                        {hoveredTrack.coverUrl && (
                            <img
                                src={hoveredTrack.coverUrl}
                                alt=""
                                loading="lazy"
                                className="w-10 h-10 rounded object-cover flex-shrink-0"
                            />
                        )}
                        <div>
                            <div className="flex items-center gap-1.5">
                                <span
                                    className="w-2 h-2 rounded-full flex-shrink-0"
                                    style={{
                                        backgroundColor: getMoodColor(
                                            hoveredTrack.dominantMood
                                        ),
                                    }}
                                />
                                <p className="text-sm text-white font-medium">
                                    {hoveredTrack.title}
                                </p>
                            </div>
                            <p className="text-xs text-gray-400">
                                {hoveredTrack.artist}
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Fullscreen nicety — "Esc to exit" whisper, fades after ~2.5s. */}
            {isFullscreen && escHintVisible && (
                <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 z-40">
                    <div className="vibe-esc-hint px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-xs text-gray-300 shadow-lg">
                        Esc to exit
                    </div>
                    <style>{`
                        .vibe-esc-hint { animation: vibe-esc-fade 2.5s ease-out forwards; }
                        @keyframes vibe-esc-fade { 0%, 60% { opacity: 1; } 100% { opacity: 0; } }
                        @media (prefers-reduced-motion: reduce) { .vibe-esc-hint { animation: none; } }
                    `}</style>
                </div>
            )}
        </div>
    );
}
