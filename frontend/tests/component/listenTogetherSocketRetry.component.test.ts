import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { ListenTogetherSocket } from "../../lib/listen-together-socket";

type AckResponse = {
    ok?: boolean;
    error?: string;
    code?: string;
    transient?: boolean;
    retryable?: boolean;
    retryAfterMs?: number;
};

type EmitRecord = {
    event: string;
    payload: unknown;
};

const originalSetTimeout = globalThis.setTimeout;
const originalRandom = Math.random;
let scheduledDelaysMs: number[] = [];

function installImmediateTimerMock(): void {
    scheduledDelaysMs = [];
    Math.random = () => 0;
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
        callback: (...args: unknown[]) => void,
        delay?: number,
    ) => {
        scheduledDelaysMs.push(Number(delay ?? 0));
        callback();
        return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
}

function restoreTimerMock(): void {
    Math.random = originalRandom;
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
        originalSetTimeout;
}

function createSocketWithAckSequence(sequence: AckResponse[]): {
    socketClient: ListenTogetherSocket;
    emits: EmitRecord[];
} {
    const emits: EmitRecord[] = [];
    const socketClient = new ListenTogetherSocket();
    const pendingAcks = [...sequence];

    (socketClient as unknown as { socket: unknown }).socket = {
        connected: true,
        emit: (
            event: string,
            payloadOrAck: unknown,
            maybeAck?: (response: AckResponse) => void,
        ) => {
            const ack =
                typeof payloadOrAck === "function"
                    ? (payloadOrAck as (response: AckResponse) => void)
                    : maybeAck;
            const payload =
                typeof payloadOrAck === "function" ? undefined : payloadOrAck;

            emits.push({ event, payload });
            const response = pendingAcks.shift() ?? { ok: true };
            ack?.(response);
        },
    };

    return { socketClient, emits };
}

beforeEach(() => {
    installImmediateTimerMock();
});

afterEach(() => {
    restoreTimerMock();
});

test("seek retries transient conflicts with bounded backoff and succeeds", async () => {
    const { socketClient, emits } = createSocketWithAckSequence([
        {
            error: "lock conflict",
            code: "CONFLICT",
            transient: true,
            retryable: true,
            retryAfterMs: 120,
        },
        {
            error: "lock conflict",
            code: "CONFLICT",
            transient: true,
            retryable: true,
            retryAfterMs: 120,
        },
        { ok: true },
    ]);

    await socketClient.seek(1337);

    assert.equal(emits.length, 3);
    assert.equal(
        emits.every(
            (entry) =>
                entry.event === "playback" &&
                JSON.stringify(entry.payload) ===
                    JSON.stringify({ action: "seek", positionMs: 1337 }),
        ),
        true,
    );
    assert.deepEqual(scheduledDelaysMs, [120, 120]);
});

test("joinGroup retries transient lock conflicts with bounded backoff", async () => {
    const { socketClient, emits } = createSocketWithAckSequence([
        {
            error: "lock conflict",
            code: "CONFLICT",
            transient: true,
            retryable: true,
            retryAfterMs: 90,
        },
        { ok: true },
    ]);

    await socketClient.joinGroup("group-retry");

    assert.deepEqual(emits, [
        {
            event: "join-group",
            payload: { groupId: "group-retry" },
        },
        {
            event: "join-group",
            payload: { groupId: "group-retry" },
        },
    ]);
    assert.deepEqual(scheduledDelaysMs, [90]);
});

test("joinGroup stops after the transient conflict retry budget", async () => {
    const transientConflictAck: AckResponse = {
        error: "Another group update is in progress. Please retry.",
        code: "CONFLICT",
        transient: true,
        retryable: true,
        retryAfterMs: 75,
    };
    const { socketClient, emits } = createSocketWithAckSequence([
        transientConflictAck,
        transientConflictAck,
        transientConflictAck,
        transientConflictAck,
    ]);

    await assert.rejects(
        socketClient.joinGroup("group-budget"),
        /Another group update is in progress. Please retry./,
    );

    assert.equal(emits.length, 4);
    assert.equal(
        emits.every(
            (entry) =>
                entry.event === "join-group" &&
                JSON.stringify(entry.payload) ===
                    JSON.stringify({ groupId: "group-budget" }),
        ),
        true,
    );
    assert.deepEqual(scheduledDelaysMs, [75, 120, 240]);
});

