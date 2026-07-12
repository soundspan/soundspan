"use client";

/**
 * useVibeMode — the F2 interaction state machine for the vibe map.
 *
 * Owns the exclusive mode (explore | travel | journey | alchemy), the per-mode
 * selection state, and the async data (similar neighbours, journey route, blend
 * results) the map decorations + panels render. VibeMap stays a thin container:
 * it feeds this hook the map index + now-playing + audio controls and renders
 * whichever `travel` / `journey` / `alchemy` view is non-null.
 *
 * Mode exclusivity is enforced in one place: switching `state.mode` tears down
 * the other modes' async overlay state (see the teardown effect). Esc / close
 * always returns to explore.
 */

import {
    useCallback,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from "react";
import { api } from "@/lib/api";
import type { Track } from "@/lib/audio-state-context";
import type { MapTrack } from "./types";
import {
    compassNeighbors,
    enrichFromMap,
    DEFAULT_COMPASS_COUNT,
    type CompassCandidate,
    type CompassDirection,
} from "./travelCompass";
import {
    annotateOnMap,
    journeyTracks,
    mapTrackToTrack,
    waypointToTrack,
    type WithOnMap,
} from "./journeyTracks";

export type VibeMode = "explore" | "travel" | "journey" | "alchemy";

export const MAX_ALCHEMY_INGREDIENTS = 10;
const SIMILAR_LIMIT = 24;
const DRIFT_STEPS = 12;
export const MIN_JOURNEY_STEPS = 4;
export const MAX_JOURNEY_STEPS = 16;
const DEFAULT_JOURNEY_STEPS = 8;
export const MIN_WEIGHT = 0.1;
export const MAX_WEIGHT = 2;
const DEFAULT_WEIGHT = 1;

interface Ingredient {
    id: string;
    weight: number;
}

type ModeState =
    | { mode: "explore" }
    | {
          mode: "travel";
          currentId: string;
          breadcrumb: string[];
          direction: CompassDirection;
      }
    | {
          mode: "journey";
          fromId: string;
          picking: boolean;
          destTrackId: string | null;
          moodTarget: string | null;
          steps: number;
      }
    | { mode: "alchemy"; ingredients: Ingredient[] };

type Action =
    | { type: "RESET" }
    | { type: "ENTER_TRAVEL"; id: string }
    | { type: "TRAVEL_TO"; id: string }
    | { type: "SET_DIRECTION"; direction: CompassDirection }
    | { type: "ENTER_JOURNEY"; fromId: string }
    | { type: "TOGGLE_PICK" }
    | { type: "SET_DEST"; id: string }
    | { type: "SET_MOOD_TARGET"; mood: string | null }
    | { type: "SET_STEPS"; steps: number }
    | { type: "ADD_ALCHEMY"; id: string }
    | { type: "REMOVE_ALCHEMY"; id: string }
    | { type: "SET_WEIGHT"; id: string; weight: number };

const clampSteps = (n: number): number =>
    Math.min(MAX_JOURNEY_STEPS, Math.max(MIN_JOURNEY_STEPS, Math.round(n)));
const clampWeight = (n: number): number =>
    Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, n));

