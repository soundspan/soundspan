import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
    enqueueLatestListenTogetherHostTrackOperation,
    LISTEN_TOGETHER_MEMBERSHIP_PENDING_STORAGE_KEY,
    LISTEN_TOGETHER_SESSION_STORAGE_KEY,
    getListenTogetherOptimisticTrackSelectionPolicy,
    resolveListenTogetherFollowerGroupId,
    getListenTogetherSessionSnapshot,
    isListenTogetherActiveOrPending,
    isListenTogetherMembershipPending,
    requestListenTogetherGroupResync,
    setListenTogetherMembershipPending,
    setListenTogetherSessionSnapshot,
    type ListenTogetherSessionSnapshot,
} from "../../lib/listen-together-session";
import {
    listenTogetherSocket,
    type ListenTogetherSocketCallbacks,
} from "../../lib/listen-together-socket";
import { api } from "@/lib/api";
import {
    consumePlaybackAdvanceOrigin,
    isPlaybackAutoRestartSuppressed,
    playbackAdvanceOriginRef,
    setPlaybackAutoRestartSuppressed,
    writePlaybackAdvanceOrigin,
} from "@/lib/audio-engine/playbackAdvanceOrigin";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

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

    (globalScope as any).window = {
        localStorage: storage,
    };
    (globalScope as any).localStorage = storage;

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
        await Promise.resolve();
    }
    throw new Error(message);
}

function clearWindowStorage(): void {
    Reflect.deleteProperty(globalScope, "window");
    Reflect.deleteProperty(globalScope, "localStorage");
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
    playbackAdvanceOriginRef.current = null;
    setPlaybackAutoRestartSuppressed(false);
});

