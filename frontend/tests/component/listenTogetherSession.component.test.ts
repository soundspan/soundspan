import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
    enqueueLatestListenTogetherHostTrackOperation,
    LISTEN_TOGETHER_MEMBERSHIP_PENDING_STORAGE_KEY,
    LISTEN_TOGETHER_SESSION_STORAGE_KEY,
    getListenTogetherOptimisticTrackSelectionPolicy,
    getListenTogetherSessionSnapshot,
    isListenTogetherActiveOrPending,
    isListenTogetherMembershipPending,
    requestListenTogetherGroupResync,
    setListenTogetherMembershipPending,
    setListenTogetherSessionSnapshot,
    type ListenTogetherSessionSnapshot,
} from "../../lib/listen-together-session.ts";
import { listenTogetherSocket } from "../../lib/listen-together-socket.ts";
import { api } from "@/lib/api";

type StorageLike = {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
};

type GlobalScope = typeof globalThis & {
    window?: unknown;
    localStorage?: StorageLike;
};

const globalScope = globalThis as GlobalScope;

let previousWindow: unknown;
let previousLocalStorage: StorageLike | undefined;

function installStorage(
    initial?: Record<string, string>,
    options?: {
        throwOnGet?: boolean;
        throwOnSet?: boolean;
        throwOnRemove?: boolean;
    },
) {
    const values = new Map<string, string>(Object.entries(initial ?? {}));
    const storage: StorageLike = {
        getItem: (key) => {
            if (options?.throwOnGet) {
                throw new Error("get blocked");
            }
            return values.get(key) ?? null;
        },
        setItem: (key, value) => {
            if (options?.throwOnSet) {
                throw new Error("set blocked");
            }
            values.set(key, value);
        },
        removeItem: (key) => {
            if (options?.throwOnRemove) {
                throw new Error("remove blocked");
            }
            values.delete(key);
        },
    };

    globalScope.window = {
        localStorage: storage,
    };
    globalScope.localStorage = storage;

    return { values, storage };
}

async function flushMicrotasks(turns: number = 20): Promise<void> {
    for (let i = 0; i < turns; i += 1) {
        await Promise.resolve();
    }
}

async function waitFor(
    predicate: () => boolean,
    message: string,
): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(message);
}

function clearWindowStorage(): void {
    delete globalScope.window;
    delete globalScope.localStorage;
}

const snapshot: ListenTogetherSessionSnapshot = {
    groupId: "group-123",
    isHost: true,
    playback: {
        isPlaying: true,
        positionMs: 1200,
        serverTime: 50_000,
        currentIndex: 2,
    },
};

beforeEach(() => {
    previousWindow = globalScope.window;
    previousLocalStorage = globalScope.localStorage;
    listenTogetherSocket.disconnect();
    setListenTogetherSessionSnapshot(null);
    setListenTogetherMembershipPending(false);
    clearWindowStorage();
});

afterEach(() => {
    listenTogetherSocket.disconnect();
    setListenTogetherSessionSnapshot(null);
    setListenTogetherMembershipPending(false);

    if (typeof previousWindow === "undefined") {
        delete globalScope.window;
    } else {
        globalScope.window = previousWindow;
    }

    if (typeof previousLocalStorage === "undefined") {
        delete globalScope.localStorage;
    } else {
        globalScope.localStorage = previousLocalStorage;
    }
});

test("stores and reads session snapshot from in-memory fallback when window is unavailable", () => {
    setListenTogetherSessionSnapshot(snapshot);

    assert.deepEqual(getListenTogetherSessionSnapshot(), snapshot);

    setListenTogetherSessionSnapshot(null);
    assert.equal(getListenTogetherSessionSnapshot(), null);
});

test("reads from localStorage and clears stale in-memory snapshot on malformed data", () => {
    const { values } = installStorage();

    setListenTogetherSessionSnapshot(snapshot);
    assert.equal(
        values.get(LISTEN_TOGETHER_SESSION_STORAGE_KEY),
        JSON.stringify(snapshot),
    );
    assert.deepEqual(getListenTogetherSessionSnapshot(), snapshot);

    values.set(LISTEN_TOGETHER_SESSION_STORAGE_KEY, "{invalid-json");
    assert.equal(getListenTogetherSessionSnapshot(), null);

    values.set(LISTEN_TOGETHER_SESSION_STORAGE_KEY, JSON.stringify(snapshot));
    assert.deepEqual(getListenTogetherSessionSnapshot(), snapshot);

    values.delete(LISTEN_TOGETHER_SESSION_STORAGE_KEY);
    assert.equal(getListenTogetherSessionSnapshot(), null);
});