function reducer(state: ModeState, action: Action): ModeState {
    switch (action.type) {
        case "RESET":
            return { mode: "explore" };

        case "ENTER_TRAVEL":
            return {
                mode: "travel",
                currentId: action.id,
                breadcrumb: [action.id],
                direction: "any",
            };
        case "TRAVEL_TO": {
            if (state.mode !== "travel") return state;
            if (state.currentId === action.id) return state;
            return {
                ...state,
                currentId: action.id,
                breadcrumb:
                    state.breadcrumb[state.breadcrumb.length - 1] === action.id
                        ? state.breadcrumb
                        : [...state.breadcrumb, action.id],
            };
        }
        case "SET_DIRECTION":
            if (state.mode !== "travel") return state;
            return { ...state, direction: action.direction };

        case "ENTER_JOURNEY":
            return {
                mode: "journey",
                fromId: action.fromId,
                picking: false,
                destTrackId: null,
                moodTarget: null,
                steps: DEFAULT_JOURNEY_STEPS,
            };
        case "TOGGLE_PICK":
            if (state.mode !== "journey") return state;
            return { ...state, picking: !state.picking };
        case "SET_DEST":
            if (state.mode !== "journey") return state;
            return {
                ...state,
                destTrackId: action.id,
                moodTarget: null,
                picking: false,
            };
        case "SET_MOOD_TARGET":
            if (state.mode !== "journey") return state;
            return { ...state, moodTarget: action.mood, destTrackId: null };
        case "SET_STEPS":
            if (state.mode !== "journey") return state;
            return { ...state, steps: clampSteps(action.steps) };

        case "ADD_ALCHEMY": {
            const prev = state.mode === "alchemy" ? state.ingredients : [];
            if (prev.some((i) => i.id === action.id)) return state;
            if (prev.length >= MAX_ALCHEMY_INGREDIENTS)
                return state.mode === "alchemy"
                    ? state
                    : { mode: "alchemy", ingredients: prev };
            return {
                mode: "alchemy",
                ingredients: [...prev, { id: action.id, weight: DEFAULT_WEIGHT }],
            };
        }
        case "REMOVE_ALCHEMY": {
            if (state.mode !== "alchemy") return state;
            const next = state.ingredients.filter((i) => i.id !== action.id);
            if (next.length === 0) return { mode: "explore" };
            return { mode: "alchemy", ingredients: next };
        }
        case "SET_WEIGHT":
            if (state.mode !== "alchemy") return state;
            return {
                mode: "alchemy",
                ingredients: state.ingredients.map((i) =>
                    i.id === action.id
                        ? { ...i, weight: clampWeight(action.weight) }
                        : i
                ),
            };
        default:
            return state;
    }
}

/** A `/vibe` list item ({id,title,album,artist}) tagged with map presence. */
export type VibeListItem = WithOnMap<{
    id: string;
    title: string;
    album: { id: string; title: string; coverUrl: string | null };
    artist: { id: string; name: string };
    similarity: number;
}> & { seq: number };

export interface TravelView {
    currentId: string;
    currentTitle: string;
    breadcrumbTitles: Array<{ id: string; title: string }>;
    direction: CompassDirection;
    onMapNeighbors: CompassCandidate[];
    offMapNeighbors: CompassCandidate[];
    loading: boolean;
    error: string | null;
    setDirection: (d: CompassDirection) => void;
    navigate: (id: string) => void;
    queue: (id: string) => void;
    close: () => void;
}

export interface JourneyMoodOption {
    mood: string;
    trackCount: number;
}

export interface JourneyView {
    fromId: string;
    fromLabel: string;
    picking: boolean;
    destTrackId: string | null;
    destLabel: string | null;
    moodTarget: string | null;
    steps: number;
    moods: JourneyMoodOption[];
    targetLabel: string | null;
    waypoints: VibeListItem[];
    loading: boolean;
    error: string | null;
    canSubmit: boolean;
    togglePick: () => void;
    chooseMood: (mood: string) => void;
    setSteps: (n: number) => void;
    submit: () => void;
    drift: (mood: string) => void;
    play: () => void;
    close: () => void;
}

export interface AlchemyIngredientView {
    id: string;
    title: string;
    artist: string;
    weight: number;
    onMap: boolean;
}

export interface AlchemyView {
    ingredients: AlchemyIngredientView[];
    results: VibeListItem[];
    loading: boolean;
    error: string | null;
    canBlend: boolean;
    remove: (id: string) => void;
    setWeight: (id: string, w: number) => void;
    blend: () => void;
    play: () => void;
    clear: () => void;
}

interface JourneyTargetResult {
    trackId?: string;
    mood?: string;
    title?: string;
    label?: string;
}

interface VibeResultRow {
    id: string;
    title: string;
    distance: number;
    similarity: number;
    album: { id: string; title: string; coverUrl: string | null };
    artist: { id: string; name: string };
}

interface JourneyRoute {
    mode: "track" | "mood";
    target: JourneyTargetResult;
    waypoints: VibeResultRow[];
}

function journeyErrorMessage(e: unknown): string {
    const msg = e instanceof Error ? e.message : "";
    if (/no embedding/i.test(msg)) return "This track has no embedding yet";
    if (/enough embedded tracks/i.test(msg))
        return "Not enough analyzed tracks for this mood";
    return msg || "Couldn't build that journey";
}

