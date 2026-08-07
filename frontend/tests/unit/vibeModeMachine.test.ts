import assert from "node:assert/strict";
import test from "node:test";
import {
    vibeModeReducer,
    MAX_ALCHEMY_INGREDIENTS,
    MIN_JOURNEY_STEPS,
    MAX_JOURNEY_STEPS,
    MIN_WEIGHT,
    MAX_WEIGHT,
    type ModeState,
} from "../../components/vibe/vibeModeMachine";

const explore: ModeState = { mode: "explore" };

function enterTravel(id = "t1"): ModeState {
    return vibeModeReducer(explore, { type: "ENTER_TRAVEL", id });
}

function enterJourney(fromId = "t1"): ModeState {
    return vibeModeReducer(explore, { type: "ENTER_JOURNEY", fromId });
}

function enterAlchemy(id = "t1"): ModeState {
    return vibeModeReducer(explore, { type: "ADD_ALCHEMY", id });
}

test("RESET returns to explore from every mode", () => {
    for (const state of [enterTravel(), enterJourney(), enterAlchemy()]) {
        assert.deepEqual(vibeModeReducer(state, { type: "RESET" }), {
            mode: "explore",
        });
    }
});

test("travel: TRAVEL_TO moves the origin and appends to the breadcrumb without consecutive duplicates", () => {
    let state = enterTravel("t1");
    state = vibeModeReducer(state, { type: "TRAVEL_TO", id: "t2" });
    assert.equal(state.mode, "travel");
    if (state.mode !== "travel") return;
    assert.equal(state.currentId, "t2");
    assert.deepEqual(state.breadcrumb, ["t1", "t2"]);

    // Same-target hop is a no-op (same state reference — no re-render churn).
    const same = vibeModeReducer(state, { type: "TRAVEL_TO", id: "t2" });
    assert.equal(same, state);
});

test("journey: SET_DEST and SET_MOOD_TARGET are mutually exclusive destinations", () => {
    let state = enterJourney("t1");
    state = vibeModeReducer(state, { type: "SET_MOOD_TARGET", mood: "happy" });
    if (state.mode !== "journey") throw new Error("expected journey");
    assert.equal(state.moodTarget, "happy");
    assert.equal(state.destTrackId, null);

    state = vibeModeReducer(state, { type: "SET_DEST", id: "t9" });
    if (state.mode !== "journey") throw new Error("expected journey");
    assert.equal(state.destTrackId, "t9");
    assert.equal(state.moodTarget, null); // picking a track clears the mood
    assert.equal(state.picking, false); // and ends pick-on-map
});

test("journey: SET_STEPS clamps into the slider range and rounds", () => {
    let state = enterJourney();
    state = vibeModeReducer(state, { type: "SET_STEPS", steps: 1 });
    if (state.mode !== "journey") throw new Error("expected journey");
    assert.equal(state.steps, MIN_JOURNEY_STEPS);
    state = vibeModeReducer(state, { type: "SET_STEPS", steps: 99 });
    if (state.mode !== "journey") throw new Error("expected journey");
    assert.equal(state.steps, MAX_JOURNEY_STEPS);
    state = vibeModeReducer(state, { type: "SET_STEPS", steps: 7.6 });
    if (state.mode !== "journey") throw new Error("expected journey");
    assert.equal(state.steps, 8);
});

test("alchemy: ADD_ALCHEMY enters the mode, dedupes ids, and stops at the cap", () => {
    let state: ModeState = explore;
    for (let i = 0; i < MAX_ALCHEMY_INGREDIENTS + 3; i++) {
        state = vibeModeReducer(state, { type: "ADD_ALCHEMY", id: `t${i}` });
    }
    if (state.mode !== "alchemy") throw new Error("expected alchemy");
    assert.equal(state.ingredients.length, MAX_ALCHEMY_INGREDIENTS);

    // Duplicate id is a no-op (same reference).
    const dup = vibeModeReducer(state, { type: "ADD_ALCHEMY", id: "t0" });
    assert.equal(dup, state);
});

test("alchemy: removing the last ingredient exits to explore", () => {
    let state = enterAlchemy("t1");
    state = vibeModeReducer(state, { type: "ADD_ALCHEMY", id: "t2" });
    state = vibeModeReducer(state, { type: "REMOVE_ALCHEMY", id: "t1" });
    if (state.mode !== "alchemy") throw new Error("expected alchemy");
    assert.deepEqual(
        state.ingredients.map((i) => i.id),
        ["t2"]
    );
    state = vibeModeReducer(state, { type: "REMOVE_ALCHEMY", id: "t2" });
    assert.deepEqual(state, { mode: "explore" });
});

test("alchemy: SET_WEIGHT clamps into the weight range", () => {
    let state = enterAlchemy("t1");
    state = vibeModeReducer(state, {
        type: "SET_WEIGHT",
        id: "t1",
        weight: 100,
    });
    if (state.mode !== "alchemy") throw new Error("expected alchemy");
    assert.equal(state.ingredients[0].weight, MAX_WEIGHT);
    state = vibeModeReducer(state, { type: "SET_WEIGHT", id: "t1", weight: 0 });
    if (state.mode !== "alchemy") throw new Error("expected alchemy");
    assert.equal(state.ingredients[0].weight, MIN_WEIGHT);
});

test("mode-scoped actions are no-ops outside their mode", () => {
    // A stale panel callback firing after a mode switch must never corrupt
    // the new mode's state.
    assert.equal(
        vibeModeReducer(explore, { type: "TRAVEL_TO", id: "t2" }),
        explore
    );
    assert.equal(vibeModeReducer(explore, { type: "TOGGLE_PICK" }), explore);
    assert.equal(
        vibeModeReducer(explore, { type: "SET_DEST", id: "t2" }),
        explore
    );
    assert.equal(
        vibeModeReducer(explore, { type: "SET_WEIGHT", id: "t1", weight: 1 }),
        explore
    );
    const travel = enterTravel();
    assert.equal(
        vibeModeReducer(travel, { type: "SET_STEPS", steps: 5 }),
        travel
    );
});