test("rejects invalid snapshot payload shapes from storage", () => {
    const { values } = installStorage();

    values.set(
        LISTEN_TOGETHER_SESSION_STORAGE_KEY,
        JSON.stringify({
            groupId: "group-123",
            isHost: "not-boolean",
            playback: { isPlaying: true, positionMs: 1, serverTime: 2, currentIndex: 3 },
        }),
    );
    assert.equal(getListenTogetherSessionSnapshot(), null);

    setListenTogetherSessionSnapshot(snapshot);
    assert.deepEqual(getListenTogetherSessionSnapshot(), snapshot);
    values.set(
        LISTEN_TOGETHER_SESSION_STORAGE_KEY,
        JSON.stringify({
            groupId: "group-123",
            isHost: true,
            playback: {
                isPlaying: true,
                positionMs: "not-number",
                serverTime: 2,
                currentIndex: 3,
            },
        }),
    );
    assert.equal(getListenTogetherSessionSnapshot(), null);
});

test("falls back to in-memory state when storage APIs throw", () => {
    installStorage(undefined, {
        throwOnGet: true,
        throwOnSet: true,
        throwOnRemove: true,
    });

    assert.doesNotThrow(() => {
        setListenTogetherSessionSnapshot(snapshot);
    });
    assert.deepEqual(getListenTogetherSessionSnapshot(), snapshot);

    assert.doesNotThrow(() => {
        setListenTogetherMembershipPending(true);
    });
    assert.equal(isListenTogetherMembershipPending(), true);

    assert.doesNotThrow(() => {
        setListenTogetherMembershipPending(false);
        setListenTogetherSessionSnapshot(null);
    });
    assert.equal(isListenTogetherMembershipPending(), false);
    assert.equal(getListenTogetherSessionSnapshot(), null);
});

test("tracks membership pending state through storage and active-or-pending helper", () => {
    const { values } = installStorage();

    assert.equal(isListenTogetherMembershipPending(), false);

    setListenTogetherMembershipPending(true);
    assert.equal(values.get(LISTEN_TOGETHER_MEMBERSHIP_PENDING_STORAGE_KEY), "1");
    assert.equal(isListenTogetherMembershipPending(), true);

    setListenTogetherMembershipPending(false);
    assert.equal(values.has(LISTEN_TOGETHER_MEMBERSHIP_PENDING_STORAGE_KEY), false);
    assert.equal(isListenTogetherMembershipPending(), false);

    setListenTogetherSessionSnapshot(snapshot);
    assert.equal(isListenTogetherActiveOrPending(), true);

    setListenTogetherSessionSnapshot(null);
    setListenTogetherMembershipPending(true);
    assert.equal(isListenTogetherActiveOrPending(), true);

    setListenTogetherMembershipPending(false);
    assert.equal(isListenTogetherActiveOrPending(), false);
});

test("optimistic host track selection policy preserves solo resume and guards remote apply", () => {
    assert.deepEqual(getListenTogetherOptimisticTrackSelectionPolicy(), {
        resetPersistedTrackStartPosition: false,
        guardRemoteApply: true,
    });
});

test("requestListenTogetherGroupResync joins explicit target group", async () => {
    const originalJoinGroup = listenTogetherSocket.joinGroup;
    const joinedGroups: string[] = [];

    (listenTogetherSocket as unknown as { joinGroup: (groupId: string) => Promise<void> }).joinGroup =
        async (groupId: string) => {
            joinedGroups.push(groupId);
        };

    try {
        await requestListenTogetherGroupResync("group-explicit");
    } finally {
        (listenTogetherSocket as unknown as { joinGroup: (groupId: string) => Promise<void> }).joinGroup =
            originalJoinGroup.bind(listenTogetherSocket);
    }

    assert.deepEqual(joinedGroups, ["group-explicit"]);
});

test("requestListenTogetherGroupResync no-ops when no target group is available", async () => {
    const originalJoinGroup = listenTogetherSocket.joinGroup;
    const joinedGroups: string[] = [];

    (listenTogetherSocket as unknown as { joinGroup: (groupId: string) => Promise<void> }).joinGroup =
        async (groupId: string) => {
            joinedGroups.push(groupId);
        };

    try {
        await requestListenTogetherGroupResync();
    } finally {
        (listenTogetherSocket as unknown as { joinGroup: (groupId: string) => Promise<void> }).joinGroup =
            originalJoinGroup.bind(listenTogetherSocket);
    }

    assert.deepEqual(joinedGroups, []);
});

