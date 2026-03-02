import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/lib/audio-engine", {
    namedExports: {
        createRuntimeAudioEngine: () => ({
            on: () => undefined,
            off: () => undefined,
            getCurrentTime: () => 0,
            getDuration: () => 0,
            isPlaying: () => false,
        }),
    },
});

function assertHookGuardError(
    render: () => string,
    expectedMessage: string,
): void {
    assert.throws(render, (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, expectedMessage);
        return true;
    });
}

test("useAudioControls throws when rendered outside provider", async () => {
    const { useAudioControls } = await import("../../lib/audio-controls-context.tsx");

    const HookProbe = () => {
        useAudioControls();
        return React.createElement("div", null, "ok");
    };

    assertHookGuardError(
        () => renderToStaticMarkup(React.createElement(HookProbe)),
        "useAudioControls must be used within AudioControlsProvider",
    );
});

test("useAudioControls resolves within provider stack", async () => {
    const { AudioStateProvider } = await import("../../lib/audio-state-context.tsx");
    const { AudioPlaybackProvider } = await import("../../lib/audio-playback-context.tsx");
    const { AudioControlsProvider, useAudioControls } = await import(
        "../../lib/audio-controls-context.tsx"
    );

    const capturedRef = { current: null as ReturnType<typeof useAudioControls> | null };
    const HookProbe = () => {
        capturedRef.current = useAudioControls();
        return React.createElement("div", null, "controls-ready");
    };

    const html = renderToStaticMarkup(
        React.createElement(
            AudioStateProvider,
            null,
            React.createElement(
                AudioPlaybackProvider,
                null,
                React.createElement(
                    AudioControlsProvider,
                    null,
                    React.createElement(HookProbe),
                ),
            ),
        ),
    );

    assert.ok(html.includes("controls-ready"));
    assert.ok(capturedRef.current);
    assert.equal(typeof capturedRef.current.playTrack, "function");
    assert.equal(typeof capturedRef.current.next, "function");
    assert.equal(typeof capturedRef.current.seek, "function");
});

test("audio-controls helper exports cover queue and listen-together session branches", async () => {
    const {
        resolveQueueNavigationIndex,
        resolveActiveListenTogetherSession,
        generateSeparatedShuffleIndices,
    } = await import("../../lib/audio-controls-context.tsx");

    assert.equal(
        resolveQueueNavigationIndex({
            action: "next",
            queueLength: 3,
            currentIndex: 1,
            isShuffle: false,
            shuffleIndices: [],
            repeatMode: "off",
        }),
        2,
    );
    assert.equal(
        resolveQueueNavigationIndex({
            action: "next",
            queueLength: 3,
            currentIndex: 2,
            isShuffle: false,
            shuffleIndices: [],
            repeatMode: "all",
        }),
        0,
    );
    assert.equal(
        resolveQueueNavigationIndex({
            action: "previous",
            queueLength: 3,
            currentIndex: 0,
            isShuffle: false,
            shuffleIndices: [],
            repeatMode: "all",
        }),
        null,
    );
    assert.equal(
        resolveQueueNavigationIndex({
            action: "next",
            queueLength: 3,
            currentIndex: 2,
            isShuffle: true,
            shuffleIndices: [2, 0, 1],
            repeatMode: "off",
        }),
        0,
    );
    assert.equal(
        resolveQueueNavigationIndex({
            action: "next",
            queueLength: 3,
            currentIndex: 1,
            isShuffle: true,
            shuffleIndices: [2, 0, 1],
            repeatMode: "all",
        }),
        2,
    );
    assert.equal(
        resolveQueueNavigationIndex({
            action: "previous",
            queueLength: 3,
            currentIndex: 0,
            isShuffle: true,
            shuffleIndices: [2, 0, 1],
            repeatMode: "off",
        }),
        2,
    );
    assert.equal(
        resolveQueueNavigationIndex({
            action: "next",
            queueLength: 3,
            currentIndex: 1,
            isShuffle: true,
            shuffleIndices: [0, 2],
            repeatMode: "off",
        }),
        null,
    );

    assert.equal(
        resolveActiveListenTogetherSession({
            hasActiveGroup: false,
            activeGroupId: "group-a",
            snapshot: null,
            nowMs: 1_234,
        }),
        null,
    );
    assert.equal(
        resolveActiveListenTogetherSession({
            hasActiveGroup: true,
            activeGroupId: null,
            snapshot: null,
            nowMs: 1_234,
        }),
        null,
    );
    assert.equal(
        resolveActiveListenTogetherSession({
            hasActiveGroup: true,
            activeGroupId: "group-a",
            snapshot: null,
            nowMs: 9_999,
        }),
        null,
    );
    const snapshot = {
        groupId: "group-a",
        isHost: true,
        playback: {
            isPlaying: true,
            positionMs: 321,
            serverTime: 4_567,
            currentIndex: 2,
        },
    };
    assert.equal(
        resolveActiveListenTogetherSession({
            hasActiveGroup: true,
            activeGroupId: "group-a",
            snapshot,
        }),
        snapshot,
    );
    assert.equal(
        resolveActiveListenTogetherSession({
            hasActiveGroup: true,
            activeGroupId: "group-a",
            snapshot: { ...snapshot, groupId: "group-b" },
            nowMs: 123,
        }),
        null,
    );

    const deterministic = generateSeparatedShuffleIndices({
        length: 4,
        currentIdx: 1,
        queue: [
            {
                id: "track-0",
                title: "Zero",
                duration: 1,
                artist: { name: "A", id: "artist-a" },
                album: { title: "Album A", id: "album-a" },
            },
            {
                id: "track-1",
                title: "One",
                duration: 1,
                artist: { name: "B", id: "artist-b" },
                album: { title: "Album B", id: "album-b" },
            },
            {
                id: "track-2",
                title: "Two",
                duration: 1,
                artist: { name: "C" },
                album: { title: "Album C" },
            },
            null,
        ],
        random: () => 0,
    });
    assert.equal(deterministic[0], 1);
    assert.equal(deterministic.length, 4);
    assert.equal(new Set(deterministic).size, 4);
    assert.equal(deterministic.includes(0), true);
    assert.equal(deterministic.includes(2), true);
    assert.equal(deterministic.includes(3), true);
});