afterEach(() => {
    listenTogetherSocket.disconnect();
    setListenTogetherSessionSnapshot(null);
    setListenTogetherMembershipPending(false);
    playbackAdvanceOriginRef.current = null;
    setPlaybackAutoRestartSuppressed(false);

    if (typeof previousWindow === "undefined") {
        Reflect.deleteProperty(globalScope, "window");
    } else {
        (globalScope as any).window = previousWindow;
    }

    if (typeof previousLocalStorage === "undefined") {
        Reflect.deleteProperty(globalScope, "localStorage");
    } else {
        (globalScope as any).localStorage = previousLocalStorage;
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
            playback: {
                isPlaying: true,
                positionMs: 1,
                serverTime: 2,
                currentIndex: 3,
            },
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
    assert.equal(
        values.get(LISTEN_TOGETHER_MEMBERSHIP_PENDING_STORAGE_KEY),
        "1",
    );
    assert.equal(isListenTogetherMembershipPending(), true);

    setListenTogetherMembershipPending(false);
    assert.equal(
        values.has(LISTEN_TOGETHER_MEMBERSHIP_PENDING_STORAGE_KEY),
        false,
    );
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

test("resolveListenTogetherFollowerGroupId returns only follower session groups", () => {
    assert.equal(resolveListenTogetherFollowerGroupId(null), null);
    assert.equal(
        resolveListenTogetherFollowerGroupId({
            ...snapshot,
            isHost: true,
        }),
        null,
    );
    assert.equal(
        resolveListenTogetherFollowerGroupId({
            ...snapshot,
            isHost: false,
            groupId: "group-follower",
        }),
        "group-follower",
    );
});

test("requestListenTogetherGroupResync joins explicit target group", async () => {
    const originalJoinGroup = listenTogetherSocket.joinGroup;
    const joinedGroups: string[] = [];

    (
        listenTogetherSocket as unknown as {
            joinGroup: (groupId: string) => Promise<void>;
        }
    ).joinGroup = async (groupId: string) => {
        joinedGroups.push(groupId);
    };

    try {
        await requestListenTogetherGroupResync("group-explicit");
    } finally {
        (
            listenTogetherSocket as unknown as {
                joinGroup: (groupId: string) => Promise<void>;
            }
        ).joinGroup = originalJoinGroup.bind(listenTogetherSocket);
    }

    assert.deepEqual(joinedGroups, ["group-explicit"]);
});

test("requestListenTogetherGroupResync no-ops when no target group is available", async () => {
    const originalJoinGroup = listenTogetherSocket.joinGroup;
    const joinedGroups: string[] = [];

    (
        listenTogetherSocket as unknown as {
            joinGroup: (groupId: string) => Promise<void>;
        }
    ).joinGroup = async (groupId: string) => {
        joinedGroups.push(groupId);
    };

    try {
        await requestListenTogetherGroupResync();
    } finally {
        (
            listenTogetherSocket as unknown as {
                joinGroup: (groupId: string) => Promise<void>;
            }
        ).joinGroup = originalJoinGroup.bind(listenTogetherSocket);
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
        return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    socketState.currentGroupId = "group-retry";
    (listenTogetherSocket as unknown as { next: () => Promise<void> }).next =
        async () => {
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
        (
            globalThis as unknown as { setTimeout: typeof setTimeout }
        ).setTimeout = originalSetTimeout;
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
        return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    socketState.currentGroupId = null;
    (listenTogetherSocket as unknown as { next: () => Promise<void> }).next =
        async () => {
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
        (
            globalThis as unknown as { setTimeout: typeof setTimeout }
        ).setTimeout = originalSetTimeout;
    }

    assert.equal(attempts, 1);
    assert.deepEqual(delays, [120]);
});

test("host track operation retry callback runs through timer scheduling", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalNext = listenTogetherSocket.next;
    const socketState = listenTogetherSocket as unknown as {
        currentGroupId: string | null;
    };
    let scheduledRetry: (() => void) | undefined;
    let attempts = 0;

    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
        callback: (...args: unknown[]) => void,
    ) => {
        scheduledRetry = () => callback();
        return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    socketState.currentGroupId = "group-real-timer";
    (listenTogetherSocket as unknown as { next: () => Promise<void> }).next =
        async () => {
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
        await waitFor(
            () => typeof scheduledRetry === "function",
            "retry callback was not scheduled",
        );
        scheduledRetry?.();
        await waitFor(() => attempts === 2, "retry callback did not execute");
    } finally {
        (
            listenTogetherSocket as unknown as { next: () => Promise<void> }
        ).next = originalNext.bind(listenTogetherSocket);
        (
            globalThis as unknown as { setTimeout: typeof setTimeout }
        ).setTimeout = originalSetTimeout;
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
        listenTogetherSocket as unknown as {
            joinGroup: (groupId: string) => Promise<void>;
        }
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
            listenTogetherSocket as unknown as {
                joinGroup: (groupId: string) => Promise<void>;
            }
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
        listenTogetherSocket as unknown as {
            setTrack: (index: number) => Promise<void>;
        }
    ).setTrack = async () => {
        throw new Error("forced failure");
    };
    (
        listenTogetherSocket as unknown as {
            joinGroup: (groupId: string) => Promise<void>;
        }
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
            listenTogetherSocket as unknown as {
                setTrack: (index: number) => Promise<void>;
            }
        ).setTrack = originalSetTrack.bind(listenTogetherSocket);
        (
            listenTogetherSocket as unknown as {
                joinGroup: (groupId: string) => Promise<void>;
            }
        ).joinGroup = originalJoinGroup.bind(listenTogetherSocket);
    }

    assert.equal(joinAttempts, 1);
});

type MockTrack = {
    id: string;
    title: string;
    duration: number;
    artist: { id: string; name: string };
    album: { id: string; title: string; coverArt: string | null };
    mediaSource?: "local" | "tidal" | "youtube";
    streamSource?: "tidal" | "youtube" | "youtube-direct";
    youtubeVideoId?: string;
};

type MockGroupSnapshot = {
    id: string;
    name: string;
    joinCode: string;
    groupType: "host-follower";
    visibility: "private";
    isActive: boolean;
    hostUserId: string;
    syncState: "playing" | "waiting";
    playback: {
        queue: MockTrack[];
        currentIndex: number;
        isPlaying: boolean;
        positionMs: number;
        serverTime: number;
        stateVersion: number;
        trackId: string | null;
    };
    members: Array<{
        userId: string;
        username: string;
        isHost: boolean;
        joinedAt: string;
        isConnected: boolean;
    }>;
};

const providerAuthState = {
    userId: "host-id",
};
const providerApiState: { group: MockGroupSnapshot | null } = {
    group: null,
};
const providerSocketState = {
    callbacks: null as ListenTogetherSocketCallbacks | null,
    seekCalls: [] as number[],
    seekStateVersions: [] as Array<number | undefined>,
    reportReadyCalls: 0,
};
const providerEngineState = {
    currentTime: 0,
    duration: 180,
    playing: false,
    reloadCalls: 0,
    listeners: new Map<string, Set<() => void>>(),
};
const providerControlCalls = {
    seek: [] as number[],
    resume: 0,
    resumeOptions: [] as unknown[],
    pause: 0,
};
const providerAudioState = {
    queue: [] as MockTrack[],
    currentIndex: 0,
    currentTrack: null as MockTrack | null,
    playbackType: "track",
    setPlaybackType: (value: string) => {
        providerAudioState.playbackType = value;
    },
    setQueue: (queue: MockTrack[]) => {
        providerAudioState.queue = queue;
    },
    setCurrentIndex: (index: number) => {
        providerAudioState.currentIndex = index;
        providerAudioStateCalls.currentIndex.push(index);
    },
    setCurrentTrack: (track: MockTrack | null) => {
        providerAudioState.currentTrack = track;
        providerAudioStateCalls.currentTrack.push(track);
    },
    setCurrentAudiobook: () => undefined,
    setCurrentPodcast: () => undefined,
    setIsShuffle: () => undefined,
    setVibeMode: () => undefined,
};
const providerAudioStateCalls = {
    currentIndex: [] as number[],
    currentTrack: [] as Array<MockTrack | null>,
};

const providerPlaybackEngine = {
    on: (event: string, listener: () => void) => {
        const listeners =
            providerEngineState.listeners.get(event) ?? new Set<() => void>();
        listeners.add(listener);
        providerEngineState.listeners.set(event, listeners);
    },
    off: (event: string, listener: () => void) => {
        providerEngineState.listeners.get(event)?.delete(listener);
    },
    getCurrentTime: () => providerEngineState.currentTime,
    getDuration: () => providerEngineState.duration,
    isPlaying: () => providerEngineState.playing,
    reload: () => {
        providerEngineState.reloadCalls += 1;
    },
};

const providerControls = {
    seek: (positionSec: number) => {
        providerControlCalls.seek.push(positionSec);
        providerEngineState.currentTime = positionSec;
    },
    resume: (options?: unknown) => {
        providerControlCalls.resume += 1;
        providerControlCalls.resumeOptions.push(options);
        providerEngineState.playing = true;
    },
    pause: () => {
        providerControlCalls.pause += 1;
        providerEngineState.playing = false;
    },
};

type ProviderSocketStub = {
    isConnected: boolean;
    probeRoute: typeof listenTogetherSocket.probeRoute;
    connect: typeof listenTogetherSocket.connect;
    disconnect: typeof listenTogetherSocket.disconnect;
    joinGroup: typeof listenTogetherSocket.joinGroup;
    reportReady: typeof listenTogetherSocket.reportReady;
    play: typeof listenTogetherSocket.play;
    pause: typeof listenTogetherSocket.pause;
    seek: typeof listenTogetherSocket.seek;
    next: typeof listenTogetherSocket.next;
    previous: typeof listenTogetherSocket.previous;
    setTrack: typeof listenTogetherSocket.setTrack;
    addToQueue: typeof listenTogetherSocket.addToQueue;
    removeFromQueue: typeof listenTogetherSocket.removeFromQueue;
    clearQueue: typeof listenTogetherSocket.clearQueue;
};

const providerSocket: ProviderSocketStub = {
    isConnected: false,
    probeRoute: async () => ({ ok: true }),
    connect: (callbacks) => {
        providerSocketState.callbacks = callbacks;
    },
    disconnect: () => {
        providerSocket.isConnected = false;
    },
    joinGroup: async () => undefined,
    reportReady: async () => {
        providerSocketState.reportReadyCalls += 1;
    },
    play: async () => undefined,
    pause: async () => undefined,
    seek: async (positionMs: number, stateVersion?: number) => {
        providerSocketState.seekCalls.push(positionMs);
        providerSocketState.seekStateVersions.push(stateVersion);
    },
    next: async () => undefined,
    previous: async () => undefined,
    setTrack: async () => undefined,
    addToQueue: async (tracks) => ({
        acceptedCount: tracks.length,
        skippedCount: 0,
        truncated: false,
    }),
    removeFromQueue: async () => undefined,
    clearQueue: async () => undefined,
};

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({
            isAuthenticated: true,
            user: { id: providerAuthState.userId },
        }),
    },
});
mock.module("@/lib/audio-state-context", {
    namedExports: { useAudioState: () => providerAudioState },
});
mock.module("@/lib/audio-controls-context", {
    namedExports: { useAudioControls: () => providerControls },
});
mock.module("@/lib/audio-engine", {
    namedExports: {
        createRuntimeAudioEngine: () => providerPlaybackEngine,
    },
});
mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: () => undefined,
            info: () => undefined,
            warn: () => undefined,
        },
    },
});

