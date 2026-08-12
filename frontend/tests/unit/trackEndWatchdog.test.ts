import assert from "node:assert/strict";
import test from "node:test";
import {
    createTrackEndWatchdog,
    type TrackEndWatchdogSnapshot,
} from "../../components/player/trackEndWatchdog";

const SNAPSHOT: TrackEndWatchdogSnapshot = {
    trackId: "track-1",
    loadId: 7,
    statusWasPlaying: true,
};

test("fires once after an armed end remains eligible for 2000ms", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const advances: TrackEndWatchdogSnapshot[] = [];
    const watchdog = createTrackEndWatchdog({
        timeoutMs: 2_000,
        shouldHandle: () => true,
        onUnhandledEnd: (snapshot) => advances.push(snapshot),
    });

    watchdog.arm(SNAPSHOT);
    watchdog.arm(SNAPSHOT);
    t.mock.timers.tick(1_999);
    assert.deepEqual(advances, []);

    t.mock.timers.tick(1);
    assert.deepEqual(advances, [SNAPSHOT]);
    t.mock.timers.tick(2_000);
    assert.deepEqual(advances, [SNAPSHOT]);
});

test("does nothing when normal end handling made the snapshot ineligible", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let endWasHandled = false;
    const advances: TrackEndWatchdogSnapshot[] = [];
    const watchdog = createTrackEndWatchdog({
        timeoutMs: 2_000,
        shouldHandle: () => !endWasHandled,
        onUnhandledEnd: (snapshot) => advances.push(snapshot),
    });

    watchdog.arm(SNAPSHOT);
    endWasHandled = true;
    t.mock.timers.tick(2_000);

    assert.deepEqual(advances, []);
});

test("clearing an armed watchdog on pause prevents it from firing", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const advances: TrackEndWatchdogSnapshot[] = [];
    const watchdog = createTrackEndWatchdog({
        timeoutMs: 2_000,
        shouldHandle: () => true,
        onUnhandledEnd: (snapshot) => advances.push(snapshot),
    });

    watchdog.arm(SNAPSHOT);
    watchdog.clear();
    t.mock.timers.tick(2_000);

    assert.deepEqual(advances, []);
});