test("useAudioPlayback throws when rendered outside provider", async () => {
    const { useAudioPlayback } = await import("../../lib/audio-playback-context.tsx");

    const HookProbe = () => {
        useAudioPlayback();
        return React.createElement("div", null, "ok");
    };

    assertHookGuardError(
        () => renderToStaticMarkup(React.createElement(HookProbe)),
        "useAudioPlayback must be used within AudioPlaybackProvider",
    );
});

test("useAudioPlayback resolves within provider stack", async () => {
    const { AudioStateProvider } = await import("../../lib/audio-state-context.tsx");
    const { AudioPlaybackProvider, useAudioPlayback } = await import(
        "../../lib/audio-playback-context.tsx"
    );

    const capturedRef = { current: null as ReturnType<typeof useAudioPlayback> | null };
    const HookProbe = () => {
        capturedRef.current = useAudioPlayback();
        return React.createElement("div", null, "playback-ready");
    };

    const html = renderToStaticMarkup(
        React.createElement(
            AudioStateProvider,
            null,
            React.createElement(
                AudioPlaybackProvider,
                null,
                React.createElement(HookProbe),
            ),
        ),
    );

    assert.ok(html.includes("playback-ready"));
    assert.ok(capturedRef.current);
    assert.equal(typeof capturedRef.current.setCurrentTime, "function");
    assert.equal(typeof capturedRef.current.setCurrentTimeFromEngine, "function");
    assert.equal(typeof capturedRef.current.clearAudioError, "function");
});