const originalProviderSocketMethods = {
    probeRoute: listenTogetherSocket.probeRoute,
    connect: listenTogetherSocket.connect,
    disconnect: listenTogetherSocket.disconnect,
    joinGroup: listenTogetherSocket.joinGroup,
    reportReady: listenTogetherSocket.reportReady,
    play: listenTogetherSocket.play,
    pause: listenTogetherSocket.pause,
    seek: listenTogetherSocket.seek,
    next: listenTogetherSocket.next,
    previous: listenTogetherSocket.previous,
    setTrack: listenTogetherSocket.setTrack,
    addToQueue: listenTogetherSocket.addToQueue,
    removeFromQueue: listenTogetherSocket.removeFromQueue,
    clearQueue: listenTogetherSocket.clearQueue,
};
const originalProviderSocketConnectedDescriptor =
    Object.getOwnPropertyDescriptor(listenTogetherSocket, "isConnected");
const providerApi = api as unknown as {
    getMyListenGroup: () => Promise<MockGroupSnapshot | null>;
};
const originalGetMyListenGroup = providerApi.getMyListenGroup;
let providerBoundaryStubsInstalled = false;

function installProviderBoundaryStubs(): void {
    if (providerBoundaryStubsInstalled) return;
    providerBoundaryStubsInstalled = true;
    const socket = listenTogetherSocket as unknown as typeof providerSocket;
    // Delegate dynamically so tests can swap the probe stub mid-test.
    socket.probeRoute = (
        ...args: Parameters<typeof providerSocket.probeRoute>
    ) => providerSocket.probeRoute(...args);
    socket.connect = providerSocket.connect;
    socket.disconnect = providerSocket.disconnect;
    socket.joinGroup = providerSocket.joinGroup;
    socket.reportReady = providerSocket.reportReady;
    socket.play = providerSocket.play;
    socket.pause = providerSocket.pause;
    socket.seek = providerSocket.seek;
    socket.next = providerSocket.next;
    socket.previous = providerSocket.previous;
    socket.setTrack = providerSocket.setTrack;
    socket.addToQueue = providerSocket.addToQueue;
    socket.removeFromQueue = providerSocket.removeFromQueue;
    socket.clearQueue = providerSocket.clearQueue;
    Object.defineProperty(listenTogetherSocket, "isConnected", {
        configurable: true,
        get: () => providerSocket.isConnected,
    });
    providerApi.getMyListenGroup = async () => providerApiState.group;
}

