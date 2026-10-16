import assert from "node:assert/strict";
import test from "node:test";
import {
    deriveRemoteProviderConnections,
    isRemoteProviderConnected,
} from "../../hooks/useRemoteProviderConnections";

const ready = { enabled: true, available: true, authenticated: true };

test("TIDAL is connected only when enabled, available, and signed in", () => {
    assert.equal(isRemoteProviderConnected(ready, true), true);
    assert.equal(
        isRemoteProviderConnected({ ...ready, enabled: false }, true),
        false,
    );
    assert.equal(
        isRemoteProviderConnected({ ...ready, available: false }, true),
        false,
    );
    assert.equal(
        isRemoteProviderConnected({ ...ready, authenticated: false }, true),
        false,
    );
    assert.equal(isRemoteProviderConnected(undefined, true), false);
});

test("YouTube Music is connected without a personal sign-in", () => {
    const signedOut = { ...ready, authenticated: false };
    assert.equal(isRemoteProviderConnected(signedOut, false), true);
    assert.equal(
        isRemoteProviderConnected({ ...signedOut, enabled: false }, false),
        false,
    );
    assert.equal(
        isRemoteProviderConnected({ ...signedOut, available: false }, false),
        false,
    );
});

test("connection summary reports each provider and any", () => {
    assert.deepEqual(deriveRemoteProviderConnections(ready, undefined), {
        tidal: true,
        youtube: false,
        any: true,
    });
    assert.deepEqual(deriveRemoteProviderConnections(undefined, ready), {
        tidal: false,
        youtube: true,
        any: true,
    });
    assert.deepEqual(
        deriveRemoteProviderConnections(
            { ...ready, authenticated: false },
            { ...ready, authenticated: false },
        ),
        { tidal: false, youtube: true, any: true },
    );
    assert.deepEqual(deriveRemoteProviderConnections(undefined, undefined), {
        tidal: false,
        youtube: false,
        any: false,
    });
});