test("useListenTogether resolves within provider with deterministic mocked dependencies", async () => {
    const noop = () => undefined;
    const asyncNoop = async () => undefined;
    const audioStateStub = {
        queue: [] as Array<{ id: string; streamSource?: string }>,
        currentIndex: 0,
        currentTrack: null,
        playbackType: null,
        setPlaybackType: noop,
        setQueue: noop,
        setCurrentIndex: noop,
        setCurrentTrack: noop,
        setCurrentAudiobook: noop,
        setCurrentPodcast: noop,
        setIsShuffle: noop,
        setVibeMode: noop,
        setRepeatOneCount: noop,
    };
    const controlsStub = {
        resume: noop,
        pause: noop,
        seek: noop,
    };
    const listenTogetherSocketStub = {
        isConnected: false,
        hasActiveGroup: false,
        activeGroupId: null as string | null,
        probeRoute: async () => ({ ok: true }),
        connect: noop,
        disconnect: noop,
        on: noop,
        off: noop,
        reportReady: asyncNoop,
        play: asyncNoop,
        pause: asyncNoop,
        seek: asyncNoop,
        next: asyncNoop,
        previous: asyncNoop,
        setTrack: asyncNoop,
        addToQueue: asyncNoop,
        removeFromQueue: asyncNoop,
        clearQueue: asyncNoop,
    };

    mock.module("@/lib/auth-context", {
        namedExports: {
            useAuth: () => ({ isAuthenticated: false, user: null }),
        },
    });
    mock.module("@/lib/audio-state-context", {
        namedExports: {
            useAudioState: () => audioStateStub,
        },
    });
    mock.module("@/lib/audio-controls-context", {
        namedExports: {
            useAudioControls: () => controlsStub,
        },
    });
    mock.module("@/lib/listen-together-socket", {
        namedExports: {
            listenTogetherSocket: listenTogetherSocketStub,
        },
    });
    mock.module("@/lib/listen-together-session", {
        namedExports: {
            enqueueLatestListenTogetherHostTrackOperation: noop,
            getListenTogetherOptimisticTrackSelectionPolicy: () => ({
                resetPersistedTrackStartPosition: false,
                guardRemoteApply: true,
            }),
            getListenTogetherSessionSnapshot: () => null,
            requestListenTogetherGroupResync: asyncNoop,
            setListenTogetherMembershipPending: noop,
            setListenTogetherSessionSnapshot: noop,
        },
    });
    mock.module("@/lib/api", {
        namedExports: {
            api: {
                getMyListenGroup: async () => null,
                createListenGroup: async () => ({
                    id: "group-id",
                    hostUserId: "host-id",
                    playback: { stateVersion: 0 },
                }),
                joinListenGroup: async () => ({
                    id: "group-id",
                    hostUserId: "host-id",
                    playback: { stateVersion: 0 },
                }),
                leaveListenGroup: async () => undefined,
            },
        },
    });

    const {
        ListenTogetherProvider,
        useListenTogether,
        resolveListenTogetherMembershipPendingState,
        canIssueListenTogetherHostPlaybackCommand,
        resolveListenTogetherReadyReportRecoveryAction,
    } = await import(
        "../../lib/listen-together-context.tsx"
    );

    const capturedRef = { current: null as ReturnType<typeof useListenTogether> | null };
    const HookProbe = () => {
        capturedRef.current = useListenTogether();
        return React.createElement("div", null, "listen-together-ready");
    };

    const html = renderToStaticMarkup(
        React.createElement(
            ListenTogetherProvider,
            null,
            React.createElement(HookProbe),
        ),
    );

    assert.ok(html.includes("listen-together-ready"));
    assert.ok(capturedRef.current);
    assert.equal(capturedRef.current.isInGroup, false);
    assert.equal(capturedRef.current.socketRouteStatus, "checking");
    assert.equal(typeof capturedRef.current.syncNext, "function");
    assert.equal(typeof capturedRef.current.syncSetTrack, "function");

    assert.equal(resolveListenTogetherMembershipPendingState(null), false);
    assert.equal(resolveListenTogetherMembershipPendingState("create"), true);
    assert.equal(resolveListenTogetherMembershipPendingState("join"), true);

    const hostSnapshot = {
        groupId: "group-id",
        isHost: true,
        playback: {
            isPlaying: true,
            positionMs: 0,
            serverTime: 1,
            currentIndex: 0,
        },
    };
    assert.equal(
        canIssueListenTogetherHostPlaybackCommand({
            activeGroupId: "group-id",
            hostUserId: "host-id",
            userId: "host-id",
            snapshot: null,
        }),
        true,
    );
    assert.equal(
        canIssueListenTogetherHostPlaybackCommand({
            activeGroupId: "group-id",
            hostUserId: "host-id",
            userId: "listener-id",
            snapshot: hostSnapshot,
        }),
        false,
    );
    assert.equal(
        canIssueListenTogetherHostPlaybackCommand({
            activeGroupId: "group-id",
            hostUserId: "host-id",
            userId: null,
            snapshot: hostSnapshot,
        }),
        true,
    );
    assert.equal(
        canIssueListenTogetherHostPlaybackCommand({
            activeGroupId: "group-id",
            hostUserId: null,
            userId: "host-id",
            snapshot: hostSnapshot,
        }),
        true,
    );
    assert.equal(
        canIssueListenTogetherHostPlaybackCommand({
            activeGroupId: "group-id",
            hostUserId: "host-id",
            userId: null,
            snapshot: { ...hostSnapshot, groupId: "other-group" },
        }),
        false,
    );
    assert.equal(
        canIssueListenTogetherHostPlaybackCommand({
            activeGroupId: "group-id",
            hostUserId: null,
            userId: null,
            snapshot: { ...hostSnapshot, isHost: false },
        }),
        false,
    );

    assert.equal(
        resolveListenTogetherReadyReportRecoveryAction({
            elapsedMs: 100,
            maxWaitMs: 500,
            terminalRetryAttempted: false,
        }),
        "retry",
    );
    assert.equal(
        resolveListenTogetherReadyReportRecoveryAction({
            elapsedMs: 500,
            maxWaitMs: 500,
            terminalRetryAttempted: false,
        }),
        "terminal-retry",
    );
    assert.equal(
        resolveListenTogetherReadyReportRecoveryAction({
            elapsedMs: 900,
            maxWaitMs: 500,
            terminalRetryAttempted: true,
        }),
        "recover",
    );
});

test("useListenTogether throws when rendered outside provider", async () => {
    const { useListenTogether } = await import("../../lib/listen-together-context.tsx");

    const HookProbe = () => {
        useListenTogether();
        return React.createElement("div", null, "ok");
    };

    assertHookGuardError(
        () => renderToStaticMarkup(React.createElement(HookProbe)),
        "useListenTogether must be used within a ListenTogetherProvider",
    );
});