export interface UseVibeModeArgs {
    trackById: ReadonlyMap<string, MapTrack>;
    currentTrack: Track | null;
    controls: {
        playTrack: (track: Track) => void;
        playTracks: (
            tracks: Track[],
            startIndex?: number,
            isVibeQueue?: boolean
        ) => void;
        addToQueue: (track: Track, options?: { silent?: boolean }) => void;
    };
}

export interface UseVibeMode {
    mode: VibeMode;
    onDotClick: (
        id: string,
        mods: { ctrlOrMeta: boolean; shift: boolean }
    ) => void;
    /** A click on clearly-empty canvas: dissolves travel; other modes ignore it. */
    onEmptyClick: () => void;
    exitToExplore: () => void;
    canStartJourney: boolean;
    startJourney: () => void;
    /** Alchemy result ids to glow on the canvas (else null → spotlight owns it). */
    highlightIds: ReadonlySet<string> | null;
    /** Add a track to the alchemy tray (ctrl/⌘-click anywhere, incl. halos). */
    addIngredient: (id: string) => void;
    travel: TravelView | null;
    journey: JourneyView | null;
    alchemy: AlchemyView | null;
}

export function useVibeMode({
    trackById,
    currentTrack,
    controls,
}: UseVibeModeArgs): UseVibeMode {
    const [state, dispatch] = useReducer(reducer, { mode: "explore" });

    // --- async overlay state ------------------------------------------------
    // Neighbours are tagged with the origin they were fetched for, and every
    // consumer derives [] unless the tag matches the CURRENT travel origin.
    // This is what kills the "strings stay behind" bug: navigating to a new
    // node instantly hides the old node's constellation (no frame ever draws
    // edges from the new origin to the old origin's neighbours), without any
    // clear-before-fetch effect-ordering games.
    const [rawNeighbors, setRawNeighbors] = useState<{
        originId: string;
        list: CompassCandidate[];
    } | null>(null);
    const [travelLoading, setTravelLoading] = useState(false);
    const [travelError, setTravelError] = useState<string | null>(null);

    const [route, setRoute] = useState<JourneyRoute | null>(null);
    const [journeyLoading, setJourneyLoading] = useState(false);
    const [journeyError, setJourneyError] = useState<string | null>(null);
    const [moods, setMoods] = useState<JourneyMoodOption[]>([]);

    const [blend, setBlend] = useState<VibeResultRow[] | null>(null);
    const [alchemyLoading, setAlchemyLoading] = useState(false);
    const [alchemyError, setAlchemyError] = useState<string | null>(null);

    const clearJourneyResults = useCallback(() => {
        setRoute(null);
        setJourneyError(null);
    }, []);
    const clearAlchemyResults = useCallback(() => {
        setBlend(null);
        setAlchemyError(null);
    }, []);

    // Generation counters for the journey/blend async fetches: bumped on every
    // new request AND on mode teardown, so a stale response (e.g. Esc + re-enter
    // before the in-flight request lands) can't apply its result. Same shape as
    // the `cancelled` flag used for the travel-neighbours fetch below, just
    // shared across the whole mode lifetime rather than one effect run.
    const journeyGen = useRef(0);
    const alchemyGen = useRef(0);

    // Mode exclusivity: leaving a mode drops its overlay state.
    const activeMode = state.mode;
    useEffect(() => {
        if (activeMode !== "travel") {
            setRawNeighbors(null);
            setTravelError(null);
        }
        if (activeMode !== "journey") {
            clearJourneyResults();
            journeyGen.current++;
        }
        if (activeMode !== "alchemy") {
            clearAlchemyResults();
            alchemyGen.current++;
        }
    }, [activeMode, clearJourneyResults, clearAlchemyResults]);

    // --- travel: fetch similar for the current node -------------------------
    const travelCurrentId = state.mode === "travel" ? state.currentId : null;
    useEffect(() => {
        if (!travelCurrentId) return;
        let cancelled = false;
        setTravelLoading(true);
        setTravelError(null);
        api.getVibeSimilarTracks(travelCurrentId, SIMILAR_LIMIT)
            .then((res) => {
                if (cancelled) return;
                setRawNeighbors({
                    originId: travelCurrentId,
                    list: res.tracks.map((t) => ({
                        id: t.id,
                        title: t.title,
                        album: t.album,
                        artist: t.artist,
                        // client type omits similarity; derive from cosine distance.
                        similarity: Math.max(0, 1 - t.distance / 2),
                        energy: t.audioFeatures?.energy ?? null,
                        valence: t.audioFeatures?.valence ?? null,
                        moods: null,
                    })),
                });
            })
            .catch(() => {
                if (!cancelled) setTravelError("Couldn't load nearby vibes");
            })
            .finally(() => {
                if (!cancelled) setTravelLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [travelCurrentId]);

    // --- journey: load mood anchors once on entry ---------------------------
    const inJourney = state.mode === "journey";
    useEffect(() => {
        if (!inJourney || moods.length > 0) return;
        let cancelled = false;
        api.getVibeMoods()
            .then((m) => {
                if (!cancelled) setMoods(m);
            })
            .catch(() => {
                /* moods list is best-effort; pick-on-map still works */
            });
        return () => {
            cancelled = true;
        };
    }, [inJourney, moods.length]);

    // --- derived: travel neighbours ----------------------------------------
    const enrichedNeighbors = useMemo(() => {
        if (!rawNeighbors || rawNeighbors.originId !== travelCurrentId) return [];
        return enrichFromMap(rawNeighbors.list, trackById);
    }, [rawNeighbors, travelCurrentId, trackById]);
    const travelOrigin =
        travelCurrentId != null ? trackById.get(travelCurrentId) : undefined;
    const shownNeighbors = useMemo(() => {
        if (!travelOrigin || state.mode !== "travel") return [];
        return compassNeighbors(
            travelOrigin,
            enrichedNeighbors,
            state.direction,
            DEFAULT_COMPASS_COUNT
        );
    }, [travelOrigin, enrichedNeighbors, state]);

    const onMapNeighbors = useMemo(
        () => shownNeighbors.filter((n) => trackById.has(n.id)),
        [shownNeighbors, trackById]
    );
    const offMapNeighbors = useMemo(
        () => shownNeighbors.filter((n) => !trackById.has(n.id)),
        [shownNeighbors, trackById]
    );

    // --- derived: journey waypoints / alchemy results -----------------------
    const waypointItems: VibeListItem[] = useMemo(
        () => annotateOnMap(route?.waypoints ?? [], trackById),
        [route, trackById]
    );

    const resultItems: VibeListItem[] = useMemo(
        () => annotateOnMap(blend ?? [], trackById),
        [blend, trackById]
    );

    const resultIds = useMemo(
        () => new Set((blend ?? []).map((t) => t.id)),
        [blend]
    );

    // --- actions ------------------------------------------------------------
    const exitToExplore = useCallback(() => dispatch({ type: "RESET" }), []);

    // Click-away: clicking clearly-empty canvas dissolves a travel
    // constellation (the map idiom for "deselect"). Journey and alchemy keep
    // their form state — an accidental empty click must never clear a
    // half-built route or ingredient tray; those exit via Esc / ✕ only.
    const inTravel = state.mode === "travel";
    const onEmptyClick = useCallback(() => {
        if (inTravel) dispatch({ type: "RESET" });
    }, [inTravel]);

    const addIngredient = useCallback(
        (id: string) => {
            dispatch({ type: "ADD_ALCHEMY", id });
            clearAlchemyResults();
        },
        [clearAlchemyResults]
    );

    // Lookup by id over the full (on-map + off-map) shown neighbours, so
    // navigate/queue can build a playable Track from the candidate payload
    // itself even when the neighbour isn't plotted on this map sample.
    const shownNeighborById = useMemo(() => {
        const m = new Map<string, CompassCandidate>();
        for (const n of shownNeighbors) m.set(n.id, n);
        return m;
    }, [shownNeighbors]);

    const navigateTravel = useCallback(
        (id: string) => {
            const candidate = shownNeighborById.get(id);
            if (candidate) controls.playTrack(waypointToTrack(candidate));
            // Only move `currentId` (and trigger the neighbours refetch) when the
            // target is actually on the map — off-map neighbours play/queue but
            // never become the new travel origin.
            if (trackById.has(id)) dispatch({ type: "TRAVEL_TO", id });
        },
        [shownNeighborById, trackById, controls]
    );

    const queueTravel = useCallback(
        (id: string) => {
            const candidate = shownNeighborById.get(id);
            if (candidate) controls.addToQueue(waypointToTrack(candidate));
        },
        [shownNeighborById, controls]
    );

    const onDotClick = useCallback(
        (id: string, mods: { ctrlOrMeta: boolean; shift: boolean }) => {
            const t = trackById.get(id);
            if (!t) return;
            // Journey "pick on map" intercepts the next dot for the destination.
            // Picking the journey's own origin is a no-op (the backend rejects
            // from === to; catch it here so the map doesn't even round-trip).
            if (state.mode === "journey" && state.picking) {
                if (id !== state.fromId) {
                    dispatch({ type: "SET_DEST", id });
                    clearJourneyResults();
                }
                return;
            }
            if (mods.ctrlOrMeta) {
                addIngredient(id);
                return;
            }
            switch (state.mode) {
                case "explore":
                    dispatch({ type: "ENTER_TRAVEL", id });
                    controls.playTrack(mapTrackToTrack(t));
                    break;
                case "travel":
                    if (mods.shift) controls.addToQueue(mapTrackToTrack(t));
                    else {
                        dispatch({ type: "TRAVEL_TO", id });
                        controls.playTrack(mapTrackToTrack(t));
                    }
                    break;
                case "alchemy":
                    addIngredient(id);
                    break;
                case "journey":
                    // plain click while not picking: no-op
                    break;
            }
        },
        [state, trackById, controls, addIngredient, clearJourneyResults]
    );

    const currentTrackId = currentTrack?.id ?? null;
    const travelCurrentForJourney =
        state.mode === "travel" ? state.currentId : null;
    const canStartJourney = !!(travelCurrentForJourney || currentTrackId);
    const startJourney = useCallback(() => {
        const fromId = travelCurrentForJourney ?? currentTrackId;
        if (!fromId) return;
        dispatch({ type: "ENTER_JOURNEY", fromId });
    }, [travelCurrentForJourney, currentTrackId]);

    const runJourney = useCallback(
        async (
            fromId: string,
            toTrackId: string | undefined,
            mood: string | undefined,
            steps: number
        ) => {
            const gen = ++journeyGen.current;
            setJourneyLoading(true);
            setJourneyError(null);
            setRoute(null);
            try {
                const res = await api.getVibeJourney({
                    fromTrackId: fromId,
                    toTrackId,
                    mood,
                    steps,
                });
                if (gen !== journeyGen.current) return; // superseded — drop it
                setRoute(res as JourneyRoute);
            } catch (e) {
                if (gen === journeyGen.current) setJourneyError(journeyErrorMessage(e));
            } finally {
                if (gen === journeyGen.current) setJourneyLoading(false);
            }
        },
        []
    );

    const submitJourney = useCallback(() => {
        if (state.mode !== "journey") return;
        const { fromId, destTrackId, moodTarget, steps } = state;
        if (!destTrackId && !moodTarget) return;
        void runJourney(
            fromId,
            destTrackId ?? undefined,
            moodTarget ?? undefined,
            steps
        );
    }, [state, runJourney]);

    const drift = useCallback(
        (mood: string) => {
            if (state.mode !== "journey") return;
            dispatch({ type: "SET_MOOD_TARGET", mood });
            dispatch({ type: "SET_STEPS", steps: DRIFT_STEPS });
            void runJourney(state.fromId, undefined, mood, DRIFT_STEPS);
        },
        [state, runJourney]
    );

    const journeyFromTrack = useCallback(
        (fromId: string): Track | null => {
            const m = trackById.get(fromId);
            if (m) return mapTrackToTrack(m);
            if (currentTrack && currentTrack.id === fromId) return currentTrack;
            return null;
        },
        [trackById, currentTrack]
    );

    const playJourney = useCallback(() => {
        if (state.mode !== "journey" || !route) return;
        const queue = journeyTracks(
            journeyFromTrack(state.fromId),
            route.waypoints
        );
        if (queue.length) controls.playTracks(queue, 0, true);
    }, [state, route, journeyFromTrack, controls]);

    const runBlend = useCallback(() => {
        if (state.mode !== "alchemy" || state.ingredients.length < 2) return;
        const ings = state.ingredients;
        const gen = ++alchemyGen.current;
        setAlchemyLoading(true);
        setAlchemyError(null);
        setBlend(null);
        api.vibeAlchemy(
            ings.map((i) => i.id),
            ings.map((i) => i.weight),
            20
        )
            .then((res) => {
                if (gen === alchemyGen.current) setBlend(res.tracks);
            })
            .catch(() => {
                if (gen === alchemyGen.current)
                    setAlchemyError("Couldn't blend those tracks");
            })
            .finally(() => {
                if (gen === alchemyGen.current) setAlchemyLoading(false);
            });
    }, [state]);

    const playBlend = useCallback(() => {
        if (!blend || blend.length === 0) return;
        controls.playTracks(blend.map(waypointToTrack), 0, true);
    }, [blend, controls]);

    // --- views --------------------------------------------------------------
    const titleOf = useCallback(
        (id: string | null): string => {
            if (!id) return "";
            return (
                trackById.get(id)?.title ??
                (currentTrack?.id === id ? currentTrack.title : id)
            );
        },
        [trackById, currentTrack]
    );

    const travel: TravelView | null =
        state.mode === "travel"
            ? {
                  currentId: state.currentId,
                  currentTitle: titleOf(state.currentId),
                  breadcrumbTitles: state.breadcrumb.map((id) => ({
                      id,
                      title: titleOf(id),
                  })),
                  direction: state.direction,
                  onMapNeighbors,
                  offMapNeighbors,
                  loading: travelLoading,
                  error: travelError,
                  setDirection: (d) =>
                      dispatch({ type: "SET_DIRECTION", direction: d }),
                  navigate: navigateTravel,
                  queue: queueTravel,
                  close: exitToExplore,
              }
            : null;

    const journey: JourneyView | null =
        state.mode === "journey"
            ? {
                  fromId: state.fromId,
                  fromLabel: titleOf(state.fromId),
                  picking: state.picking,
                  destTrackId: state.destTrackId,
                  destLabel: state.destTrackId
                      ? titleOf(state.destTrackId)
                      : null,
                  moodTarget: state.moodTarget,
                  steps: state.steps,
                  moods,
                  targetLabel:
                      route?.target?.label ?? route?.target?.title ?? null,
                  waypoints: waypointItems,
                  loading: journeyLoading,
                  error: journeyError,
                  canSubmit: !!(state.destTrackId || state.moodTarget),
                  togglePick: () => dispatch({ type: "TOGGLE_PICK" }),
                  chooseMood: (mood) =>
                      dispatch({ type: "SET_MOOD_TARGET", mood }),
                  setSteps: (n) => dispatch({ type: "SET_STEPS", steps: n }),
                  submit: submitJourney,
                  drift,
                  play: playJourney,
                  close: exitToExplore,
              }
            : null;

    const alchemy: AlchemyView | null =
        state.mode === "alchemy"
            ? {
                  ingredients: state.ingredients.map((i) => {
                      const t = trackById.get(i.id);
                      return {
                          id: i.id,
                          title: t?.title ?? i.id,
                          artist: t?.artist ?? "",
                          weight: i.weight,
                          onMap: !!t,
                      };
                  }),
                  results: resultItems,
                  loading: alchemyLoading,
                  error: alchemyError,
                  canBlend: state.ingredients.length >= 2,
                  remove: (id) => {
                      dispatch({ type: "REMOVE_ALCHEMY", id });
                      clearAlchemyResults();
                  },
                  setWeight: (id, w) => {
                      dispatch({ type: "SET_WEIGHT", id, weight: w });
                      clearAlchemyResults();
                  },
                  blend: runBlend,
                  play: playBlend,
                  clear: exitToExplore,
              }
            : null;

    return {
        mode: state.mode,
        onDotClick,
        onEmptyClick,
        exitToExplore,
        canStartJourney,
        startJourney,
        highlightIds:
            state.mode === "alchemy" && resultIds.size > 0 ? resultIds : null,
        addIngredient,
        travel,
        journey,
        alchemy,
    };
}
