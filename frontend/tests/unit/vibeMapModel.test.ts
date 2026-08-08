import assert from "node:assert/strict";
import test from "node:test";
import {
    deriveVibeMapPresentation,
    findTrackAtScreenPoint,
    journeyBounds,
    resolveEscapeAction,
    shouldFollowTravelOrigin,
} from "../../components/vibe/vibeMapModel";

const viewport = { scale: 100, tx: 0, ty: 0 };

test("escape resolution preserves the sweep, panel, mode, fullscreen priority", () => {
    assert.equal(resolveEscapeAction(true, true, "journey", true), "dismiss-sweep");
    assert.equal(resolveEscapeAction(false, true, "journey", true), "close-aux");
    assert.equal(resolveEscapeAction(false, false, "journey", true), "exit-mode");
    assert.equal(resolveEscapeAction(false, false, "explore", true), "exit-fullscreen");
    assert.equal(resolveEscapeAction(false, false, "explore", false), null);
});

test("presentation gives sweep highlights priority and hides ambient lines in a mode", () => {
    const sweep = new Set(["sweep"]);
    const vibe = new Set(["alchemy"]);
    const spotlight = new Set(["search"]);
    const trail = [{ x: 1, y: 2, alpha: 1 }];
    const plan = [{ x: 3, y: 4 }];
    const result = deriveVibeMapPresentation({
        mode: "alchemy", sweepHighlight: sweep, vibeHighlight: vibe,
        spotlightHighlight: spotlight, trail, plan, filtersExpanded: true,
        auxSurface: "queue", sweepChipOpen: false,
    });

    assert.equal(result.effectiveHighlightIds, sweep);
    assert.equal(result.effectiveDim, false);
    assert.equal(result.filtersOpen, false);
    assert.equal(result.queuePanelVisible, true);
    assert.deepEqual(result.shownTrail, []);
    assert.deepEqual(result.shownPlan, []);
});

test("screen hit testing chooses the nearest visible track and respects the mask", () => {
    const tracks = [{ id: "hidden" }, { id: "visible" }];
    const positions = new Float32Array([0.5, 0.5, 0.52, 0.5]);
    const id = findTrackAtScreenPoint({
        clientX: 51, clientY: 50, rect: { left: 0, top: 0 }, viewport,
        fitScale: 100, tracks, positions, mask: new Uint8Array([0, 1]),
    });

    assert.equal(id, "visible");
});

test("journey bounds include the origin and only on-map waypoints", () => {
    const points = new Map([
        ["origin", { x: 0.1, y: 0.2 }],
        ["on-map", { x: 0.8, y: 0.7 }],
        ["off-map", { x: 1, y: 1 }],
    ]);
    const bounds = journeyBounds("origin", [
        { id: "off-map", onMap: false },
        { id: "on-map", onMap: true },
    ], (id) => points.get(id) ?? null);

    assert.deepEqual(bounds, { minX: 0.1, minY: 0.2, maxX: 0.8, maxY: 0.7 });
});

test("travel following starts only outside the central band", () => {
    const dims = { width: 1000, height: 500 };
    assert.equal(shouldFollowTravelOrigin({ x: 500, y: 250 }, dims), false);
    assert.equal(shouldFollowTravelOrigin({ x: 50, y: 250 }, dims), true);
});
