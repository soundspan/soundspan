import assert from "node:assert/strict";
import test from "node:test";
import { hintForMode } from "../../components/vibe/mapHints";

test("each mode gets its own verb hint", () => {
    assert.match(hintForMode("explore"), /Click a dot to play & travel/);
    assert.match(hintForMode("explore"), /Shift-click queues/);
    assert.match(hintForMode("travel"), /halo/);
    assert.match(hintForMode("travel"), /Esc exits/);
    assert.match(hintForMode("journey"), /destination track or mood/);
    assert.match(hintForMode("alchemy"), /blend 2–10 tracks/);
});

test("journey picking narrows the hint to the pick action", () => {
    assert.match(
        hintForMode("journey", { picking: true }),
        /Click any dot to set the journey's destination/
    );
});

test("an armed brush overrides every mode hint", () => {
    for (const mode of ["explore", "travel", "journey", "alchemy"] as const) {
        assert.match(hintForMode(mode, { sweepArmed: true }), /Brush armed/);
    }
});
