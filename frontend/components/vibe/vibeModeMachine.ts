/**
 * vibeModeMachine — the PURE mode state machine for the vibe map.
 *
 * No React, no DOM, no I/O: just the exclusive-mode state shape
 * (explore | travel | journey | alchemy), the actions that move between
 * modes, and the reducer. `useVibeMode` wraps this in `useReducer` and the
 * per-mode hooks (`useTravelMode` / `useJourneyMode` / `useAlchemyMode`)
 * derive their async/view state from it — keeping every transition rule in
 * one unit-testable place.
 */

import type { CompassDirection } from "./travelCompass";

export type VibeMode = "explore" | "travel" | "journey" | "alchemy";

export const MAX_ALCHEMY_INGREDIENTS = 10;
export const MIN_JOURNEY_STEPS = 4;
export const MAX_JOURNEY_STEPS = 16;
export const DEFAULT_JOURNEY_STEPS = 8;
export const DRIFT_STEPS = 12;
export const MIN_WEIGHT = 0.1;
export const MAX_WEIGHT = 2;
export const DEFAULT_WEIGHT = 1;

export interface Ingredient {
    id: string;
    weight: number;
}

export type ModeState =
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

export type ModeAction =
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

export const clampSteps = (n: number): number =>
    Math.min(MAX_JOURNEY_STEPS, Math.max(MIN_JOURNEY_STEPS, Math.round(n)));
export const clampWeight = (n: number): number =>
    Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, n));

type TravelState = Extract<ModeState, { mode: "travel" }>;
type JourneyState = Extract<ModeState, { mode: "journey" }>;
type AlchemyState = Extract<ModeState, { mode: "alchemy" }>;

function reduceTravel(state: TravelState, action: ModeAction): ModeState {
    if (action.type === "SET_DIRECTION") {
        return { ...state, direction: action.direction };
    }
    if (action.type !== "TRAVEL_TO" || state.currentId === action.id) return state;
    const lastId = state.breadcrumb[state.breadcrumb.length - 1];
    return { ...state, currentId: action.id,
        breadcrumb: lastId === action.id ? state.breadcrumb : [...state.breadcrumb, action.id] };
}

function reduceJourney(state: JourneyState, action: ModeAction): ModeState {
    switch (action.type) {
        case "TOGGLE_PICK":
            return { ...state, picking: !state.picking };
        case "SET_DEST":
            return { ...state, destTrackId: action.id, moodTarget: null, picking: false };
        case "SET_MOOD_TARGET":
            return { ...state, moodTarget: action.mood, destTrackId: null };
        case "SET_STEPS":
            return { ...state, steps: clampSteps(action.steps) };
        default:
            return state;
    }
}

function addAlchemy(state: ModeState, id: string): ModeState {
    const ingredients = state.mode === "alchemy" ? state.ingredients : [];
    if (ingredients.some((ingredient) => ingredient.id === id) ||
        ingredients.length >= MAX_ALCHEMY_INGREDIENTS) return state;
    return { mode: "alchemy",
        ingredients: [...ingredients, { id, weight: DEFAULT_WEIGHT }] };
}

function reduceAlchemy(state: AlchemyState, action: ModeAction): ModeState {
    if (action.type === "REMOVE_ALCHEMY") {
        const ingredients = state.ingredients.filter((ingredient) => ingredient.id !== action.id);
        return ingredients.length === 0 ? { mode: "explore" } : { mode: "alchemy", ingredients };
    }
    if (action.type !== "SET_WEIGHT") return state;
    return { mode: "alchemy", ingredients: state.ingredients.map((ingredient) =>
        ingredient.id === action.id
            ? { ...ingredient, weight: clampWeight(action.weight) } : ingredient) };
}

/** Apply one exclusive-mode transition. */
export function vibeModeReducer(state: ModeState, action: ModeAction): ModeState {
    if (action.type === "RESET") return { mode: "explore" };
    if (action.type === "ENTER_TRAVEL") {
        return { mode: "travel", currentId: action.id,
            breadcrumb: [action.id], direction: "any" };
    }
    if (action.type === "ENTER_JOURNEY") {
        return { mode: "journey", fromId: action.fromId, picking: false,
            destTrackId: null, moodTarget: null, steps: DEFAULT_JOURNEY_STEPS };
    }
    if (action.type === "ADD_ALCHEMY") return addAlchemy(state, action.id);
    if (state.mode === "travel") return reduceTravel(state, action);
    if (state.mode === "journey") return reduceJourney(state, action);
    if (state.mode === "alchemy") return reduceAlchemy(state, action);
    return state;
}