test("membership revocation clears the socket group before notifying the client", () => {
    const handlers = new Map<string, (payload?: unknown) => void>();
    const fakeSocket = {
        connected: true,
        auth: {},
        connect: () => undefined,
        disconnect: () => undefined,
        removeAllListeners: () => undefined,
        on: (event: string, handler: (payload?: unknown) => void) => {
            handlers.set(event, handler);
        },
        io: { on: () => undefined },
        emit: () => undefined,
    };
    const socketClient = new ListenTogetherSocket({
        createSocket: (() => fakeSocket) as never,
        getToken: () => "token",
        setInterval: (() => 0) as never,
        clearInterval: () => undefined,
    });
    (
        socketClient as unknown as { currentGroupId: string | null }
    ).currentGroupId = "group-revoked";
    let callbackGroupId: string | null = null;

    socketClient.connect({
        onGroupState: () => undefined,
        onPlaybackDelta: () => undefined,
        onQueueDelta: () => undefined,
        onWaiting: () => undefined,
        onPlayAt: () => undefined,
        onMemberJoined: () => undefined,
        onMemberLeft: () => undefined,
        onMembershipRevoked: (event) => {
            assert.equal(socketClient.activeGroupId, null);
            callbackGroupId = event.groupId;
        },
        onGroupEnded: () => undefined,
        onConnect: () => undefined,
        onDisconnect: () => undefined,
        onError: () => undefined,
    });
    handlers.get("group:membership-revoked")?.({
        groupId: "group-revoked",
    });

    assert.equal(callbackGroupId, "group-revoked");
    assert.equal(socketClient.activeGroupId, null);
});

test("reconnect reports a final rejoin rejection without a floating promise", async () => {
    const handlers = new Map<string, () => void>();
    const joinEmits: EmitRecord[] = [];
    const transientConflictAck: AckResponse = {
        error: "lock conflict",
        code: "CONFLICT",
        transient: true,
        retryable: true,
        retryAfterMs: 75,
    };
    const fakeSocket = {
        connected: true,
        auth: {},
        connect: () => undefined,
        disconnect: () => undefined,
        removeAllListeners: () => undefined,
        on: (event: string, handler: () => void) => {
            handlers.set(event, handler);
        },
        io: { on: () => undefined },
        emit: (
            event: string,
            payloadOrAck: unknown,
            maybeAck?: (response: AckResponse) => void,
        ) => {
            const ack =
                typeof payloadOrAck === "function"
                    ? (payloadOrAck as (response: AckResponse) => void)
                    : maybeAck;
            if (event === "lt-ping") {
                ack?.({ serverTime: 0 } as AckResponse);
                return;
            }
            joinEmits.push({ event, payload: payloadOrAck });
            ack?.(transientConflictAck);
        },
    };
    const socketClient = new ListenTogetherSocket({
        createSocket: (() => fakeSocket) as never,
        getToken: () => "token",
        now: () => 0,
        setInterval: (() => 0) as never,
        clearInterval: () => undefined,
    });
    (
        socketClient as unknown as { currentGroupId: string | null }
    ).currentGroupId = "group-reconnect";
    const reportedErrors: Error[] = [];
    let resyncRequests = 0;

    socketClient.connect({
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
        onRejoinFailed: () => {
            resyncRequests += 1;
        },
        onError: (error) => {
            reportedErrors.push(error);
        },
    });
    handlers.get("connect")?.();
    for (let turn = 0; turn < 20 && reportedErrors.length === 0; turn += 1) {
        await Promise.resolve();
    }

    assert.equal(joinEmits.length, 4);
    assert.equal(resyncRequests, 1);
    assert.equal(reportedErrors[0]?.message, "lock conflict");
});

