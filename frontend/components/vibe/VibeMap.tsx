"use client";

/**
 * VibeMap — thin container for the vibe map.
 *
 * Wires: data load (raw useEffect + api.getVibeMap, the accepted pattern),
 * viewport state (mapViewport math), non-destructive filters (useMapFilters),
 * now-playing beacon + session trail (MapOverlay / useSessionTrail), the
 * spotlight lens (SpotlightSearch), and the natural/spread layout toggle
 * (mapLayout). Interaction (wheel zoom, drag pan, pinch, click-vs-drag
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
 *
 * SINGLE CAMERA OWNER: every viewport write goes through one rAF loop.
 * Continuous inputs (wheel zoom, drag pan, pinch) accumulate into pending
 * refs and are flushed at most once per frame; programmatic moves (locate,
 * reset, zoom buttons, travel auto-follow, journey framing) run as a
 * cancellable eased flight via `animateCameraTo`. Any direct input cancels an
 * in-flight animation, so the camera never fights the user's hands. The wheel
 * listener is attached natively with `{ passive: false }` — React's synthetic
 * onWheel is passive, which made preventDefault a silent no-op (page scroll +
 * ctrl-wheel browser zoom underneath the map zoom).
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
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useListenTogether } from "@/lib/listen-together-context";
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
import { QueuePanel } from "./QueuePanel";
import { useMapFilters } from "./useMapFilters";
import {
    fadeAlphaForAge,
    readStoredString,
    readStoredTrailMode,
    sessionStorageSafe,
    useSessionTrail,
    writeStoredString,
    writeStoredTrailMode,
    type TrailMode,
} from "./useSessionTrail";
import { useLatest } from "./useLatest";
import { useVibeMode } from "./useVibeMode";
import {
    computeDotRadius,
    fitBounds,
    fitViewport,
    flyTo,
    interpolateViewport,
    worldToScreen,
    zoomAt,
    clampViewport,
    type MapDims,
    type Viewport,
} from "./mapViewport";
import { buildPositions, computeSpreadPositions, lerpPositions } from "./mapLayout";
import { upcomingOnMapPoints } from "./flightPlan";
import {
    collectHits,
    sampleSegment,
    SWEEP_BRUSH_RADIUS,
    SWEEP_CAP,
    type SweepPoint,
} from "./sweepCollect";
import { SweepChip } from "./SweepChip";
import { MapHintChip } from "./MapHintChip";
import { hintForMode, HINTS_DISMISSED_KEY } from "./mapHints";
import { mapTrackToTrack } from "./journeyTracks";
import { formatPlaylistDate, saveTracksAsPlaylist } from "./savePlaylist";
import { toast } from "sonner";
import type { MapTrack } from "./types";
import { getMoodColor } from "./types";

const CLICK_MOVE_THRESHOLD = 4; // px between down/up to still count as a click
const MIN_HOVER_HIT_RADIUS = 8; // px — floor for touch-friendly hit-testing
/** A click this far (× hit radius) from every dot counts as "empty canvas". */
const EMPTY_CLICK_FORGIVENESS = 2;
/** Session-trail segments drawn (recent only — 50 stored points is spaghetti). */
const TRAIL_DRAW_LIMIT = 12;
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

type LayoutMode = "natural" | "spread";
const LAYOUT_STORAGE_KEY = "vibe:layout-mode";
const LAYOUT_ANIM_MS = 400;
/** Recompute "fade" trail-mode opacity on this cadence while mounted. */
const TRAIL_FADE_RECOMPUTE_MS = 60_000;

const EMPTY_TRAIL: { x: number; y: number; alpha: number }[] = [];

function easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function readStoredLayoutMode(): LayoutMode {
    return readStoredString(sessionStorageSafe(), LAYOUT_STORAGE_KEY) === "spread"
        ? "spread"
        : "natural";
}

function readHintsDismissed(): boolean {
    return readStoredString(sessionStorageSafe(), HINTS_DISMISSED_KEY) === "1";
}

interface DragState {
    active: boolean;
    lastX: number;
    lastY: number;
    moved: number;
}

