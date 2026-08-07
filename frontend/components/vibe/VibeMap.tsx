"use client";

/**
 * VibeMap — thin container for the vibe map.
 *
 * Composition only: data load (raw useEffect + api.getVibeMap, the accepted
 * pattern) plus one focused hook per concern —
 *   useMapLayout    single source of positions (natural/spread + morph)
 *   useMapCamera    single camera owner (rAF loop, flights, accumulators)
 *   useMapGestures  pointer/wheel plumbing (pan, pinch, click-vs-drag, hover)
 *   useMapSweep     sweep-to-queue lifecycle (stroke, chip, actions)
 *   useMapFilters   non-destructive visibility mask
 *   useTrailDisplay session trail display mode + drawn tail + actions
 *   useAuxSurface   exclusive queue/trail/about slot
 *   useVibeMode     travel/journey/alchemy orchestration
 * and renders the canvas, overlay and floating control surface from their
 * outputs. The only logic living here is what genuinely spans those hooks:
 * the transform-aware hit test the gestures consume, the fly-to actions, the
 * travel auto-follow / journey framing camera effects, and the Esc priority
 * ladder.
 */

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useListenTogether } from "@/lib/listen-together-context";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { MapCanvas } from "./MapCanvas";
import { MapOverlay } from "./MapOverlay";
import { MapDecorations } from "./MapDecorations";
import { SpotlightSearch } from "./SpotlightSearch";
import { NowPlayingConnected } from "./NowPlayingConnected";
import { ViewControls } from "./ViewControls";
import { FiltersPanel } from "./FiltersPanel";
import { TravelPanel } from "./TravelPanel";
import { JourneyPanel } from "./JourneyPanel";
import { AlchemyTray } from "./AlchemyTray";
import { QueuePanel } from "./QueuePanel";
import { SweepChip } from "./SweepChip";
import { MapHintChip } from "./MapHintChip";
import { useMapFilters } from "./useMapFilters";
import {
    readStoredString,
    sessionStorageSafe,
    writeStoredString,
} from "./useSessionTrail";
import { useLatest } from "./useLatest";
import { useVibeMode } from "./useVibeMode";
import { useMapCamera } from "./useMapCamera";
import { useMapGestures } from "./useMapGestures";
import { useMapLayout } from "./useMapLayout";
import { useMapSweep } from "./useMapSweep";
import { useAuxSurface } from "./useAuxSurface";
import { useTrailDisplay } from "./useTrailDisplay";
import {
    computeDotRadius,
    fitBounds,
    fitViewport,
    flyTo,
    worldToScreen,
    type MapDims,
} from "./mapViewport";
import { upcomingOnMapPoints } from "./flightPlan";
import { SWEEP_BRUSH_RADIUS, SWEEP_CAP } from "./sweepCollect";
import { hintForMode, HINTS_DISMISSED_KEY } from "./mapHints";
import type { MapTrack } from "./types";
import { getMoodColor } from "./types";

const MIN_HOVER_HIT_RADIUS = 8; // px — floor for touch-friendly hit-testing
/** Travel auto-follow: recenter when the origin leaves the central band. */
const FOLLOW_EDGE_FRACTION = 0.2;
/**
 * Zoom level (× fit scale) a spotlight search pick flies to — a real
 * close-up on the picked song, vs. locate-now-playing's gentler 3×.
 */
const SEARCH_LOCATE_ZOOM = 8;

/**
 * How far (px) the mobile mini player intrudes into the map's bottom edge —
 * the page passes this as `bottomInset` when media is playing on
 * mobile/tablet so floating bottom UI stays clear of it.
 */
export const MOBILE_PLAYER_CLEARANCE_PX = 64;

const EMPTY_POINTS: { x: number; y: number; alpha: number }[] = [];

function readHintsDismissed(): boolean {
    return readStoredString(sessionStorageSafe(), HINTS_DISMISSED_KEY) === "1";
}

export interface VibeMapProps {
    /**
     * Floating chrome from the host page (e.g. the Explore/Map tab switcher),
     * rendered above the now-playing card in the top-left column. Hidden in
     * fullscreen. Must opt into pointer events itself (pointer-events-auto).
     */
    headerSlot?: ReactNode;
    /**
     * Extra bottom clearance in px for floating bottom UI (filters pill,
     * bottom sheets) — set when a fixed bar (the mobile mini player) overlaps
     * the map's bottom edge. Ignored in fullscreen, where the map covers the
     * player surfaces entirely.
     */
    bottomInset?: number;
}