after(() => {
    if (!providerBoundaryStubsInstalled) return;
    const socket = listenTogetherSocket as unknown as typeof providerSocket;
    socket.probeRoute =
        originalProviderSocketMethods.probeRoute.bind(listenTogetherSocket);
    socket.connect =
        originalProviderSocketMethods.connect.bind(listenTogetherSocket);
    socket.disconnect =
        originalProviderSocketMethods.disconnect.bind(listenTogetherSocket);
    socket.joinGroup =
        originalProviderSocketMethods.joinGroup.bind(listenTogetherSocket);
    socket.reportReady =
        originalProviderSocketMethods.reportReady.bind(listenTogetherSocket);
    socket.play = originalProviderSocketMethods.play.bind(listenTogetherSocket);
    socket.pause =
        originalProviderSocketMethods.pause.bind(listenTogetherSocket);
    socket.seek = originalProviderSocketMethods.seek.bind(listenTogetherSocket);
    socket.next = originalProviderSocketMethods.next.bind(listenTogetherSocket);
    socket.previous =
        originalProviderSocketMethods.previous.bind(listenTogetherSocket);
    socket.setTrack =
        originalProviderSocketMethods.setTrack.bind(listenTogetherSocket);
    socket.addToQueue =
        originalProviderSocketMethods.addToQueue.bind(listenTogetherSocket);
    socket.removeFromQueue =
        originalProviderSocketMethods.removeFromQueue.bind(
            listenTogetherSocket,
        );
    socket.clearQueue =
        originalProviderSocketMethods.clearQueue.bind(listenTogetherSocket);
    if (originalProviderSocketConnectedDescriptor) {
        Object.defineProperty(
            listenTogetherSocket,
            "isConnected",
            originalProviderSocketConnectedDescriptor,
        );
    } else {
        delete (listenTogetherSocket as unknown as { isConnected?: boolean })
            .isConnected;
    }
    providerApi.getMyListenGroup = originalGetMyListenGroup;
});
mock.module("sonner", {
    namedExports: {
        toast: {
            error: () => undefined,
            info: () => undefined,
            success: () => undefined,
        },
    },
});

function makeTrack(id: string): MockTrack {
    return {
        id,
        title: `Track ${id}`,
        duration: 180,
        artist: { id: "artist-id", name: "Artist" },
        album: { id: "album-id", title: "Album", coverArt: null },
        mediaSource: "youtube",
        streamSource: "youtube",
        youtubeVideoId: `video-${id}`,
    };
}

function makeGroup(isHost: boolean, currentIndex: number): MockGroupSnapshot {
    const queue = [makeTrack("remote-0"), makeTrack("remote-1")];
    return {
        id: "group-provider",
        name: "Provider group",
        joinCode: "ABC123",
        groupType: "host-follower",
        visibility: "private",
        isActive: true,
        hostUserId: "host-id",
        syncState: "playing",
        playback: {
            queue,
            currentIndex,
            isPlaying: true,
            positionMs: 0,
            serverTime: Date.now(),
            stateVersion: 1,
            trackId: queue[currentIndex]?.id ?? null,
        },
        members: [
            {
                userId: "host-id",
                username: "Host",
                isHost: true,
                joinedAt: "2026-01-01T00:00:00.000Z",
                isConnected: true,
            },
            {
                userId: "guest-id",
                username: "Guest",
                isHost: false,
                joinedAt: "2026-01-01T00:00:00.000Z",
                isConnected: true,
            },
        ],
    };
}