interface CameraFlight {
    from: Viewport;
    to: Viewport;
    start: number;
    dur: number;
}

/** Live sweep-gesture scratchpad (refs only — state carries render copies). */
interface SweepScratch {
    seen: Set<string>;
    ids: string[];
    stroke: SweepPoint[];
    last: SweepPoint;
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
    const { isPlaying, currentTime, duration } = useAudioPlayback();
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
            currentTime={currentTime}
            duration={duration}
        />
    );
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
    const [viewport, setViewport] = useState<Viewport | null>(null);
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const [highlightIds, setHighlightIds] = useState<Set<string> | null>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [filtersExpanded, setFiltersExpanded] = useState(false);
    const [queuePanelOpen, setQueuePanelOpen] = useState(false);
    const [escHintVisible, setEscHintVisible] = useState(false);
    const drag = useRef<DragState>({ active: false, lastX: 0, lastY: 0, moved: 0 });

    // Sweep-to-queue: shift+drag (mouse) or the armed brush (touch) collects
    // visible dots along the stroke in first-touch order.
    const [brushArmed, setBrushArmed] = useState(false);
    const sweepRef = useRef<SweepScratch | null>(null);
    const [sweepLive, setSweepLive] = useState<{
        stroke: SweepPoint[];
        ids: string[];
    } | null>(null);
    const [sweepResult, setSweepResult] = useState<{ ids: string[] } | null>(
        null
    );

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
    const filters = useMapFilters(tracks);
    const { trailIds, entries: trailEntries, clear: clearTrail } = useSessionTrail();

    // Trail display mode (on / fade / off), persisted across the session.
    const [trailMode, setTrailModeState] = useState<TrailMode>(() =>
        readStoredTrailMode(sessionStorageSafe())
    );
    const setTrailMode = useCallback((mode: TrailMode) => {
        setTrailModeState(mode);
        writeStoredTrailMode(sessionStorageSafe(), mode);
    }, []);
    const [trailPopoverOpen, setTrailPopoverOpen] = useState(false);
    const toggleTrailPopover = useCallback(
        () => setTrailPopoverOpen((v) => !v),
        []
    );
    const handleClearTrail = useCallback(() => {
        clearTrail();
        toast.success("Trail cleared");
    }, [clearTrail]);

    // Save the full stored trail (all entries, oldest -> newest — not just the
    // drawn tail, which is capped at TRAIL_DRAW_LIMIT for legibility) as a
    // playlist.
    const [trailSaving, setTrailSaving] = useState(false);
    const saveTrail = useCallback(async () => {
        if (trailIds.length === 0) return;
        setTrailSaving(true);
        try {
            const name = `Vibe history — ${formatPlaylistDate()}`;
            const result = await saveTracksAsPlaylist(name, trailIds);
            toast.success(`Saved ${result.added} tracks to ${name}`);
        } catch {
            toast.error("Couldn't save that playlist");
        } finally {
            setTrailSaving(false);
        }
    }, [trailIds]);

    // "Fade" mode ages trail entries out over time even when nothing else
    // changes — recompute periodically while it's the active mode (and the
    // map is mounted) so a segment keeps fading instead of only updating on
    // the next track change.
    const [trailFadeTick, setTrailFadeTick] = useState(0);
    useEffect(() => {
        if (trailMode !== "fade") return;
        const id = setInterval(
            () => setTrailFadeTick((t) => t + 1),
            TRAIL_FADE_RECOMPUTE_MS
        );
        return () => clearInterval(id);
    }, [trailMode]);

    // --- Layout (natural vs spread) — single source of positions -----------
    const naturalPositions = useMemo(() => buildPositions(tracks), [tracks]);
    const spreadPositions = useMemo(() => computeSpreadPositions(tracks), [tracks]);

    const [layoutMode, setLayoutMode] = useState<LayoutMode>(readStoredLayoutMode);
    const layoutModeRef = useLatest(layoutMode);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- layoutModeRef comes from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this effect only re-snaps on a track-list/positions change, not a layout toggle.
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
        writeStoredString(sessionStorageSafe(), LAYOUT_STORAGE_KEY, next);

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
    // Ref mirror so camera effects (auto-follow, journey framing) can resolve
    // positions without re-running on every layout-animation frame.
    const posOfRef = useLatest(posOf);

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

    // --- Camera: single rAF owner for every viewport write ------------------
    const viewportRef = useLatest(viewport);
    const dimsRef = useLatest(dims);
    const reducedMotionRef = useLatest(reducedMotion);

    const panPendingRef = useRef({ dx: 0, dy: 0 });
    const zoomPendingRef = useRef<{ cx: number; cy: number; logf: number } | null>(
        null
    );
    const cameraAnimRef = useRef<CameraFlight | null>(null);
    const cameraRafRef = useRef<number | null>(null);

    const cameraTick = useCallback(function tick(now: number) {
        cameraRafRef.current = null;
        const d = dimsRef.current;
        let vp = viewportRef.current;
        if (!vp || d.width <= 0 || d.height <= 0) return;

        let dirty = false;
        const zoom = zoomPendingRef.current;
        if (zoom) {
            vp = zoomAt(vp, { x: zoom.cx, y: zoom.cy }, Math.exp(zoom.logf), d);
            zoomPendingRef.current = null;
            dirty = true;
        }
        const pan = panPendingRef.current;
        if (pan.dx !== 0 || pan.dy !== 0) {
            vp = clampViewport(
                { scale: vp.scale, tx: vp.tx + pan.dx, ty: vp.ty + pan.dy },
                d
            );
            panPendingRef.current = { dx: 0, dy: 0 };
            dirty = true;
        }
        const anim = cameraAnimRef.current;
        if (!dirty && anim) {
            const t = Math.min(1, (now - anim.start) / anim.dur);
            vp = interpolateViewport(anim.from, anim.to, easeInOutCubic(t), d);
            if (t >= 1) {
                cameraAnimRef.current = null;
            } else {
                cameraRafRef.current = requestAnimationFrame(tick);
            }
            dirty = true;
        }
        if (dirty) {
            viewportRef.current = vp;
            setViewport(vp);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dimsRef/viewportRef come from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this camera rAF tick does not re-subscribe.
    }, []);

    const scheduleCamera = useCallback(() => {
        if (cameraRafRef.current == null) {
            cameraRafRef.current = requestAnimationFrame(cameraTick);
        }
    }, [cameraTick]);

    useEffect(() => {
        return () => {
            if (cameraRafRef.current != null) {
                cancelAnimationFrame(cameraRafRef.current);
            }
        };
    }, []);

    /** Eased flight to `target` (clamped). Reduced motion → snap. */
    const animateCameraTo = useCallback(
        (target: Viewport, dur = 500) => {
            const d = dimsRef.current;
            const from = viewportRef.current;
            if (!from || d.width <= 0) return;
            const to = clampViewport(target, d);
            if (reducedMotionRef.current || dur <= 0) {
                cameraAnimRef.current = null;
                viewportRef.current = to;
                setViewport(to);
                return;
            }
            cameraAnimRef.current = {
                from,
                to,
                start: performance.now(),
                dur,
            };
            scheduleCamera();
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- dimsRef/reducedMotionRef/viewportRef come from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this callback is not re-created every render.
        [scheduleCamera]
    );

    // Native non-passive wheel listener: React attaches wheel passively, so a
    // synthetic onWheel can't preventDefault — the page would scroll and
    // ctrl-wheel would browser-zoom underneath the map. Deltas accumulate in
    // log space and flush once per frame through the camera tick.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            cameraAnimRef.current = null;
            const rect = el.getBoundingClientRect();
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 120 : 1;
            const prev = zoomPendingRef.current;
            zoomPendingRef.current = {
                cx: e.clientX - rect.left,
                cy: e.clientY - rect.top,
                logf: (prev?.logf ?? 0) + -e.deltaY * unit * 0.0015,
            };
            scheduleCamera();
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [scheduleCamera]);

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
    const vibe = useVibeMode({ trackById, currentTrack, controls, quantiles });

    const beaconTrack = currentTrack ? trackById.get(currentTrack.id) : undefined;
    const beaconOnMap = !!beaconTrack;
    const beaconPos = currentTrack ? posOf(currentTrack.id) : null;

    const trailPoints = useMemo(() => {
        if (trailMode === "off") return EMPTY_TRAIL;
        const now = Date.now();
        const pts: { x: number; y: number; alpha: number }[] = [];
        for (const entry of trailEntries.slice(-TRAIL_DRAW_LIMIT)) {
            const p = posOf(entry.trackId);
            if (!p) continue;
            const alpha =
                trailMode === "fade" ? fadeAlphaForAge(now - entry.at) : 1;
            if (alpha <= 0) continue; // fully aged out — drop from the drawn set
            pts.push({ x: p.x, y: p.y, alpha });
        }
        return pts;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trailFadeTick is intentionally unused in the body: it exists purely to force this memo to recompute every 60s while "fade" mode ages trail entries out.
    }, [trailEntries, posOf, trailMode, trailFadeTick]);

    // Flight plan: where the queue goes next (`?? []` also guards test mocks
    // that don't model the queue fields).
    const planPoints = useMemo(
        () => upcomingOnMapPoints(queue ?? [], currentIndex ?? -1, posOf),
        [queue, currentIndex, posOf]
    );

    // Sweep glow wins the canvas highlight while a stroke is live or its chip
    // is open (no dimming — the sweep is additive, not a filter); alchemy's
    // result glow is next; the spotlight owns it otherwise.
    const sweepIds = sweepLive?.ids ?? sweepResult?.ids ?? null;
    const sweepHighlight = useMemo(
        () => (sweepIds && sweepIds.length > 0 ? new Set(sweepIds) : null),
        [sweepIds]
    );
    const effectiveHighlightIds =
        sweepHighlight ?? vibe.highlightIds ?? highlightIds;
    const effectiveDim = sweepHighlight
        ? false
        : vibe.highlightIds !== null || highlightIds !== null;

    // --- Interaction --------------------------------------------------------
    const cursorFromEvent = useCallback((clientX: number, clientY: number) => {
        const container = containerRef.current;
        if (!container) return { x: 0, y: 0 };
        const rect = container.getBoundingClientRect();
        return { x: clientX - rect.left, y: clientY - rect.top };
    }, []);

    // Pinch state: every active canvas pointer is tracked by id; two or more
    // switches to pinch (zoom about the midpoint + pan by its drift) and
    // poisons the click threshold for the whole gesture.
    const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
    const pinchRef = useRef<{ dist: number; mid: { x: number; y: number } } | null>(
        null
    );

    // Collect visible dots around one brush sample into the live sweep.
    const sweepCollectAt = useCallback(
        (scratch: SweepScratch, cursor: SweepPoint) => {
            const vp = viewportRef.current;
            if (!vp) return;
            collectHits({
                cursor,
                ids: tracks,
                positions,
                mask: filters.mask,
                viewport: vp,
                seen: scratch.seen,
                out: scratch.ids,
            });
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- viewportRef comes from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this callback is not re-created every render.
        [tracks, positions, filters.mask]
    );

    const handlePointerDown = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>) => {
            cameraAnimRef.current = null;
            activePointersRef.current.set(e.pointerId, {
                x: e.clientX,
                y: e.clientY,
            });
            if (activePointersRef.current.size === 2) {
                // A second finger always means pinch — discard a live sweep.
                sweepRef.current = null;
                setSweepLive(null);
                const [p1, p2] = [...activePointersRef.current.values()];
                pinchRef.current = {
                    dist: Math.hypot(p2.x - p1.x, p2.y - p1.y),
                    mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
                };
                drag.current.active = false;
                drag.current.moved = Number.POSITIVE_INFINITY; // never a click
            } else if (activePointersRef.current.size === 1) {
                drag.current = {
                    active: true,
                    lastX: e.clientX,
                    lastY: e.clientY,
                    moved: 0,
                };
                if (brushArmed || e.shiftKey) {
                    // Arm a sweep. The drag state still tracks `moved`, so a
                    // stationary shift-click falls through to normal click
                    // semantics (e.g. travel's shift-click-to-queue) on
                    // pointerup instead of producing an empty sweep.
                    const cursor = cursorFromEvent(e.clientX, e.clientY);
                    const scratch: SweepScratch = {
                        seen: new Set(),
                        ids: [],
                        stroke: [cursor],
                        last: cursor,
                    };
                    sweepCollectAt(scratch, cursor);
                    sweepRef.current = scratch;
                    setSweepLive({
                        stroke: [...scratch.stroke],
                        ids: [...scratch.ids],
                    });
                    setSweepResult(null);
                }
            }
            e.currentTarget.setPointerCapture?.(e.pointerId);
        },
        [brushArmed, cursorFromEvent, sweepCollectAt]
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

    // Shared hit-test (screen space, skipping filtered-out dots) used by
    // hover (pointermove), the touch click fallback (pointerup) and — with
    // `radiusScale` — the "was this click clearly on empty canvas?" check.
    // Reads the SAME `positions` buffer MapCanvas renders from, and the same
    // zoom-scaled radius it draws dots at (floored for touch-friendliness).
    const hitTest = useCallback(
        (clientX: number, clientY: number, radiusScale = 1): string | null => {
            if (!viewport) return null;
            const cursor = cursorFromEvent(clientX, clientY);
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
                const dx = cursor.x - sx;
                const dy = cursor.y - sy;
                const dist = Math.hypot(dx, dy);
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
            if (!viewportRef.current) return;

            const tracked = activePointersRef.current.get(e.pointerId);
            if (tracked) {
                tracked.x = e.clientX;
                tracked.y = e.clientY;
            }

            // Two-finger pinch: zoom about the midpoint, pan by its drift.
            // Deltas accumulate and flush on the camera tick like all input.
            if (pinchRef.current && activePointersRef.current.size >= 2) {
                const [p1, p2] = [...activePointersRef.current.values()];
                const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
                const prev = pinchRef.current;
                if (prev.dist > 0 && dist > 0) {
                    const cursor = cursorFromEvent(mid.x, mid.y);
                    const zp = zoomPendingRef.current;
                    zoomPendingRef.current = {
                        cx: cursor.x,
                        cy: cursor.y,
                        logf: (zp?.logf ?? 0) + Math.log(dist / prev.dist),
                    };
                    panPendingRef.current.dx += mid.x - prev.mid.x;
                    panPendingRef.current.dy += mid.y - prev.mid.y;
                    scheduleCamera();
                }
                pinchRef.current = { dist, mid };
                return;
            }

            // Live sweep: the stroke collects instead of panning. Sampling
            // between the previous and current point keeps a fast flick from
            // skipping over dots.
            const scratch = sweepRef.current;
            if (scratch && drag.current.active) {
                const d = drag.current;
                const dx = e.clientX - d.lastX;
                const dy = e.clientY - d.lastY;
                d.lastX = e.clientX;
                d.lastY = e.clientY;
                d.moved += Math.hypot(dx, dy);
                const cursor = cursorFromEvent(e.clientX, e.clientY);
                for (const pt of sampleSegment(scratch.last, cursor)) {
                    sweepCollectAt(scratch, pt);
                }
                scratch.last = cursor;
                scratch.stroke.push(cursor);
                setSweepLive({
                    stroke: [...scratch.stroke],
                    ids: [...scratch.ids],
                });
                return;
            }

            const d = drag.current;
            if (d.active) {
                // Self-heal a drag armed by a halo pointerdown whose matching
                // pointerup landed on the halo itself (stationary tap — the
                // halo has no pointerup wiring back to this canvas): once no
                // mouse button is actually down, stop treating hover as a pan.
                // Mouse-only: touch contacts report buttons in ways that must
                // not cancel a live pinch/pan.
                if (e.pointerType === "mouse" && e.buttons === 0) {
                    d.active = false;
                } else {
                    const dx = e.clientX - d.lastX;
                    const dy = e.clientY - d.lastY;
                    d.lastX = e.clientX;
                    d.lastY = e.clientY;
                    d.moved += Math.hypot(dx, dy);
                    panPendingRef.current.dx += dx;
                    panPendingRef.current.dy += dy;
                    scheduleCamera();
                    return;
                }
            }

            setHoveredId(hitTest(e.clientX, e.clientY));
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- viewportRef comes from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this callback is not re-created every render.
        [cursorFromEvent, scheduleCamera, hitTest, sweepCollectAt]
    );

    const endDrag = useCallback(() => {
        drag.current.active = false;
        setHoveredId(null);
    }, []);

    /** Shared up/cancel bookkeeping; returns true when this was a clean click. */
    const releasePointer = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>): boolean => {
            activePointersRef.current.delete(e.pointerId);
            const wasClick =
                drag.current.active && drag.current.moved < CLICK_MOVE_THRESHOLD;
            drag.current.active = false;
            if (activePointersRef.current.size < 2) pinchRef.current = null;
            // Hand the pan to a remaining finger (still never a click).
            const rest = activePointersRef.current.values().next().value;
            if (rest) {
                drag.current = {
                    active: true,
                    lastX: rest.x,
                    lastY: rest.y,
                    moved: Number.POSITIVE_INFINITY,
                };
            }
            e.currentTarget.releasePointerCapture?.(e.pointerId);
            return wasClick;
        },
        []
    );

    const handlePointerUp = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>) => {
            const wasClick = releasePointer(e);

            // A live sweep ends here: a real stroke with catches freezes into
            // the action chip; a stationary tap falls through to click
            // semantics; an empty stroke just dissolves.
            const scratch = sweepRef.current;
            if (scratch) {
                sweepRef.current = null;
                setSweepLive(null);
                if (!wasClick) {
                    if (scratch.ids.length > 0) {
                        setSweepResult({ ids: [...scratch.ids] });
                    }
                    return;
                }
            }

            if (!wasClick) return;
            // Touch taps never set hoveredId (no hover concept on touch, and
            // pointermove during the tap takes the drag branch above), so
            // fall back to hit-testing at the pointerup coordinates.
            const clickedId = hoveredId ?? hitTest(e.clientX, e.clientY);
            if (clickedId) {
                setSweepResult(null);
                vibe.onDotClick(clickedId, {
                    ctrlOrMeta: e.ctrlKey || e.metaKey,
                    shift: e.shiftKey,
                });
            } else if (
                !hitTest(e.clientX, e.clientY, EMPTY_CLICK_FORGIVENESS)
            ) {
                // Clearly-empty canvas (nothing even within 2× the hit radius
                // — a near-miss on a small dot must not nuke a travel
                // session): dismiss the sweep chip if one is open, else
                // dissolve the travel constellation.
                if (sweepResult) setSweepResult(null);
                else vibe.onEmptyClick();
            }
        },
        [releasePointer, hoveredId, hitTest, vibe, sweepResult]
    );

    const handlePointerCancel = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>) => {
            releasePointer(e);
            sweepRef.current = null;
            setSweepLive(null);
        },
        [releasePointer]
    );

    // Sweep chip actions. Queueing is silent per track + one summary toast —
    // N per-track toasts would bury the screen.
    const sweepTracks = useCallback(
        (ids: readonly string[]) => {
            const list: MapTrack[] = [];
            for (const id of ids) {
                const t = trackById.get(id);
                if (t) list.push(t);
            }
            return list;
        },
        [trackById]
    );

    const playSweep = useCallback(() => {
        if (!sweepResult) return;
        const list = sweepTracks(sweepResult.ids).map(mapTrackToTrack);
        if (list.length > 0) playTracks(list, 0, true);
        setSweepResult(null);
    }, [sweepResult, sweepTracks, playTracks]);

    const queueSweep = useCallback(() => {
        if (!sweepResult) return;
        const list = sweepTracks(sweepResult.ids);
        for (const t of list) addToQueue(mapTrackToTrack(t), { silent: true });
        if (list.length > 0) {
            toast.success(
                `Queued ${list.length} swept track${list.length === 1 ? "" : "s"}`
            );
        }
        setSweepResult(null);
    }, [sweepResult, sweepTracks, addToQueue]);

    const [sweepSaving, setSweepSaving] = useState(false);
    const saveSweep = useCallback(async () => {
        if (!sweepResult) return;
        const ids = sweepResult.ids;
        if (ids.length === 0) {
            setSweepResult(null);
            return;
        }
        setSweepSaving(true);
        try {
            const name = `Vibe sweep — ${formatPlaylistDate()}`;
            const result = await saveTracksAsPlaylist(name, ids);
            toast.success(`Saved ${result.added} tracks to ${name}`);
        } catch {
            toast.error("Couldn't save that playlist");
        } finally {
            setSweepSaving(false);
            setSweepResult(null);
        }
    }, [sweepResult]);

    const zoomByCenter = useCallback(
        (factor: number) => {
            const vp = viewportRef.current;
            const d = dimsRef.current;
            if (!vp) return;
            animateCameraTo(
                zoomAt(vp, { x: d.width / 2, y: d.height / 2 }, factor, d),
                220
            );
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- dimsRef/viewportRef come from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this callback is not re-created every render.
        [animateCameraTo]
    );

    const resetView = useCallback(() => {
        const d = dimsRef.current;
        if (d.width > 0) animateCameraTo(fitViewport(d), 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dimsRef comes from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this callback is not re-created every render.
    }, [animateCameraTo]);

    const locateNowPlaying = useCallback(() => {
        const vp = viewportRef.current;
        const d = dimsRef.current;
        if (!vp || !beaconTrack || !currentTrack) return;
        const pos = posOf(currentTrack.id);
        if (!pos) return;
        const targetScale = Math.max(vp.scale, fitViewport(d).scale * 3);
        animateCameraTo(flyTo(vp, pos, targetScale, d), 600);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dimsRef/viewportRef come from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this callback is not re-created every render.
    }, [beaconTrack, currentTrack, posOf, animateCameraTo]);

    // Spotlight local-search pick: fly INTO the matched dot and glow it as a
    // single-id highlight. Unlike locateNowPlaying (an orientation nudge that
    // never zooms past 3× fit), search is a "take me to this song" action —
    // it always lands at a close-up (8× fit) so the picked dot and its
    // immediate neighborhood fill the view, keeping a deeper zoom if the user
    // is already in tighter than that.
    const locateTrack = useCallback(
        (id: string) => {
            const vp = viewportRef.current;
            const d = dimsRef.current;
            if (!vp) return;
            const pos = posOf(id);
            if (!pos) return;
            const targetScale = Math.max(
                vp.scale,
                fitViewport(d).scale * SEARCH_LOCATE_ZOOM
            );
            animateCameraTo(flyTo(vp, pos, targetScale, d), 600);
            setHighlightIds(new Set([id]));
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- dimsRef/viewportRef come from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this callback is not re-created every render.
        [posOf, animateCameraTo]
    );

    // Travel auto-follow: when the origin hops (click a neighbour / dot), keep
    // it comfortably in view — recenter with a short flight only when it left
    // the central band, and never while the user's hands are on the map.
    const travelOriginId = vibe.travel?.currentId ?? null;
    useEffect(() => {
        if (!travelOriginId) return;
        if (drag.current.active || pinchRef.current) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dimsRef/posOfRef/viewportRef come from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this effect does not re-run every render.
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

    // Esc priority: (1) spotlight-input clearing swallows the event itself
    // (SpotlightSearch's own onKeyDown + stopPropagation, unchanged); (2) an
    // open sweep chip dismisses; (3) an open queue panel closes; (4) an active
    // mode (travel/journey/alchemy) exits to explore; (5) only then does Esc
    // close fullscreen.
    const vibeMode = vibe.mode;
    const exitToExplore = vibe.exitToExplore;
    const sweepChipOpen = sweepResult !== null;
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            if (sweepChipOpen) {
                setSweepResult(null);
            } else if (queuePanelOpen && vibeMode === "explore") {
                setQueuePanelOpen(false);
            } else if (vibeMode !== "explore") {
                exitToExplore();
            } else if (isFullscreen) {
                setIsFullscreen(false);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [sweepChipOpen, queuePanelOpen, vibeMode, exitToExplore, isFullscreen]);

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
    // sheet; auto-collapse the filters so they can't collide with it. The
    // intentional route/constellation also replaces the ambient session trail
    // while a mode is active — two overlapping line systems read as leftovers.
    const modePanelOpen = vibe.mode !== "explore";
    const filtersOpen = filtersExpanded && !modePanelOpen;
    // Same auto-hide as filters, plus a guard against the sweep chip: both
    // the panel's mobile bottom-sheet and the chip anchor bottom-center, so
    // showing both at once would collide.
    const queuePanelVisible = queuePanelOpen && !modePanelOpen && !sweepChipOpen;
    const shownTrail = vibe.mode === "explore" ? trailPoints : EMPTY_TRAIL;
    // The plan hides with the trail while a mode's own route/constellation is
    // up — two overlapping line systems on one dot read as leftovers.
    const shownPlan = vibe.mode === "explore" ? planPoints : EMPTY_TRAIL;

    // Dot-anchored hover tooltip (fine pointers only — touch never hovers):
    // sits beside the hovered dot instead of the old bottom-center slot, so
    // the eye never leaves the cursor. Flips to the left near the right edge.
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
                            onPointerDown={handlePointerDown}
                            onPointerMove={handlePointerMove}
                            onPointerUp={handlePointerUp}
                            onPointerCancel={handlePointerCancel}
                            onPointerLeave={endDrag}
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
                                    onHaloPointerDown={handleHaloPointerDown}
                                    onHaloAddIngredient={vibe.addIngredient}
                                />
                            }
                            sweepStroke={
                                sweepLive && sweepLive.stroke.length >= 2 ? (
                                    <>
                                        {/* Brush-width ghost + thin core line. */}
                                        <polyline
                                            points={sweepLive.stroke
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
                                            points={sweepLive.stroke
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
                        brushArmed={brushArmed}
                        onToggleBrush={() => setBrushArmed((v) => !v)}
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
                        queueOpen={queuePanelOpen}
                        onToggleQueue={() => setQueuePanelOpen((v) => !v)}
                        queueCount={Math.max(
                            0,
                            (queue?.length ?? 0) - (currentIndex ?? -1) - 1
                        )}
                        trailMode={trailMode}
                        onSetTrailMode={setTrailMode}
                        trailPopoverOpen={trailPopoverOpen}
                        onToggleTrailPopover={toggleTrailPopover}
                        trailEmpty={trailIds.length === 0}
                        onClearTrail={handleClearTrail}
                        onSaveTrail={saveTrail}
                        trailSaving={trailSaving}
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

            {/* Queue panel — same slot as the mode panels; auto-hides while
                one of them is open or the sweep chip is showing. */}
            {queuePanelVisible && (
                <QueuePanel
                    queue={queue ?? []}
                    currentIndex={currentIndex ?? -1}
                    onClose={() => setQueuePanelOpen(false)}
                    onReorder={moveQueueItem}
                    onRemove={removeFromQueue}
                    reorderDisabled={isInGroup}
                />
            )}

            {/* Sweep action chip — Play / Queue the collected stroke. */}
            {sweepResult && (
                <SweepChip
                    count={sweepResult.ids.length}
                    capped={sweepResult.ids.length >= SWEEP_CAP}
                    onPlay={playSweep}
                    onQueue={queueSweep}
                    onSave={saveSweep}
                    saving={sweepSaving}
                    onDismiss={() => setSweepResult(null)}
                />
            )}

            {/* Contextual hint whisper — hidden whenever anything else owns
                bottom-center (sweep chip, fullscreen Esc hint, a small-screen
                mode sheet) or while the map is still loading/empty. */}
            {!hintsDismissed &&
                !sweepResult &&
                !sweepLive &&
                !escHintVisible &&
                !(isSmall && modePanelOpen) &&
                !isLoading &&
                tracks.length > 0 && (
                    <MapHintChip
                        text={hintForMode(vibe.mode, {
                            picking: vibe.journey?.picking,
                            sweepArmed: brushArmed,
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
