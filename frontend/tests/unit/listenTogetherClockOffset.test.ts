import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    AudioControlsProvider,
    useAudioControls,
} from "../../lib/audio-controls-context";
import { AudioPlaybackProvider } from "../../lib/audio-playback-context";
import { audioSeekEmitter } from "../../lib/audio-seek-emitter";
import { AudioStateProvider } from "../../lib/audio-state-context";
import {
    getServerClockOffsetMs,
    ListenTogetherSocket,
    listenTogetherSocket,
    type ListenTogetherSocketCallbacks,
} from "../../lib/listen-together-socket";
import { setListenTogetherSessionSnapshot } from "../../lib/listen-together-session";

type SocketHandler = (...args: unknown[]) => void;
type SocketDependencies = NonNullable<
    ConstructorParameters<typeof ListenTogetherSocket>[0]
>;
const MAX_TEST_CLOCK_SAMPLES = 5;

class FakeSocket {
    connected = true;
    auth: Record<string, unknown> = {};
    readonly io = { on: () => undefined };
    private readonly handlers = new Map<string, SocketHandler>();

    constructor(private readonly serverTimesMs: number[]) {}

    on(event: string, handler: SocketHandler): this {
        this.handlers.set(event, handler);
        return this;
    }

    emit(event: string, ...args: unknown[]): this {
        if (event !== "lt-ping") return this;
        const ack = args.at(-1);
        assert.equal(typeof ack, "function");
        const serverTime = this.serverTimesMs.shift();
        assert.notEqual(serverTime, undefined);
        (ack as (response: { serverTime: number }) => void)({ serverTime });
        return this;
    }

    trigger(event: string, ...args: unknown[]): void {
        const handler = this.handlers.get(event);
        assert.ok(handler, `missing ${event} handler`);
        handler(...args);
    }

    connect(): this {
        this.connected = true;
        return this;
    }

    disconnect(): this {
        this.connected = false;
        return this;
    }

    removeAllListeners(): this {
        this.handlers.clear();
        return this;
    }
}

const callbacks: ListenTogetherSocketCallbacks = {
    onGroupState: () => undefined,
    onPlaybackDelta: () => undefined,
    onQueueDelta: () => undefined,
    onWaiting: () => undefined,
    onPlayAt: () => undefined,
    onMemberJoined: () => undefined,
    onMemberLeft: () => undefined,
    onGroupEnded: () => undefined,
    onConnect: () => undefined,
    onDisconnect: () => undefined,
    onError: () => undefined,
};

function createClockSampler(options: {
    localTimesMs: number[];
    serverTimesMs: number[];
}): {
    socket: ListenTogetherSocket;
    fakeSocket: FakeSocket;
    sampleAgain: () => void;
} {
    const localTimesMs = [...options.localTimesMs];
    const fakeSocket = new FakeSocket([...options.serverTimesMs]);
    let intervalCallback: (() => void) | null = null;
    const dependencies: SocketDependencies = {
        createSocket: (() =>
            fakeSocket) as unknown as SocketDependencies["createSocket"],
        getToken: () => "test-token",
        now: () => {
            const now = localTimesMs.shift();
            assert.notEqual(now, undefined);
            return now;
        },
        setInterval: (callback) => {
            intervalCallback = callback;
            return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: () => {
            intervalCallback = null;
        },
    };
    const socket = new ListenTogetherSocket(dependencies);
    socket.connect(callbacks);
    fakeSocket.trigger("connect");
    return {
        socket,
        fakeSocket,
        sampleAgain: () => {
            assert.ok(intervalCallback);
            intervalCallback();
        },
    };
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

async function sampleClockOffset(options: {
    clientOffsetMs: number;
    sampleCount?: number;
}): Promise<{ socket: ListenTogetherSocket; fakeSocket: FakeSocket }> {
    const sampleCount = options.sampleCount ?? 1;
    assert.ok(sampleCount > 0 && sampleCount <= MAX_TEST_CLOCK_SAMPLES);
    const localTimesMs: number[] = [];
    const serverTimesMs: number[] = [];
    for (let sample = 0; sample < MAX_TEST_CLOCK_SAMPLES; sample += 1) {
        if (sample >= sampleCount) break;
        const serverSendTimeMs = 10_000 + sample * 1_000;
        localTimesMs.push(
            serverSendTimeMs + options.clientOffsetMs,
            serverSendTimeMs + 100 + options.clientOffsetMs,
        );
        serverTimesMs.push(serverSendTimeMs + 50);
    }

    const sampler = createClockSampler({ localTimesMs, serverTimesMs });
    await flushPromises();
    for (let sample = 1; sample < MAX_TEST_CLOCK_SAMPLES; sample += 1) {
        if (sample >= sampleCount) break;
        sampler.sampleAgain();
        await flushPromises();
    }
    return sampler;
}

async function captureResumeTarget(options: {
    clientNowMs: number;
    serverTimeMs: number;
}): Promise<number> {
    await prepareFollowerSession(options.serverTimeMs);
    const controls = renderAudioControls();
    return invokeResumeAndCapture(controls, options);
}

async function prepareFollowerSession(serverTimeMs: number): Promise<void> {
    await listenTogetherSocket.joinGroup("group-clock-test").catch(() => {});
    setListenTogetherSessionSnapshot({
        groupId: "group-clock-test",
        isHost: false,
        playback: {
            isPlaying: true,
            positionMs: 2_000,
            serverTime: serverTimeMs,
            currentIndex: 0,
        },
    });
}

function renderAudioControls(): ReturnType<typeof useAudioControls> {
    let controls: ReturnType<typeof useAudioControls> | null = null;
    const Probe = () => {
        controls = useAudioControls();
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
                    React.createElement(Probe),
                ),
            ),
        ),
    );
    assert.ok(html.includes("controls-ready"));
    assert.ok(controls);
    return controls;
}

