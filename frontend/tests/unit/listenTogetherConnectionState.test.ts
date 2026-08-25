import assert from "node:assert/strict";
import { test } from "node:test";
import {
    resolveConnectionEvent,
    LT_DISCONNECT_GRACE_MS,
} from "../../lib/listenTogetherConnectionState";

test("connect restores full connected state and awaits the hydration snapshot", () => {
    assert.deepEqual(resolveConnectionEvent({ type: "connect" }), {
        clearGraceTimer: true,
        setIsConnected: true,
        setHasConnectedOnce: true,
        setReconnectAttempt: 0,
        setSocketRouteStatus: "ok",
        clearSocketRouteError: true,
        markAwaitingInitialState: true,
    });
});

test("reconnect restores connected state and hands audio recovery to the reconnect path", () => {
    const directive = resolveConnectionEvent({ type: "reconnect" });
    assert.equal(directive.markPendingAudioRecovery, true);
    assert.equal(directive.setIsConnected, true);
    assert.equal(directive.setReconnectAttempt, 0);
    assert.equal(directive.markAwaitingInitialState, undefined);
    assert.equal(directive.setHasConnectedOnce, undefined);
});

test("reconnect attempts bump the counter and defer the visual disconnect", () => {
    assert.deepEqual(
        resolveConnectionEvent({ type: "reconnect-attempt", attempt: 3 }),
        {
            setReconnectAttempt: 3,
            markPendingAudioRecovery: true,
            armGraceTimer: "reconnect-attempt",
        },
    );
});

test("exhausted reconnects fail fast with an error and a route probe", () => {
    const directive = resolveConnectionEvent({ type: "reconnect-failed" });
    assert.equal(directive.clearGraceTimer, true);
    assert.equal(directive.setIsConnected, false);
    assert.equal(directive.validateRoute, true);
    assert.match(directive.setError ?? "", /reconnect failed/i);
});

test("disconnect only arms the grace timer", () => {
    assert.deepEqual(resolveConnectionEvent({ type: "disconnect" }), {
        armGraceTimer: "disconnect",
    });
});

test("grace expiry flips the indicator; reconnect-attempt expiry also probes the route", () => {
    assert.deepEqual(
        resolveConnectionEvent({
            type: "grace-expired",
            cause: "reconnect-attempt",
        }),
        { setIsConnected: false, setSocketRouteStatus: "checking" },
    );
    assert.deepEqual(
        resolveConnectionEvent({ type: "grace-expired", cause: "disconnect" }),
        { setIsConnected: false },
    );
});

test("the grace window matches the historical two-second deferral", () => {
    assert.equal(LT_DISCONNECT_GRACE_MS, 2000);
});
