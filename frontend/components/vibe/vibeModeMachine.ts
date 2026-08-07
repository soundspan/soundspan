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

export function vibeModeReducer(
    state: ModeState,
    action: ModeAction
): ModeState {
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
            // prev is only ever non-empty when already in alchemy mode (it's []
            // otherwise), so hitting the cap implies state.mode === "alchemy"
            // already — the state is just returned as-is.
            if (prev.length >= MAX_ALCHEMY_INGREDIENTS) return state;
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