function resetProviderHarness(isHost: boolean, currentIndex: number): void {
    const group = makeGroup(isHost, currentIndex);
    providerAuthState.userId = isHost ? "host-id" : "guest-id";
    providerApiState.group = group;
    providerSocket.isConnected = false;
    providerSocket.probeRoute = async () => ({ ok: true });
    providerSocketState.callbacks = null;
    providerSocketState.seekCalls = [];
    providerSocketState.seekStateVersions = [];
    providerSocketState.reportReadyCalls = 0;
    providerEngineState.currentTime = 0;
    providerEngineState.duration = 180;
    providerEngineState.playing = false;
    providerEngineState.reloadCalls = 0;
    providerEngineState.listeners.clear();
    providerControlCalls.seek = [];
    providerControlCalls.resume = 0;
    providerControlCalls.resumeOptions = [];
    providerControlCalls.pause = 0;
    providerAudioState.queue = group.playback.queue;
    providerAudioState.currentIndex = currentIndex;
    providerAudioState.currentTrack =
        group.playback.queue[currentIndex] ?? null;
    providerAudioState.playbackType = "track";
    providerAudioStateCalls.currentIndex = [];
    providerAudioStateCalls.currentTrack = [];
}

function getProviderGroup(): MockGroupSnapshot {
    assert.ok(providerApiState.group, "provider group fixture is missing");
    return providerApiState.group;
}

function restoreBrowserGlobals(): void {
    (globalScope as any).window = previousWindow;
    (globalScope as any).localStorage = previousLocalStorage;
}

function emitProviderEngineLoad(): void {
    const listeners = [
        ...(providerEngineState.listeners.get("load") ?? new Set()),
    ];
    for (const listener of listeners) {
        listener();
    }
}

type ListenTogetherApi = ReturnType<
    typeof import("../../lib/listen-together-context").useListenTogether
>;