test("reconnect rejoin reports a withheld acknowledgement within the timeout bound", async () => {
    const handlers = new Map<string, () => void>();
    const timers = new Map<number, { callback: () => void; delayMs: number }>();
    let nextTimerId = 1;
    const fakeSocket = {
        connected: true,
        auth: {},
        connect: () => undefined,
        disconnect: () => undefined,
        removeAllListeners: () => undefined,
        on: (event: string, handler: () => void) => {
            handlers.set(event, handler);
        },
        io: { on: () => undefined },
        emit: (
            event: string,
            payloadOrAck: unknown,
            maybeAck?: (response: AckResponse) => void,
        ) => {
            const ack =
                typeof payloadOrAck === "function"
                    ? (payloadOrAck as (response: AckResponse) => void)
                    : maybeAck;
            if (event === "lt-ping") {
                ack?.({ serverTime: 0 } as AckResponse);
            }
            // Deliberately withhold the join-group acknowledgement.
        },
    };
    const socketClient = new ListenTogetherSocket({
        createSocket: (() => fakeSocket) as never,
        getToken: () => "token",
        now: () => 0,
        setInterval: (() => 0) as never,
        clearInterval: () => undefined,
        setTimeout: (callback, delayMs) => {
            const timerId = nextTimerId;
            nextTimerId += 1;
            timers.set(timerId, { callback, delayMs });
            return timerId as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: (handle) => {
            timers.delete(Number(handle));
        },
    });
    (
        socketClient as unknown as { currentGroupId: string | null }
    ).currentGroupId = "group-timeout";
    const reportedErrors: Error[] = [];
    let rejoinFailures = 0;

    socketClient.connect({
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
        onRejoinFailed: () => {
            rejoinFailures += 1;
        },
        onError: (error) => {
            reportedErrors.push(error);
        },
    });
    handlers.get("connect")?.();

    const ackTimer = [...timers.values()].find(({ delayMs }) => delayMs > 0);
    assert.ok(ackTimer);
    assert.ok(ackTimer.delayMs <= 5_000);
    ackTimer.callback();
    for (let turn = 0; turn < 10 && reportedErrors.length === 0; turn += 1) {
        await Promise.resolve();
    }

    assert.equal(rejoinFailures, 1);
    assert.match(
        reportedErrors[0]?.message ?? "",
        /acknowledgement timed out/i,
    );
    assert.equal(timers.size, 0);
});

test("seek does not retry non-conflict errors", async () => {
    const { socketClient, emits } = createSocketWithAckSequence([
        {
            error: "Only host can control playback",
            code: "NOT_ALLOWED",
            transient: false,
            retryable: false,
        },
    ]);

    await assert.rejects(
        socketClient.seek(5000),
        /Only host can control playback/,
    );

    assert.equal(emits.length, 1);
    assert.deepEqual(scheduledDelaysMs, []);
});

test("seek includes an applied state version when supplied", async () => {
    const { socketClient, emits } = createSocketWithAckSequence([{ ok: true }]);

    await socketClient.seek(5000, 17);

    assert.deepEqual(emits, [
        {
            event: "playback",
            payload: { action: "seek", positionMs: 5000, stateVersion: 17 },
        },
    ]);
});

test("next/previous/setTrack emit playback actions and accept empty ack payloads", async () => {
    const emits: EmitRecord[] = [];
    const socketClient = new ListenTogetherSocket();

    (socketClient as unknown as { socket: unknown }).socket = {
        connected: true,
        emit: (
            event: string,
            payloadOrAck: unknown,
            maybeAck?: (response: AckResponse) => void,
        ) => {
            const ack =
                typeof payloadOrAck === "function"
                    ? (payloadOrAck as (response: AckResponse) => void)
                    : maybeAck;
            const payload =
                typeof payloadOrAck === "function" ? undefined : payloadOrAck;
            emits.push({ event, payload });
            // Exercise emitOnce's `res ?? {}` fallback branch deterministically.
            ack?.(undefined as unknown as AckResponse);
        },
    };

    await socketClient.next();
    await socketClient.previous();
    await socketClient.setTrack(7);

    assert.deepEqual(emits, [
        { event: "playback", payload: { action: "next" } },
        { event: "playback", payload: { action: "previous" } },
        { event: "playback", payload: { action: "set-track", index: 7 } },
    ]);
});

test("next retries transient conflicts without retryAfterMs using exponential baseline", async () => {
    const { socketClient, emits } = createSocketWithAckSequence([
        {
            error: "lock conflict",
            code: "CONFLICT",
            transient: true,
            retryable: true,
        },
        { ok: true },
    ]);

    await socketClient.next();

    assert.equal(emits.length, 2);
    assert.deepEqual(scheduledDelaysMs, [60]);
});

test("createAckError uses default message when server omits error text", () => {
    const socketClient = new ListenTogetherSocket() as unknown as {
        createAckError: (response: AckResponse) => Error & { code?: string };
    };

    const err = socketClient.createAckError({
        code: "NOT_ALLOWED",
        transient: false,
        retryable: false,
    });

    assert.equal(err.message, "Listen Together request failed");
    assert.equal(err.code, "NOT_ALLOWED");
});

test("reportReady exhausts retry budget and fails deterministically", async () => {
    const transientConflictAck: AckResponse = {
        error: "Another group update is in progress. Please retry.",
        code: "CONFLICT",
        transient: true,
        retryable: true,
        retryAfterMs: 80,
    };

    const { socketClient, emits } = createSocketWithAckSequence([
        transientConflictAck,
        transientConflictAck,
        transientConflictAck,
        transientConflictAck,
    ]);

    await assert.rejects(
        socketClient.reportReady(),
        /Another group update is in progress. Please retry./,
    );

    assert.equal(emits.length, 4);
    assert.equal(
        emits.every((entry) => entry.event === "ready"),
        true,
    );
    assert.deepEqual(scheduledDelaysMs, [80, 120, 240]);
});