function invokeResumeAndCapture(
    controls: ReturnType<typeof useAudioControls>,
    options: { clientNowMs: number; serverTimeMs: number },
): number {
    let targetSec: number | null = null;
    const unsubscribe = audioSeekEmitter.subscribe((time) => {
        targetSec = time;
    });
    const originalDateNow = Date.now;
    Date.now = () => options.clientNowMs;
    try {
        controls.resume({
            suppressListenTogetherBroadcast: true,
            listenTogetherForceIsPlaying: true,
            listenTogetherPositionMs: 2_000,
            listenTogetherServerTimeMs: options.serverTimeMs,
        });
    } finally {
        Date.now = originalDateNow;
        unsubscribe();
        setListenTogetherSessionSnapshot(null);
        listenTogetherSocket.disconnect();
    }
    assert.notEqual(targetSec, null);
    return targetSec;
}

test("clock samples converge on a client clock that is 3000ms ahead", async () => {
    const { socket } = await sampleClockOffset({
        clientOffsetMs: 3_000,
        sampleCount: 3,
    });

    assert.ok(Math.abs(getServerClockOffsetMs() - 3_000) <= 1);
    socket.disconnect();
});

test("follower resume removes fast-client skew from the seek target", async () => {
    const { socket } = await sampleClockOffset({ clientOffsetMs: 3_000 });

    const targetSec = await captureResumeTarget({
        clientNowMs: 13_000,
        serverTimeMs: 9_000,
    });

    assert.ok(Math.abs(targetSec - 3) <= 0.001);
    socket.disconnect();
});

test("follower resume preserves zero-skew timing", async () => {
    const { socket } = await sampleClockOffset({ clientOffsetMs: 0 });

    const targetSec = await captureResumeTarget({
        clientNowMs: 10_000,
        serverTimeMs: 9_000,
    });

    assert.ok(Math.abs(targetSec - 3) <= 0.001);
    socket.disconnect();
});

test("reconnect discards clock samples from the previous connection", async () => {
    const sampler = createClockSampler({
        localTimesMs: [13_000, 13_100, 9_000, 9_100],
        serverTimesMs: [10_050, 10_050],
    });
    await flushPromises();
    assert.ok(Math.abs(getServerClockOffsetMs() - 3_000) <= 1);

    sampler.fakeSocket.trigger("disconnect", "transport close");
    sampler.fakeSocket.trigger("connect");
    await flushPromises();

    assert.ok(Math.abs(getServerClockOffsetMs() + 1_000) <= 1);
    sampler.socket.disconnect();
});