async function mountListenTogetherProvider(
    isHost: boolean,
    currentIndex: number,
    options?: { connect?: boolean },
) {
    const connect = options?.connect ?? true;
    installProviderBoundaryStubs();
    resetProviderHarness(isHost, currentIndex);
    restoreBrowserGlobals();
    if (!connect) {
        // Mount with a failing route probe: the group is retained but no
        // socket connection is made (recheckSocketRoute makes the first one).
        providerSocket.probeRoute = async () => ({
            ok: false,
            reason: "probe-failed",
            status: 502,
        });
    }
    const { ListenTogetherProvider, useListenTogether } =
        await import("../../lib/listen-together-context");
    const { createRoot } = await import("react-dom/client");
    const latestRef: { current: ListenTogetherApi | null } = { current: null };

    function Probe() {
        latestRef.current = useListenTogether();
        return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                ListenTogetherProvider,
                null,
                React.createElement(Probe),
            ),
        );
    });
    if (connect) {
        await React.act(async () => {
            await waitFor(
                () => providerSocketState.callbacks !== null,
                "provider socket callbacks were not registered",
            );
        });
        providerSocket.isConnected = true;
        await React.act(async () => {
            providerSocketState.callbacks?.onConnect();
        });
    }

    return {
        latest: () => {
            assert.ok(
                latestRef.current,
                "listen-together context did not render",
            );
            return latestRef.current;
        },
        callbacks: () => {
            assert.ok(
                providerSocketState.callbacks,
                "socket callbacks missing",
            );
            return providerSocketState.callbacks;
        },
        act: async (action: () => void | Promise<void>) => {
            await React.act(async () => {
                await action();
            });
        },
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

test("ready-gated play-at resumes hosts without seeking and followers with a compensated seek", async (t) => {
    t.mock.method(Date, "now", () => 100_000);
    const host = await mountListenTogetherProvider(true, 0);
    await host.act(() => host.callbacks().onGroupState(getProviderGroup()));
    await host.act(() => host.latest().syncSetTrack(1));
    const waitingHostSnapshot = {
        ...makeGroup(true, 1),
        syncState: "waiting" as const,
        playback: {
            ...makeGroup(true, 1).playback,
            isPlaying: false,
            stateVersion: 2,
        },
    };
    await host.act(() => host.callbacks().onGroupState(waitingHostSnapshot));
    assert.equal(providerEngineState.playing, false);

    providerControlCalls.seek = [];
    providerControlCalls.resume = 0;
    providerControlCalls.resumeOptions = [];

    await host.act(() =>
        host.callbacks().onPlayAt({
            positionMs: 0,
            serverTime: 98_000,
            stateVersion: 3,
        }),
    );

    assert.deepEqual(providerControlCalls.seek, []);
    assert.equal(providerControlCalls.resume, 1);
    assert.deepEqual(providerControlCalls.resumeOptions, [
        { suppressListenTogetherBroadcast: true },
    ]);
    assert.equal(providerEngineState.playing, true);
    await host.unmount();

    const guest = await mountListenTogetherProvider(false, 1);
    await guest.act(() => guest.callbacks().onGroupState(getProviderGroup()));
    const waitingGuestSnapshot = {
        ...makeGroup(false, 1),
        syncState: "waiting" as const,
        playback: {
            ...makeGroup(false, 1).playback,
            isPlaying: false,
            stateVersion: 2,
        },
    };
    await guest.act(() => guest.callbacks().onGroupState(waitingGuestSnapshot));
    assert.equal(providerEngineState.playing, false);
    providerControlCalls.seek = [];
    providerControlCalls.resume = 0;

    await guest.act(() =>
        guest.callbacks().onPlayAt({
            positionMs: 0,
            serverTime: 98_000,
            stateVersion: 3,
        }),
    );

    assert.deepEqual(providerControlCalls.seek, [2]);
    assert.equal(providerControlCalls.resume, 1);
    assert.equal(providerEngineState.currentTime, 2);
    await guest.unmount();
});

test("play-at leaves an already-playing optimistic host selection alone", async (t) => {
    t.mock.method(Date, "now", () => 100_000);
    const host = await mountListenTogetherProvider(true, 0);
    t.after(host.unmount);
    await host.act(() => host.callbacks().onGroupState(getProviderGroup()));
    await host.act(() => host.latest().syncSetTrack(1));
    providerControlCalls.seek = [];
    providerControlCalls.resume = 0;

    await host.act(() =>
        host.callbacks().onPlayAt({
            positionMs: 0,
            serverTime: 98_000,
            stateVersion: 2,
        }),
    );

    assert.deepEqual(providerControlCalls.seek, []);
    assert.equal(providerControlCalls.resume, 0);
    assert.equal(providerEngineState.playing, true);
});

test("initial host hydration adopts group position once before ignoring delta echoes", async (t) => {
    t.mock.method(Date, "now", () => 100_000);
    const host = await mountListenTogetherProvider(true, 0);
    t.after(host.unmount);
    const hydrated = {
        ...makeGroup(true, 0),
        playback: {
            ...makeGroup(true, 0).playback,
            positionMs: 20_000,
            serverTime: 95_000,
        },
    };

    await host.act(() => host.callbacks().onGroupState(hydrated));

    assert.deepEqual(providerControlCalls.seek, [25]);
    providerEngineState.currentTime = 33;
    await host.act(() =>
        host.callbacks().onPlaybackDelta({
            isPlaying: true,
            positionMs: 50_000,
            serverTime: 100_000,
            stateVersion: 2,
            currentIndex: 0,
            trackId: "remote-0",
        }),
    );

    assert.deepEqual(providerControlCalls.seek, [25]);
    assert.equal(providerEngineState.currentTime, 33);
});

test("host hydration seeks even when the target sits inside the drift threshold", async (t) => {
    t.mock.method(Date, "now", () => 100_000);
    const host = await mountListenTogetherProvider(true, 0);
    t.after(host.unmount);
    const nearZero = {
        ...makeGroup(true, 0),
        playback: {
            ...makeGroup(true, 0).playback,
            positionMs: 1_200,
            serverTime: 100_000,
        },
    };

    await host.act(() => host.callbacks().onGroupState(nearZero));

    // Engine sits at 0 and the 1.2s target is inside the 1.5s follower
    // threshold; an adopting host must still take the group position or its
    // zeroed local timeline becomes authoritative on the next heartbeat.
    assert.deepEqual(providerControlCalls.seek, [1.2]);
});

test("re-check after a failed mount probe still hydrates the host position", async (t) => {
    t.mock.method(Date, "now", () => 100_000);
    const host = await mountListenTogetherProvider(true, 0, { connect: false });
    t.after(host.unmount);
    assert.equal(providerSocketState.callbacks, null);

    providerSocket.probeRoute = async () => ({ ok: true });
    await host.act(async () => {
        assert.equal(await host.latest().recheckSocketRoute(), true);
    });
    providerSocket.isConnected = true;
    await host.act(() => host.callbacks().onConnect());
    const hydrated = {
        ...makeGroup(true, 0),
        playback: {
            ...makeGroup(true, 0).playback,
            positionMs: 20_000,
            serverTime: 95_000,
        },
    };
    await host.act(() => host.callbacks().onGroupState(hydrated));

    // This re-check made the session's FIRST connection: the restored host
    // must adopt the compensated group position, not stay at 0.
    assert.deepEqual(providerControlCalls.seek, [25]);
});

test("live-session re-check reconnect never adopts the server position onto the host", async (t) => {
    t.mock.method(Date, "now", () => 100_000);
    // Start with a session that has NEVER connected, so a stale pre-await
    // adoption decision would read "adopt". The first connection then happens
    // DURING the deferred probe; the post-probe connectSocket must see it.
    const host = await mountListenTogetherProvider(true, 0, { connect: false });
    t.after(host.unmount);

    let releaseProbe: (() => void) | null = null;
    providerSocket.probeRoute = async () => {
        await new Promise<void>((resolve) => {
            releaseProbe = resolve;
        });
        return { ok: true };
    };
    await host.act(async () => {
        const pending = host.latest().recheckSocketRoute();
        await waitFor(() => releaseProbe !== null, "probe never started");

        // While the probe is pending: a racing path completes the session's
        // first connection lifecycle, then the socket drops again.
        providerSocket.probeRoute = async () => ({ ok: true });
        assert.equal(await host.latest().recheckSocketRoute(), true);
        providerSocket.isConnected = true;
        host.callbacks().onConnect();
        providerSocket.isConnected = false;

        providerEngineState.currentTime = 42;
        providerEngineState.playing = true;
        providerControlCalls.seek = [];

        releaseProbe?.();
        assert.equal(await pending, true);
    });
    const staleSnapshot = {
        ...makeGroup(true, 0),
        playback: {
            ...makeGroup(true, 0).playback,
            positionMs: 20_000,
            serverTime: 95_000,
            stateVersion: 5,
        },
    };
    await host.act(() => host.callbacks().onGroupState(staleSnapshot));

    // The deferred re-check's connectSocket ran AFTER the first connection:
    // it must read the ref at call time and not re-arm adoption, keeping the
    // host's live local timeline authoritative over the stale snapshot.
    assert.deepEqual(providerControlCalls.seek, []);
    assert.equal(providerEngineState.currentTime, 42);
});

test("reconnect recovery restores host position and compensates follower position", async (t) => {
    t.mock.method(Date, "now", () => 100_000);
    const reconnectSnapshot = {
        ...makeGroup(true, 0),
        playback: {
            ...makeGroup(true, 0).playback,
            positionMs: 20_000,
            serverTime: 95_000,
            stateVersion: 2,
        },
    };
    const host = await mountListenTogetherProvider(true, 0);
    await host.act(() => host.callbacks().onGroupState(getProviderGroup()));
    providerControlCalls.seek = [];
    providerControlCalls.resume = 0;
    providerControlCalls.resumeOptions = [];
    providerEngineState.currentTime = 42;
    providerEngineState.playing = true;

    await host.act(() => {
        host.callbacks().onReconnect?.(1);
        host.callbacks().onConnect();
        host.callbacks().onGroupState(reconnectSnapshot);
    });

    assert.equal(providerEngineState.reloadCalls, 1);
    assert.equal(providerEngineState.currentTime, 42);
    await host.act(() => emitProviderEngineLoad());
    assert.deepEqual(providerControlCalls.seek, [42]);
    assert.deepEqual(providerControlCalls.resumeOptions, [
        { suppressListenTogetherBroadcast: true },
    ]);
    await host.unmount();

    const guest = await mountListenTogetherProvider(false, 0);
    t.after(guest.unmount);
    await guest.act(() => guest.callbacks().onGroupState(getProviderGroup()));
    providerEngineState.currentTime = 42;
    providerEngineState.playing = true;
    await guest.act(() => {
        guest.callbacks().onReconnect?.(1);
        guest.callbacks().onConnect();
        guest.callbacks().onGroupState(reconnectSnapshot);
    });
    const seeksBeforeReload = providerControlCalls.seek.length;

    assert.equal(providerEngineState.reloadCalls, 1);
    await guest.act(() => emitProviderEngineLoad());
    assert.equal(providerControlCalls.seek.length, seeksBeforeReload + 1);
    assert.equal(providerControlCalls.seek.at(-1), 25);
    assert.equal(providerEngineState.currentTime, 25);
});

test("host playback-delta echoes preserve local position while followers seek", async (t) => {
    const host = await mountListenTogetherProvider(true, 0);
    providerEngineState.playing = true;
    providerEngineState.currentTime = 10;
    providerControlCalls.seek = [];

    await host.act(() =>
        host.callbacks().onPlaybackDelta({
            isPlaying: true,
            positionMs: 15_000,
            serverTime: Date.now() + 1_000,
            stateVersion: 2,
            currentIndex: 0,
            trackId: "remote-0",
        }),
    );

    assert.deepEqual(providerControlCalls.seek, []);
    assert.equal(providerEngineState.currentTime, 10);
    await host.unmount();

    const guest = await mountListenTogetherProvider(false, 0);
    t.after(guest.unmount);
    providerEngineState.playing = true;
    providerEngineState.currentTime = 10;
    providerControlCalls.seek = [];

    await guest.act(() =>
        guest.callbacks().onPlaybackDelta({
            isPlaying: true,
            positionMs: 15_000,
            serverTime: Date.now() + 1_000,
            stateVersion: 2,
            currentIndex: 0,
            trackId: "remote-0",
        }),
    );

    assert.deepEqual(providerControlCalls.seek, [15]);
    assert.equal(providerEngineState.currentTime, 15);
});

test("tripped followers suppress heartbeat restarts until a track-changing delta arrives", async (t) => {
    const guest = await mountListenTogetherProvider(false, 0);
    t.after(guest.unmount);
    providerEngineState.playing = false;
    providerEngineState.currentTime = 5;
    providerControlCalls.resume = 0;
    setPlaybackAutoRestartSuppressed(true);

    await guest.act(() =>
        guest.callbacks().onPlaybackDelta({
            isPlaying: true,
            positionMs: 5_000,
            serverTime: Date.now(),
            stateVersion: 2,
            currentIndex: 0,
            trackId: "remote-0",
        }),
    );
    await guest.act(() =>
        guest.callbacks().onPlaybackDelta({
            isPlaying: true,
            positionMs: 10_000,
            serverTime: Date.now(),
            stateVersion: 3,
            currentIndex: 0,
            trackId: "remote-0",
        }),
    );

    assert.equal(providerControlCalls.resume, 0);
    assert.equal(isPlaybackAutoRestartSuppressed(), true);

    await guest.act(() =>
        guest.callbacks().onPlaybackDelta({
            isPlaying: true,
            positionMs: 0,
            serverTime: Date.now(),
            stateVersion: 4,
            currentIndex: 1,
            trackId: "remote-1",
        }),
    );

    assert.equal(providerAudioState.currentTrack?.id, "remote-1");
    assert.equal(providerControlCalls.resume, 1);
    assert.equal(isPlaybackAutoRestartSuppressed(), false);
    assert.deepEqual(consumePlaybackAdvanceOrigin(), {
        origin: "manual",
        originatingTrackId: "remote-0",
    });
});

test("follower error-resync track changes consume their marker without a reset", async (t) => {
    const guest = await mountListenTogetherProvider(false, 0);
    t.after(guest.unmount);
    writePlaybackAdvanceOrigin("error", "remote-0");

    await guest.act(() =>
        guest.callbacks().onPlaybackDelta({
            isPlaying: true,
            positionMs: 0,
            serverTime: Date.now(),
            stateVersion: 2,
            currentIndex: 1,
            trackId: "remote-1",
        }),
    );

    assert.equal(providerAudioState.currentTrack?.id, "remote-1");
    assert.equal(providerControlCalls.resume, 1);
    assert.equal(consumePlaybackAdvanceOrigin(), null);
});

test("remote-apply guards clear without animation frames so host heartbeats continue", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () =>
        0 as unknown as ReturnType<typeof requestAnimationFrame>;
    t.after(() => {
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    });
    const host = await mountListenTogetherProvider(true, 0);
    t.after(host.unmount);
    providerEngineState.playing = true;
    providerEngineState.currentTime = 12.5;

    await host.act(() =>
        host.callbacks().onPlaybackDelta({
            isPlaying: true,
            positionMs: 12_500,
            serverTime: Date.now(),
            stateVersion: 2,
            currentIndex: 0,
            trackId: "remote-0",
        }),
    );
    t.mock.timers.tick(5_000);

    assert.deepEqual(providerSocketState.seekCalls, [12_500]);
    assert.deepEqual(providerSocketState.seekStateVersions, [2]);
});

