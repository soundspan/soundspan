"use client";

/** Async route, playback, and save state for journey mode. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Track } from "@/lib/audio-state-context";
import type { MapTrack } from "./types";
import { annotateOnMap, journeyTracks, mapTrackToTrack } from "./journeyTracks";
import { describeSaveResult, formatPlaylistDate, saveTracksAsPlaylist } from "./savePlaylist";
import type { VibeListItem, VibeResultRow } from "./vibeListItem";
import { DRIFT_STEPS, type ModeAction, type ModeState } from "./vibeModeMachine";
import type { VibeControls } from "./useVibeMode";

export interface JourneyMoodOption { mood: string; trackCount: number }
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
    quantiles: readonly number[] | null;
    togglePick: () => void;
    chooseMood: (mood: string) => void;
    setSteps: (steps: number) => void;
    submit: () => void;
    drift: (mood: string) => void;
    play: () => void;
    save: () => Promise<void>;
    saving: boolean;
    close: () => void;
}

interface JourneyTargetResult { trackId?: string; mood?: string; title?: string; label?: string }
interface JourneyRoute { mode: "track" | "mood"; target: JourneyTargetResult; waypoints: VibeResultRow[] }

export interface UseJourneyModeArgs {
    state: ModeState;
    dispatch: (action: ModeAction) => void;
    trackById: ReadonlyMap<string, MapTrack>;
    currentTrack: Track | null;
    controls: VibeControls;
    quantiles: readonly number[] | null;
    titleOf: (id: string | null) => string;
    exitToExplore: () => void;
}
export interface UseJourneyMode {
    journey: JourneyView | null;
    canStartJourney: boolean;
    startJourney: () => void;
    pickDestination: (id: string) => void;
}

function journeyErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : "";
    if (/no embedding/i.test(message)) return "This track has no embedding yet";
    if (/enough embedded tracks/i.test(message)) return "Not enough analyzed tracks for this mood";
    return message || "Couldn't build that journey";
}

interface JourneyRequest {
    route: JourneyRoute | null;
    waypoints: VibeListItem[];
    loading: boolean;
    error: string | null;
    clear: () => void;
    invalidate: () => void;
    run: (fromId: string, toTrackId: string | undefined,
        mood: string | undefined, steps: number) => void;
}

function useJourneyRequest(inJourney: boolean,
    trackById: ReadonlyMap<string, MapTrack>): JourneyRequest {
    const [route, setRoute] = useState<JourneyRoute | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const generation = useRef(0);
    const clear = useCallback(() => { setRoute(null); setError(null); }, []);
    const invalidate = useCallback(() => {
        generation.current++;
        clear();
        setLoading(false);
    }, [clear]);
    useEffect(() => { if (!inJourney) invalidate(); }, [inJourney, invalidate]);
    const run = useCallback((fromId: string, toTrackId: string | undefined,
        mood: string | undefined, steps: number) => {
        const request = ++generation.current;
        setLoading(true);
        setError(null);
        setRoute(null);
        void api.getVibeJourney({ fromTrackId: fromId, toTrackId, mood, steps })
            .then((response) => {
                if (request === generation.current) setRoute(response as JourneyRoute);
            })
            .catch((caught) => {
                if (request === generation.current) setError(journeyErrorMessage(caught));
            })
            .finally(() => {
                if (request === generation.current) setLoading(false);
            });
    }, []);
    const waypoints = useMemo(() => annotateOnMap(route?.waypoints ?? [], trackById),
        [route, trackById]);
    return { route, waypoints, loading, error, clear, invalidate, run };
}

function useJourneyMoods(inJourney: boolean): JourneyMoodOption[] {
    const [moods, setMoods] = useState<JourneyMoodOption[]>([]);
    useEffect(() => {
        if (!inJourney || moods.length > 0) return;
        let cancelled = false;
        api.getVibeMoods().then((response) => {
            if (!cancelled) setMoods(response);
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [inJourney, moods.length]);
    return moods;
}

function useJourneyEntry(args: UseJourneyModeArgs, request: JourneyRequest) {
    const currentTrackId = args.currentTrack?.id ?? null;
    const travelId = args.state.mode === "travel" ? args.state.currentId : null;
    const canStartJourney = args.state.mode !== "alchemy" && !!(travelId || currentTrackId);
    const startJourney = useCallback(() => {
        const fromId = travelId ?? currentTrackId;
        if (!fromId) return;
        request.invalidate();
        args.dispatch({ type: "ENTER_JOURNEY", fromId });
    }, [travelId, currentTrackId, request.invalidate, args.dispatch]);
    const pickDestination = useCallback((id: string) => {
        if (args.state.mode !== "journey" || id === args.state.fromId) return;
        args.dispatch({ type: "SET_DEST", id });
        request.clear();
    }, [args.state, args.dispatch, request.clear]);
    return { canStartJourney, startJourney, pickDestination };
}

function useRouteActions(state: ModeState, dispatch: UseJourneyModeArgs["dispatch"],
    request: JourneyRequest) {
    const submit = useCallback(() => {
        if (state.mode !== "journey" || (!state.destTrackId && !state.moodTarget)) return;
        request.run(state.fromId, state.destTrackId ?? undefined,
            state.moodTarget ?? undefined, state.steps);
    }, [state, request.run]);
    const drift = useCallback((mood: string) => {
        if (state.mode !== "journey") return;
        dispatch({ type: "SET_MOOD_TARGET", mood });
        dispatch({ type: "SET_STEPS", steps: DRIFT_STEPS });
        request.run(state.fromId, undefined, mood, DRIFT_STEPS);
    }, [state, dispatch, request.run]);
    return { submit, drift };
}

function journeyOriginTrack(args: UseJourneyModeArgs, fromId: string): Track | null {
    const onMap = args.trackById.get(fromId);
    if (onMap) return mapTrackToTrack(onMap);
    return args.currentTrack?.id === fromId ? args.currentTrack : null;
}

function useJourneySave(args: UseJourneyModeArgs, route: JourneyRoute | null,
    inJourney: boolean) {
    const [saving, setSaving] = useState(false);
    const generation = useRef(0);
    useEffect(() => {
        if (!inJourney) {
            generation.current++;
            setSaving(false);
        }
    }, [inJourney]);
    const save = useCallback(async () => {
        if (args.state.mode !== "journey" || !route) return;
        const queue = journeyTracks(journeyOriginTrack(args, args.state.fromId), route.waypoints);
        if (queue.length === 0) return;
        const label = route.target?.label ?? route.target?.title ?? "Journey";
        const name = `Journey to ${label} — ${formatPlaylistDate()}`;
        const request = ++generation.current;
        setSaving(true);
        try {
            const outcome = describeSaveResult(name,
                await saveTracksAsPlaylist(name, queue.map((track) => track.id)));
            if (outcome.tone === "success") toast.success(outcome.message);
            else toast.warning(outcome.message);
        } catch {
            toast.error("Couldn't save that playlist");
        } finally {
            if (request === generation.current) setSaving(false);
        }
    }, [args, route]);
    return { saving, save };
}

function useJourneyPlay(args: UseJourneyModeArgs, route: JourneyRoute | null) {
    return useCallback(() => {
        if (args.state.mode !== "journey" || !route) return;
        const queue = journeyTracks(journeyOriginTrack(args, args.state.fromId), route.waypoints);
        if (queue.length) args.controls.playTracks(queue, 0, true);
    }, [args, route]);
}

/** Derive the journey view and its entry points. */
export function useJourneyMode(args: UseJourneyModeArgs): UseJourneyMode {
    const inJourney = args.state.mode === "journey";
    const request = useJourneyRequest(inJourney, args.trackById);
    const moods = useJourneyMoods(inJourney);
    const entry = useJourneyEntry(args, request);
    const actions = useRouteActions(args.state, args.dispatch, request);
    const save = useJourneySave(args, request.route, inJourney);
    const play = useJourneyPlay(args, request.route);
    if (args.state.mode !== "journey") return { journey: null, ...entry };
    const state = args.state;
    const journey: JourneyView = {
        fromId: state.fromId, fromLabel: args.titleOf(state.fromId), picking: state.picking,
        destTrackId: state.destTrackId,
        destLabel: state.destTrackId ? args.titleOf(state.destTrackId) : null,
        moodTarget: state.moodTarget, steps: state.steps, moods,
        targetLabel: request.route?.target?.label ?? request.route?.target?.title ?? null,
        waypoints: request.waypoints, loading: request.loading, error: request.error,
        canSubmit: !!(state.destTrackId || state.moodTarget), quantiles: args.quantiles,
        togglePick: () => args.dispatch({ type: "TOGGLE_PICK" }),
        chooseMood: (mood) => { args.dispatch({ type: "SET_MOOD_TARGET", mood }); request.clear(); },
        setSteps: (steps) => args.dispatch({ type: "SET_STEPS", steps }),
        submit: actions.submit, drift: actions.drift, play, save: save.save,
        saving: save.saving, close: args.exitToExplore,
    };
    return { journey, ...entry };
}