test("host track operation retries retryable conflicts when group is active", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalNext = listenTogetherSocket.next;
    const socketState = listenTogetherSocket as unknown as {
        currentGroupId: string | null;
    };
    const delays: number[] = [];
    let attempts = 0;

    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
        callback: (...args: unknown[]) => void,
        delay?: number,
    ) => {
        delays.push(Number(delay ?? 0));
        callback();
        return 0 as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    socketState.currentGroupId = "group-retry";
    (
        listenTogetherSocket as unknown as { next: () => Promise<void> }
    ).next = async () => {
        attempts += 1;
        if (attempts === 1) {
            throw Object.assign(new Error("conflict"), {
                code: "CONFLICT",
                transient: true,
                retryable: true,
                retryAfterMs: 73.9,
            });
        }
    };

    try {
        enqueueLatestListenTogetherHostTrackOperation({ action: "next" });
        await flushMicrotasks();
    } finally {
        (
            listenTogetherSocket as unknown as { next: () => Promise<void> }
        ).next = originalNext.bind(listenTogetherSocket);
        (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
            originalSetTimeout;
    }

    assert.equal(attempts, 2);
    assert.deepEqual(delays, [73]);
});

test("host track conflict retries are skipped when there is no active group", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalNext = listenTogetherSocket.next;
    const socketState = listenTogetherSocket as unknown as {
        currentGroupId: string | null;
    };
    const delays: number[] = [];
    let attempts = 0;

    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
        callback: (...args: unknown[]) => void,
        delay?: number,
    ) => {
        delays.push(Number(delay ?? 0));
        callback();
        return 0 as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    socketState.currentGroupId = null;
    (
        listenTogetherSocket as unknown as { next: () => Promise<void> }
    ).next = async () => {
        attempts += 1;
        throw Object.assign(new Error("conflict"), {
            code: "CONFLICT",
            transient: true,
            retryable: true,
        });
    };

    try {
        enqueueLatestListenTogetherHostTrackOperation({ action: "next" });
        await flushMicrotasks();
    } finally {
        (
            listenTogetherSocket as unknown as { next: () => Promise<void> }
        ).next = originalNext.bind(listenTogetherSocket);
        (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
            originalSetTimeout;
    }

    assert.equal(attempts, 1);
    assert.deepEqual(delays, [120]);
});

test("host track operation retry callback runs through real timer scheduling", async () => {
    const originalNext = listenTogetherSocket.next;
    const socketState = listenTogetherSocket as unknown as {
        currentGroupId: string | null;
    };
    let attempts = 0;

    socketState.currentGroupId = "group-real-timer";
    (
        listenTogetherSocket as unknown as { next: () => Promise<void> }
    ).next = async () => {
        attempts += 1;
        if (attempts === 1) {
            throw Object.assign(new Error("conflict"), {
                code: "CONFLICT",
                transient: true,
                retryable: true,
                retryAfterMs: 1,
            });
        }
    };

    try {
        enqueueLatestListenTogetherHostTrackOperation({ action: "next" });
        await waitFor(() => attempts === 2, "retry callback did not execute");
    } finally {
        (
            listenTogetherSocket as unknown as { next: () => Promise<void> }
        ).next = originalNext.bind(listenTogetherSocket);
    }

    assert.equal(attempts, 2);
});

test("host track operation failures trigger group resync", async () => {
    const originalPrevious = listenTogetherSocket.previous;
    const originalJoinGroup = listenTogetherSocket.joinGroup;
    const socketState = listenTogetherSocket as unknown as {
        currentGroupId: string | null;
    };
    const joinedGroups: string[] = [];

    socketState.currentGroupId = "group-resync";
    (
        listenTogetherSocket as unknown as { previous: () => Promise<void> }
    ).previous = async () => {
        throw new Error("forced failure");
    };
    (
        listenTogetherSocket as unknown as { joinGroup: (groupId: string) => Promise<void> }
    ).joinGroup = async (groupId: string) => {
        joinedGroups.push(groupId);
    };

    try {
        enqueueLatestListenTogetherHostTrackOperation({ action: "previous" });
        await waitFor(
            () => joinedGroups.length === 1,
            "resync joinGroup was not invoked",
        );
    } finally {
        (
            listenTogetherSocket as unknown as { previous: () => Promise<void> }
        ).previous = originalPrevious.bind(listenTogetherSocket);
        (
            listenTogetherSocket as unknown as { joinGroup: (groupId: string) => Promise<void> }
        ).joinGroup = originalJoinGroup.bind(listenTogetherSocket);
    }

    assert.deepEqual(joinedGroups, ["group-resync"]);
});