test("availability remaps update queue identity idempotently and preserve swap position", async (t) => {
    const host = await mountListenTogetherProvider(true, 0);
    t.after(host.unmount);
    providerAudioState.currentTrack = {
        ...makeTrack("local-0"),
        mediaSource: "local",
        streamSource: undefined,
    };
    providerAudioStateCalls.currentIndex = [];
    providerAudioStateCalls.currentTrack = [];
    const onAvailability = host.callbacks().onAvailability;
    assert.ok(onAvailability);

    await host.act(() =>
        onAvailability({
            availability: [
                {
                    queueIndex: 0,
                    available: true,
                    source: "local",
                    localTrackId: "local-0",
                },
            ],
            stateVersion: 1,
        }),
    );

    assert.equal(providerAudioState.queue[0]?.id, "local-0");
    assert.deepEqual(providerAudioStateCalls.currentIndex, []);
    assert.deepEqual(providerAudioStateCalls.currentTrack, []);

    providerEngineState.currentTime = 37.25;
    providerControlCalls.seek = [];
    await host.act(() =>
        onAvailability({
            availability: [
                {
                    queueIndex: 0,
                    available: true,
                    source: "local",
                    localTrackId: "local-1",
                },
            ],
            stateVersion: 1,
        }),
    );

    assert.equal(providerAudioState.currentTrack?.id, "local-1");
    assert.deepEqual(providerControlCalls.seek, []);
    await host.act(() => emitProviderEngineLoad());
    assert.deepEqual(providerControlCalls.seek, [37.25]);
});

test("engine load reports ready without waiting for the polling timer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const host = await mountListenTogetherProvider(true, 0);
    t.after(host.unmount);

    await host.act(() =>
        host.callbacks().onWaiting({
            trackId: "remote-0",
            currentIndex: 0,
        }),
    );
    assert.equal(providerSocketState.reportReadyCalls, 0);

    await host.act(() => emitProviderEngineLoad());

    assert.equal(providerSocketState.reportReadyCalls, 1);
});