/**
 * Canvas-based 2D navigator over the library's CLAP embedding projections.
 */
export function VibeMap({ headerSlot, bottomInset }: VibeMapProps = {}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [tracks, setTracks] = useState<MapTrack[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [dims, setDims] = useState<MapDims>({ width: 0, height: 0 });
    const [highlightIds, setHighlightIds] = useState<Set<string> | null>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [filtersExpanded, setFiltersExpanded] = useState(false);
    const [escHintVisible, setEscHintVisible] = useState(false);

    // Contextual hint whisper (dismissable per session).
    const [hintsDismissed, setHintsDismissed] = useState(readHintsDismissed);
    const dismissHints = useCallback(() => {
        setHintsDismissed(true);
        writeStoredString(sessionStorageSafe(), HINTS_DISMISSED_KEY, "1");
    }, []);

    const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
    const isSmall = useMediaQuery("(max-width: 639px)");
    const coarsePointer = useMediaQuery("(pointer: coarse)");

    // Note: useAudioState's value never changes on the 250ms playback clock
    // (that's useAudioPlayback, isolated in NowPlayingConnected) — queue and
    // currentIndex change on enqueue/advance only, which is exactly when the
    // flight plan must re-derive.
    const { currentTrack, queue, currentIndex } = useAudioState();
    const { playTrack, playTracks, addToQueue, moveQueueItem, removeFromQueue } =
        useAudioControls();
    const { isInGroup } = useListenTogether();

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

    // Library-calibrated match quantiles: fetched once on mount, same
    // accepted raw-useEffect+api pattern as the map load above. Failure (or
    // a too-small library, sampleSize 0) is silent — every consumer falls
    // back to the pre-calibration linear mapping via calibratedMatch.
    const [quantiles, setQuantiles] = useState<readonly number[] | null>(null);
    useEffect(() => {
        let cancelled = false;
        api.getVibeCalibration()
            .then((data) => {
                if (cancelled) return;
                setQuantiles(data.sampleSize > 0 ? data.quantiles : null);
            })
            .catch(() => {
                /* calibration is best-effort; the uncalibrated fallback still works */
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // --- Measure container ---------------------------------------------------
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

    // --- Composition: one hook per concern ----------------------------------
    const filters = useMapFilters(tracks);
    const { positions, layoutMode, toggleLayoutMode, posOf } = useMapLayout({
        tracks,
        reducedMotion,
    });
    const camera = useMapCamera({ dims, reducedMotion });
    const { viewport, viewportRef, animateCameraTo, zoomByCenter, resetView } =
        camera;
    // Ref mirror so camera effects (auto-follow, journey framing) can resolve
    // positions without re-running on every layout-animation frame.
    const posOfRef = useLatest(posOf);

    const trackById = useMemo(() => {
        const m = new Map<string, MapTrack>();
        for (const t of tracks) m.set(t.id, t);
        return m;
    }, [tracks]);

    const controls = useMemo(
        () => ({ playTrack, playTracks, addToQueue }),
        [playTrack, playTracks, addToQueue]
    );
    const vibe = useVibeMode({ trackById, currentTrack, controls, quantiles });

    const sweep = useMapSweep({
        tracks,
        positions,
        mask: filters.mask,
        viewportRef,
        trackById,
        controls,
    });

    const aux = useAuxSurface({
        mode: vibe.mode,
        sweepChipOpen: sweep.chipOpen,
    });

    const trail = useTrailDisplay({ posOf });

    // Shared hit-test (screen space, skipping filtered-out dots) used by
    // hover (pointermove), the touch click fallback (pointerup) and — with
    // `radiusScale` — the "was this click clearly on empty canvas?" check.
    // Reads the SAME `positions` buffer MapCanvas renders from, and the same
    // zoom-scaled radius it draws dots at (floored for touch-friendliness).
    const hitTest = useCallback(
        (clientX: number, clientY: number, radiusScale = 1): string | null => {
            if (!viewport) return null;
            const container = containerRef.current;
            if (!container) return null;
            const rect = container.getBoundingClientRect();
            const cx = clientX - rect.left;
            const cy = clientY - rect.top;
            const fitScale = fitViewport(dims).scale;
            const dotRadius = computeDotRadius(viewport.scale, fitScale);
            const hitRadius =
                Math.max(dotRadius, MIN_HOVER_HIT_RADIUS) * radiusScale;
            let closest: string | null = null;
            let closestDist = hitRadius;
            const mask = filters.mask;
            // Scalar transform, inlined from mapViewport's worldToScreen (screen
            // = world * scale + t), matching MapCanvas's draw loop: this runs
            // for up to ~15,000 dots per pointermove, so it deliberately
            // allocates nothing per dot — no world-point object, no
            // worldToScreen result object, just local numbers.
            const scale = viewport.scale;
            const tx = viewport.tx;
            const ty = viewport.ty;
            for (let i = 0; i < tracks.length; i++) {
                if (mask[i] === 0) continue;
                const sx = positions[i * 2] * scale + tx;
                const sy = positions[i * 2 + 1] * scale + ty;
                const dx = cx - sx;
                const dy = cy - sy;
                const dist = Math.hypot(dx, dy);
                if (dist < closestDist) {
                    closest = tracks[i].id;
                    closestDist = dist;
                }
            }
            return closest;
        },
        [viewport, tracks, filters.mask, dims, positions]
    );

    // A clean click on a dot dismisses an open sweep chip and routes to the
    // mode machine; a clearly-empty click dismisses the chip first, then
    // dissolves travel (the chip owns the first Esc/click-away, same as the
    // Esc priority ladder below).
    const onTap = useCallback(
        (id: string, mods: { ctrlOrMeta: boolean; shift: boolean }) => {
            sweep.dismissResult();
            vibe.onDotClick(id, mods);
        },
        [sweep, vibe]
    );
    const onEmptyTap = useCallback(() => {
        if (sweep.chipOpen) sweep.dismissResult();
        else vibe.onEmptyClick();
    }, [sweep, vibe]);

    const gestures = useMapGestures({
        containerRef,
        camera,
        hitTest,
        sweep,
        onTap,
        onEmptyTap,
    });
    const { hoveredId } = gestures;

    // --- Fly-to actions ------------------------------------------------------
    const beaconTrack = currentTrack ? trackById.get(currentTrack.id) : undefined;
    const beaconOnMap = !!beaconTrack;
    const beaconPos = currentTrack ? posOf(currentTrack.id) : null;

    const locateNowPlaying = useCallback(() => {
        const vp = viewportRef.current;
        if (!vp || !beaconTrack || !currentTrack) return;
        const pos = posOfRef.current(currentTrack.id);
        if (!pos) return;
        const targetScale = Math.max(vp.scale, fitViewport(dims).scale * 3);
        animateCameraTo(flyTo(vp, pos, targetScale, dims), 600);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- posOfRef/viewportRef come from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this callback is not re-created every render.
    }, [beaconTrack, currentTrack, dims, animateCameraTo]);

    // Spotlight local-search pick: fly INTO the matched dot and glow it as a
    // single-id highlight. Unlike locateNowPlaying (an orientation nudge that
    // never zooms past 3× fit), search is a "take me to this song" action —
    // it always lands at a close-up (8× fit) so the picked dot and its
    // immediate neighborhood fill the view, keeping a deeper zoom if the user
    // is already in tighter than that.
    const locateTrack = useCallback(
        (id: string) => {
            const vp = viewportRef.current;
            if (!vp) return;
            const pos = posOfRef.current(id);
            if (!pos) return;
            const targetScale = Math.max(
                vp.scale,
                fitViewport(dims).scale * SEARCH_LOCATE_ZOOM
            );
            animateCameraTo(flyTo(vp, pos, targetScale, dims), 600);
            setHighlightIds(new Set([id]));
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- posOfRef/viewportRef come from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this callback is not re-created every render.
        [dims, animateCameraTo]
    );

    // Travel auto-follow: when the origin hops (click a neighbour / dot), keep
    // it comfortably in view — recenter with a short flight only when it left
    // the central band, and never while the user's hands are on the map.
    const travelOriginId = vibe.travel?.currentId ?? null;
    const dimsRef = useLatest(dims);
    const isGestureActiveRef = useLatest(gestures.isGestureActive);
    useEffect(() => {
        if (!travelOriginId) return;
        if (isGestureActiveRef.current()) return;
        const vp = viewportRef.current;
        const d = dimsRef.current;
        if (!vp || d.width <= 0) return;
        const pos = posOfRef.current(travelOriginId);
        if (!pos) return;
        const s = worldToScreen(vp, pos);
        const mx = d.width * FOLLOW_EDGE_FRACTION;
        const my = d.height * FOLLOW_EDGE_FRACTION;
        const inside =
            s.x >= mx && s.x <= d.width - mx && s.y >= my && s.y <= d.height - my;
        if (!inside) animateCameraTo(flyTo(vp, pos, vp.scale, d), 450);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dimsRef/posOfRef/viewportRef/isGestureActiveRef come from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this effect does not re-run every render.
    }, [travelOriginId, animateCameraTo]);

    // Journey framing: when a route lands, fly to fit its on-map waypoints
    // (plus the origin) once per distinct route.
    const journeyWaypoints = vibe.journey?.waypoints;
    const journeyFromId = vibe.journey?.fromId ?? null;
    const framedRouteRef = useRef<string | null>(null);
    useEffect(() => {
        if (!journeyWaypoints || journeyWaypoints.length === 0) {
            framedRouteRef.current = null;
            return;
        }
        const sig =
            journeyFromId + ":" + journeyWaypoints.map((w) => w.id).join(",");
        if (framedRouteRef.current === sig) return;
        framedRouteRef.current = sig;

        const pts: { x: number; y: number }[] = [];
        if (journeyFromId) {
            const p = posOfRef.current(journeyFromId);
            if (p) pts.push(p);
        }
        for (const w of journeyWaypoints) {
            if (!w.onMap) continue;
            const p = posOfRef.current(w.id);
            if (p) pts.push(p);
        }
        if (pts.length < 2) return;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const p of pts) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        const d = dimsRef.current;
        if (d.width <= 0) return;
        animateCameraTo(fitBounds({ minX, minY, maxX, maxY }, d), 600);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dimsRef/posOfRef come from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this effect does not re-run every render.
    }, [journeyWaypoints, journeyFromId, animateCameraTo]);

    // --- Esc priority + fullscreen hint --------------------------------------
    const vibeMode = vibe.mode;
    const exitToExplore = vibe.exitToExplore;
    const sweepChipOpen = sweep.chipOpen;
    const dismissSweepResult = sweep.dismissResult;
    const { auxSurface, auxOpen, toggleAuxSurface, closeAux } = aux;

    // Esc priority: (1) spotlight-input clearing swallows the event itself
    // (SpotlightSearch's own onKeyDown + stopPropagation, unchanged); (2) an
    // open sweep chip dismisses; (3) an open aux surface (queue/trail/about)
    // closes; (4) an active mode (travel/journey/alchemy) exits to explore;
    // (5) only then does Esc close fullscreen.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            if (sweepChipOpen) {
                dismissSweepResult();
            } else if (auxSurface !== null) {
                closeAux();
            } else if (vibeMode !== "explore") {
                exitToExplore();
            } else if (isFullscreen) {
                setIsFullscreen(false);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [
        sweepChipOpen,
        dismissSweepResult,
        auxSurface,
        closeAux,
        vibeMode,
        exitToExplore,
        isFullscreen,
    ]);

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

    // --- Derived render state ------------------------------------------------
    // Flight plan: where the queue goes next (`?? []` also guards test mocks
    // that don't model the queue fields).
    const planPoints = useMemo(
        () => upcomingOnMapPoints(queue ?? [], currentIndex ?? -1, posOf),
        [queue, currentIndex, posOf]
    );

    // Sweep glow wins the canvas highlight while a stroke is live or its chip
    // is open (no dimming — the sweep is additive, not a filter); alchemy's
    // result glow is next; the spotlight owns it otherwise.
    const effectiveHighlightIds =
        sweep.highlight ?? vibe.highlightIds ?? highlightIds;
    const effectiveDim = sweep.highlight
        ? false
        : vibe.highlightIds !== null || highlightIds !== null;

    const hoveredTrack = hoveredId ? trackById.get(hoveredId) : undefined;
    const mapReady = viewport !== null && dims.width > 0 && dims.height > 0;
    // A mode panel (travel/journey/alchemy) takes over the right side / bottom
    // sheet; auto-collapse the filters so they can't collide with it. The
    // intentional route/constellation also replaces the ambient session trail
    // while a mode is active — two overlapping line systems read as leftovers.
    const modePanelOpen = vibe.mode !== "explore";
    const filtersOpen = filtersExpanded && !modePanelOpen;
    // Queue panel visibility: an open aux surface takes over the same
    // right-side slot the mode panels use — the mode panel's JSX hides while
    // one is open (vibe state itself is untouched), and the sweep chip claims
    // the same bottom-center slot; see useAuxSurface for the close semantics.
    const queuePanelVisible = auxSurface === "queue" && !sweepChipOpen;
    const shownTrail = vibe.mode === "explore" ? trail.trailPoints : EMPTY_POINTS;
    // The plan hides with the trail while a mode's own route/constellation is
    // up — two overlapping line systems on one dot read as leftovers.
    const shownPlan = vibe.mode === "explore" ? planPoints : EMPTY_POINTS;

    // Dot-anchored hover tooltip (fine pointers only — touch never hovers):
    // sits beside the hovered dot instead of a bottom-center slot, so the eye
    // never leaves the cursor. Flips to the left near the right edge.
    let hoverTip: ReactNode = null;
    if (hoveredTrack && !coarsePointer && viewport) {
        const wp = posOf(hoveredTrack.id);
        if (wp) {
            const s = worldToScreen(viewport, wp);
            const flipX = s.x > dims.width - 280;
            hoverTip = (
                <div
                    className="pointer-events-none absolute z-40 -translate-y-1/2"
                    style={{
                        left: flipX ? undefined : s.x + 16,
                        right: flipX ? dims.width - s.x + 16 : undefined,
                        top: Math.min(Math.max(s.y, 44), dims.height - 44),
                    }}
                >
                    <div className="bg-black/60 backdrop-blur-md border border-white/10 rounded-xl px-3 py-2 shadow-lg inline-flex items-center gap-2 max-w-[260px]">
                        {hoveredTrack.coverUrl && (
                            <img
                                src={hoveredTrack.coverUrl}
                                alt=""
                                loading="lazy"
                                className="w-10 h-10 rounded object-cover flex-shrink-0"
                            />
                        )}
                        <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                                <span
                                    className="w-2 h-2 rounded-full flex-shrink-0"
                                    style={{
                                        backgroundColor: getMoodColor(
                                            hoveredTrack.dominantMood
                                        ),
                                    }}
                                />
                                <p className="text-sm text-white font-medium truncate">
                                    {hoveredTrack.title}
                                </p>
                            </div>
                            <p className="text-xs text-gray-400 truncate">
                                {hoveredTrack.artist}
                            </p>
                        </div>
                    </div>
                </div>
            );
        }
    }

    return (
        <div
            className={
                isFullscreen
                    ? // Above FullPlayer's z-[10000] seek strip / z-[10001] menus
                      // (which sit above the OverlayPlayer at z-[9999]) so the
                      // player bar can't bleed through the fullscreen map;
                      // still under the Toaster (z 10020) so playback feedback
                      // stays visible.
                      "fixed inset-0 z-[10005] bg-[#0a0a0a] overflow-hidden"
                    : "relative w-full h-full overflow-hidden"
            }
            style={
                {
                    // Bottom clearance for floating UI when a fixed bar (the
                    // mobile mini player) overlaps the map's bottom edge. In
                    // fullscreen the map covers the player, so no inset.
                    "--vibe-binset": `${isFullscreen ? 0 : bottomInset ?? 0}px`,
                } as React.CSSProperties
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
                            onPointerDown={gestures.handlePointerDown}
                            onPointerMove={gestures.handlePointerMove}
                            onPointerUp={gestures.handlePointerUp}
                            onPointerCancel={gestures.handlePointerCancel}
                            onPointerLeave={gestures.endDrag}
                        />
                        <MapOverlay
                            viewport={viewport}
                            width={dims.width}
                            height={dims.height}
                            beacon={beaconPos}
                            trail={shownTrail}
                            plan={shownPlan}
                            decorations={
                                <MapDecorations
                                    viewport={viewport}
                                    posOf={posOf}
                                    quantiles={quantiles}
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
                                    onHaloPointerDown={
                                        gestures.handleHaloPointerDown
                                    }
                                    onHaloAddIngredient={vibe.addIngredient}
                                />
                            }
                            sweepStroke={
                                sweep.live && sweep.live.stroke.length >= 2 ? (
                                    <>
                                        {/* Brush-width ghost + thin core line. */}
                                        <polyline
                                            points={sweep.live.stroke
                                                .map((p) => `${p.x},${p.y}`)
                                                .join(" ")}
                                            fill="none"
                                            stroke="#818cf8"
                                            strokeWidth={SWEEP_BRUSH_RADIUS * 2}
                                            strokeOpacity={0.1}
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        />
                                        <polyline
                                            points={sweep.live.stroke
                                                .map((p) => `${p.x},${p.y}`)
                                                .join(" ")}
                                            fill="none"
                                            stroke="#a5b4fc"
                                            strokeWidth={1.5}
                                            strokeOpacity={0.7}
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        />
                                    </>
                                ) : null
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
                {/* TOP-LEFT — host chrome (tab switcher) + now playing. */}
                <div className="absolute top-3 left-3 flex flex-col items-start gap-2">
                    {!isFullscreen && headerSlot}
                    {currentTrack && (
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
                    )}
                </div>

                {/* TOP-CENTER — spotlight. */}
                <div className="absolute top-3 left-1/2 -translate-x-1/2">
                    <SpotlightSearch
                        tracks={tracks}
                        onLocate={locateTrack}
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
                        brushArmed={sweep.brushArmed}
                        onToggleBrush={sweep.toggleBrush}
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
                                : vibe.mode === "alchemy"
                                  ? "Close alchemy (Esc) first"
                                  : "Play a track (or pick one in Travel) to start a journey"
                        }
                        onStartJourney={vibe.startJourney}
                        queueOpen={auxSurface === "queue"}
                        onToggleQueue={() => toggleAuxSurface("queue")}
                        queueCount={Math.max(
                            0,
                            (queue?.length ?? 0) - (currentIndex ?? -1) - 1
                        )}
                        trailMode={trail.trailMode}
                        onSetTrailMode={trail.setTrailMode}
                        trailPopoverOpen={auxSurface === "trail"}
                        onToggleTrailPopover={() => toggleAuxSurface("trail")}
                        trailEmpty={trail.trailIds.length === 0}
                        onClearTrail={trail.clearTrail}
                        onSaveTrail={trail.saveTrail}
                        trailSaving={trail.trailSaving}
                        aboutPopoverOpen={auxSurface === "about"}
                        onToggleAboutPopover={() => toggleAuxSurface("about")}
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

            {/* Mode panels (right side / mobile bottom-sheet), above controls.
                Yield visually (not torn down — vibe state, incl. the travel
                constellation on the map, survives) while an aux surface
                (queue/trail/about) is open. */}
            {vibe.travel && !auxOpen && <TravelPanel view={vibe.travel} />}
            {vibe.journey && !auxOpen && <JourneyPanel view={vibe.journey} />}
            {vibe.alchemy && !auxOpen && <AlchemyTray view={vibe.alchemy} />}

            {/* Queue panel — same slot as the mode panels; genuinely CLOSED
                (auxSurface set back to null, see useAuxSurface) rather than
                merely hidden while a mode/sweep chip is showing, so it never
                ghosts back open on its own. */}
            {queuePanelVisible && (
                <QueuePanel
                    queue={queue ?? []}
                    currentIndex={currentIndex ?? -1}
                    onClose={closeAux}
                    onReorder={moveQueueItem}
                    onRemove={removeFromQueue}
                    reorderDisabled={isInGroup}
                />
            )}

            {/* Sweep action chip — Play / Queue / Save the collected stroke. */}
            {sweep.result && (
                <SweepChip
                    count={sweep.result.ids.length}
                    capped={sweep.result.ids.length >= SWEEP_CAP}
                    onPlay={sweep.play}
                    onQueue={sweep.queue}
                    onSave={sweep.save}
                    saving={sweep.saving}
                    onDismiss={sweep.dismissResult}
                />
            )}

            {/* Contextual hint whisper — hidden whenever anything else owns
                bottom-center (sweep chip, fullscreen Esc hint, a small-screen
                mode sheet) or while the map is still loading/empty. */}
            {!hintsDismissed &&
                !sweep.result &&
                !sweep.live &&
                !escHintVisible &&
                !(isSmall && modePanelOpen) &&
                !isLoading &&
                tracks.length > 0 && (
                    <MapHintChip
                        text={hintForMode(vibe.mode, {
                            picking: vibe.journey?.picking,
                            sweepArmed: sweep.brushArmed,
                        })}
                        onDismiss={dismissHints}
                    />
                )}

            {/* Dot-anchored hover tooltip (mouse/trackpad only). */}
            {hoverTip}

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