test("host track recovery swallows resync errors", async () => {
    const originalSetTrack = listenTogetherSocket.setTrack;
    const originalJoinGroup = listenTogetherSocket.joinGroup;
    const socketState = listenTogetherSocket as unknown as {
        currentGroupId: string | null;
    };
    let joinAttempts = 0;

    socketState.currentGroupId = "group-resync-fail";
    (
        listenTogetherSocket as unknown as { setTrack: (index: number) => Promise<void> }
    ).setTrack = async () => {
        throw new Error("forced failure");
    };
    (
        listenTogetherSocket as unknown as { joinGroup: (groupId: string) => Promise<void> }
    ).joinGroup = async () => {
        joinAttempts += 1;
        throw new Error("join failed");
    };

    try {
        enqueueLatestListenTogetherHostTrackOperation({
            action: "set-track",
            index: 7,
        });
        await waitFor(
            () => joinAttempts === 1,
            "resync failure path was not exercised",
        );
    } finally {
        (
            listenTogetherSocket as unknown as { setTrack: (index: number) => Promise<void> }
        ).setTrack = originalSetTrack.bind(listenTogetherSocket);
        (
            listenTogetherSocket as unknown as { joinGroup: (groupId: string) => Promise<void> }
        ).joinGroup = originalJoinGroup.bind(listenTogetherSocket);
    }

    assert.equal(joinAttempts, 1);
});

test("createSegmentedStreamingSession forwards trimmed startup headers", async () => {
    const requestCalls: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
    const apiClient = api as unknown as {
        baseUrl: string;
        request: (
            endpoint: string,
            options?: Record<string, unknown>,
        ) => Promise<{
            sessionId: string;
            manifestUrl: string;
            sessionToken: string;
            expiresAt: string;
        }>;
    };
    const originalRequest = apiClient.request;
    const originalBaseUrl = apiClient.baseUrl;

    apiClient.baseUrl = "https://api.example.com";
    apiClient.request = async (endpoint, options = {}) => {
        requestCalls.push({ endpoint, options });
        return {
            sessionId: "session-1",
            manifestUrl: "/streaming/v1/sessions/session-1/manifest.mpd",
            sessionToken: "token-1",
            expiresAt: "2099-01-01T00:00:00.000Z",
        };
    };

    try {
        const response = await api.createSegmentedStreamingSession({
            trackId: "track-1",
            sourceType: "local",
            desiredQuality: "high",
            startupLoadId: 42,
            startupCorrelationId: " corr-123 ",
        });

        assert.equal(
            response.manifestUrl,
            "https://api.example.com/streaming/v1/sessions/session-1/manifest.mpd",
        );
    } finally {
        apiClient.request = originalRequest;
        apiClient.baseUrl = originalBaseUrl;
    }

    assert.equal(requestCalls.length, 1);
    assert.equal(requestCalls[0].endpoint, "/streaming/v1/sessions");
    assert.deepEqual(requestCalls[0].options, {
        method: "POST",
        body: JSON.stringify({
            trackId: "track-1",
            sourceType: "local",
            desiredQuality: "high",
        }),
        headers: {
            "x-segmented-startup-load-id": "42",
            "x-segmented-startup-correlation-id": "corr-123",
        },
    });
});

test("createSegmentedStreamingSession omits startup headers for invalid inputs", async () => {
    const requestCalls: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
    const apiClient = api as unknown as {
        baseUrl: string;
        request: (
            endpoint: string,
            options?: Record<string, unknown>,
        ) => Promise<{
            sessionId: string;
            manifestUrl: string;
            sessionToken: string;
            expiresAt: string;
        }>;
    };
    const originalRequest = apiClient.request;
    const originalBaseUrl = apiClient.baseUrl;

    apiClient.baseUrl = "https://api.example.com";
    apiClient.request = async (endpoint, options = {}) => {
        requestCalls.push({ endpoint, options });
        return {
            sessionId: "session-2",
            manifestUrl: "https://cdn.example.com/streaming/v1/sessions/session-2/manifest.mpd",
            sessionToken: "token-2",
            expiresAt: "2099-01-01T00:00:00.000Z",
        };
    };

    try {
        const response = await api.createSegmentedStreamingSession({
            trackId: "track-2",
            startupLoadId: Number.NaN,
            startupCorrelationId: "   ",
        });

        assert.equal(
            response.manifestUrl,
            "https://cdn.example.com/streaming/v1/sessions/session-2/manifest.mpd",
        );
    } finally {
        apiClient.request = originalRequest;
        apiClient.baseUrl = originalBaseUrl;
    }

    assert.equal(requestCalls.length, 1);
    assert.equal(requestCalls[0].endpoint, "/streaming/v1/sessions");
    assert.deepEqual(requestCalls[0].options, {
        method: "POST",
        body: JSON.stringify({
            trackId: "track-2",
            sourceType: undefined,
            desiredQuality: undefined,
        }),
        headers: {},
    });
});
