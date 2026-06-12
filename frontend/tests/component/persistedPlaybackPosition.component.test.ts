import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { resetPersistedTrackStartPosition } from "../../lib/persisted-playback-position";

type StorageLike = {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
};

type GlobalScope = typeof globalThis & {
    window?: unknown;
    localStorage?: unknown;
};

const globalScope = globalThis as GlobalScope;

let previousWindow: unknown;
let previousLocalStorage: unknown;

function installStorage(options?: { throwOnSet?: boolean }) {
    const values = new Map<string, string>();
    const storage: StorageLike = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
            if (options?.throwOnSet) {
                throw new Error("write blocked");
            }
            values.set(key, value);
        },
        removeItem: (key) => {
            values.delete(key);
        },
    };

    (globalScope as any).window = {
        localStorage: storage,
    };
    (globalScope as any).localStorage = storage;

    return values;
}

beforeEach(() => {
    previousWindow = globalScope.window;
    previousLocalStorage = globalScope.localStorage;
});

afterEach(() => {
    if (typeof previousWindow === "undefined") {
        delete (globalScope as any).window;
    } else {
        (globalScope as any).window = previousWindow;
    }

    if (typeof previousLocalStorage === "undefined") {
        delete (globalScope as any).localStorage;
    } else {
        (globalScope as any).localStorage = previousLocalStorage;
    }
});

test("no-ops when track id is missing", () => {
    const values = installStorage();

    resetPersistedTrackStartPosition("");

    assert.equal(values.size, 0);
});

test("writes reset playback position and track id keys", () => {
    const values = installStorage();

    resetPersistedTrackStartPosition("track-42");

    assert.equal(values.get("soundspan_current_time"), "0");
    assert.equal(values.get("soundspan_current_time_track_id"), "track-42");
});

test("ignores storage write failures", () => {
    installStorage({ throwOnSet: true });

    assert.doesNotThrow(() => {
        resetPersistedTrackStartPosition("track-99");
    });
});

test("no-ops when window is unavailable", () => {
    delete globalScope.window;
    delete globalScope.localStorage;

    assert.doesNotThrow(() => {
        resetPersistedTrackStartPosition("track-11");
    });
});
