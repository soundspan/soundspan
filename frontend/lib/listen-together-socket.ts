/**
 * Socket.IO client wrapper for Listen Together.
 *
 * Manages the connection lifecycle to the `/listen-together` namespace,
 * provides typed event helpers, and handles auto-reconnect.
 */

import { io, type Socket } from "socket.io-client";
import { api } from "./api";
import type {
    CanonicalMediaProviderIdentity,
    CanonicalMediaSource,
} from "@soundspan/media-metadata-contract";

// ---------------------------------------------------------------------------
// Server → Client event types
// ---------------------------------------------------------------------------

export interface SyncQueueItem {
    id: string;
    title: string;
    duration: number;
    artist: { id: string; name: string };
    album: { id: string; title: string; coverArt: string | null };
    mediaSource?: CanonicalMediaSource;
    provider?: CanonicalMediaProviderIdentity;
    streamSource?: "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
}

export interface GroupSnapshot {
    id: string;
    name: string;
    joinCode: string;
    groupType: "host-follower" | "collaborative";
    visibility: "public" | "private";
    isActive: boolean;
    hostUserId: string;
    syncState: "idle" | "waiting" | "playing" | "paused";
    playback: {
        queue: SyncQueueItem[];
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
}

export interface PlaybackDelta {
    isPlaying: boolean;
    positionMs: number;
    serverTime: number;
    stateVersion: number;
    currentIndex: number;
    trackId: string | null;
}

export interface QueueDelta {
    queue: SyncQueueItem[];
    currentIndex: number;
    trackId: string | null;
    stateVersion: number;
}

export interface WaitingEvent {
    trackId: string | null;
    currentIndex: number;
}

export interface PlayAtEvent {
    positionMs: number;
    serverTime: number;
    stateVersion: number;
}

export interface MemberEvent {
    userId: string;
    username: string;
}

export interface MemberLeftEvent extends MemberEvent {
    newHostUserId?: string;
    newHostUsername?: string;
}

export interface GroupEndedEvent {
    reason: string;
}

export interface SocketRouteProbeResult {
    ok: boolean;
    reason?: string;
    status?: number;
    sample?: string;
}

// ---------------------------------------------------------------------------
// Callback interface
// ---------------------------------------------------------------------------

export interface ListenTogetherSocketCallbacks {
    onGroupState: (snapshot: GroupSnapshot) => void;
    onPlaybackDelta: (delta: PlaybackDelta) => void;
    onQueueDelta: (delta: QueueDelta) => void;
    onWaiting: (data: WaitingEvent) => void;
    onPlayAt: (data: PlayAtEvent) => void;
    onMemberJoined: (data: MemberEvent) => void;
    onMemberLeft: (data: MemberLeftEvent) => void;
    onGroupEnded: (data: GroupEndedEvent) => void;
    onConnect: () => void;
    onReconnect?: (attempt: number) => void;
    onReconnectAttempt?: (attempt: number) => void;
    onReconnectError?: (error: Error) => void;
    onReconnectFailed?: () => void;
    onDisconnect: (reason: string) => void;
    onError: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// Connection manager
// ---------------------------------------------------------------------------

/**
 * Compute the Socket.IO server URL.
 * Listen Together sockets always connect to the same origin. In split
 * frontend/backend deployments, the frontend runtime proxies this path
 * to backend automatically.
 */
function getSocketUrl(): string {
    if (typeof window === "undefined") return "";
    return window.location.origin;
}

const LISTEN_TOGETHER_ALLOW_POLLING =
    process.env.NEXT_PUBLIC_LISTEN_TOGETHER_ALLOW_POLLING === "true";
const LISTEN_TOGETHER_SOCKET_TRANSPORTS: Array<"websocket" | "polling"> =
    LISTEN_TOGETHER_ALLOW_POLLING ? ["websocket", "polling"] : ["websocket"];
const TRANSIENT_CONFLICT_MAX_RETRIES = 3;
const TRANSIENT_CONFLICT_BASE_DELAY_MS = 60;
const TRANSIENT_CONFLICT_MAX_DELAY_MS = 300;
const TRANSIENT_CONFLICT_JITTER_FACTOR = 0.35;

interface ListenTogetherAckResponse {
    ok?: boolean;
    error?: string;
    code?: string;
    transient?: boolean;
    retryable?: boolean;
    retryAfterMs?: number;
}

interface EmitRetryPolicy {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitterFactor: number;
}

const TRANSIENT_CONFLICT_RETRY_POLICY: EmitRetryPolicy = {
    maxRetries: TRANSIENT_CONFLICT_MAX_RETRIES,
    baseDelayMs: TRANSIENT_CONFLICT_BASE_DELAY_MS,
    maxDelayMs: TRANSIENT_CONFLICT_MAX_DELAY_MS,
    jitterFactor: TRANSIENT_CONFLICT_JITTER_FACTOR,
};

export class ListenTogetherSocket {
    private socket: Socket | null = null;
    private callbacks: ListenTogetherSocketCallbacks | null = null;
    private currentGroupId: string | null = null;
    private routeProbeCache: {
        at: number;
        result: SocketRouteProbeResult;
    } | null = null;
    private routeProbeInFlight: Promise<SocketRouteProbeResult> | null = null;

    async probeRoute(force: boolean = false): Promise<SocketRouteProbeResult> {
        if (typeof window === "undefined") return { ok: true };

        const cached = this.routeProbeCache;
        const ttlMs = cached?.result.ok ? 30_000 : 3_000;
        if (!force && cached && Date.now() - cached.at < ttlMs) {
            return cached.result;
        }

        if (this.routeProbeInFlight) return this.routeProbeInFlight;

        this.routeProbeInFlight = this.runRouteProbe()
            .then((result) => {
                this.routeProbeCache = { at: Date.now(), result };
                return result;
            })
            .finally(() => {
                this.routeProbeInFlight = null;
            });

        return this.routeProbeInFlight;
    }

    connect(callbacks: ListenTogetherSocketCallbacks): void {
        this.callbacks = callbacks;
        const token = api.getToken();
        if (!token) {
            callbacks.onError(new Error("No auth token available"));
            return;
        }

        // Reuse an existing socket instance to prevent parallel sockets and
        // duplicate event delivery after reconnect churn.
        if (this.socket) {
            this.socket.auth = { token };
            if (!this.socket.connected) {
                this.socket.connect();
            }
            return;
        }

        const url = getSocketUrl();

        this.socket = io(`${url}/listen-together`, {
            path: "/socket.io/listen-together",
            auth: { token },
            transports: LISTEN_TOGETHER_SOCKET_TRANSPORTS,
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 10000,
            randomizationFactor: 0.5,
            reconnectionAttempts: Infinity,
            timeout: 20000,
        });

        this.socket.on("connect", () => {
            this.callbacks?.onConnect();
            // Re-join group on reconnect
            if (this.currentGroupId) {
                this.joinGroup(this.currentGroupId);
            }
        });

        this.socket.on("disconnect", (reason) => {
            this.callbacks?.onDisconnect(reason);
        });

        this.socket.on("connect_error", (err) => {
            this.callbacks?.onError(err);
        });

        this.socket.io.on("reconnect_attempt", (attempt: number) => {
            this.callbacks?.onReconnectAttempt?.(attempt);
        });

        this.socket.io.on("reconnect", (attempt: number) => {
            this.callbacks?.onReconnect?.(attempt);
        });

        this.socket.io.on("reconnect_error", (error: Error) => {
            this.callbacks?.onReconnectError?.(error);
        });

        this.socket.io.on("reconnect_failed", () => {
            this.callbacks?.onReconnectFailed?.();
        });

        // Server → Client events
        this.socket.on("group:state", (snapshot: GroupSnapshot) => {
            this.callbacks?.onGroupState(snapshot);
        });

        this.socket.on("group:playback-delta", (delta: PlaybackDelta) => {
            this.callbacks?.onPlaybackDelta(delta);
        });

        this.socket.on("group:queue-delta", (delta: QueueDelta) => {
            this.callbacks?.onQueueDelta(delta);
        });

        this.socket.on("group:waiting", (data: WaitingEvent) => {
            this.callbacks?.onWaiting(data);
        });

        this.socket.on("group:play-at", (data: PlayAtEvent) => {
            this.callbacks?.onPlayAt(data);
        });

        this.socket.on("group:member-joined", (data: MemberEvent) => {
            this.callbacks?.onMemberJoined(data);
        });

        this.socket.on("group:member-left", (data: MemberLeftEvent) => {
            this.callbacks?.onMemberLeft(data);
        });

        this.socket.on("group:ended", (data: GroupEndedEvent) => {
            this.currentGroupId = null;
            this.callbacks?.onGroupEnded(data);
        });
    }

    private async runRouteProbe(): Promise<SocketRouteProbeResult> {
        const maxAttempts = 3;
        let lastResult: SocketRouteProbeResult = {
            ok: false,
            reason: "network-error",
        };

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            lastResult =
                !LISTEN_TOGETHER_ALLOW_POLLING ?
                    await this.runWebSocketRouteProbe()
                :   await this.runPollingRouteProbe();

            if (lastResult.ok || !this.shouldRetryProbe(lastResult)) {
                return lastResult;
            }

            if (attempt < maxAttempts) {
                await new Promise((resolve) =>
                    setTimeout(resolve, 250 * attempt)
                );
            }
        }

        return lastResult;
    }

    private shouldRetryProbe(result: SocketRouteProbeResult): boolean {
        if (result.ok) return false;

        if (result.reason === "network-error" || result.reason === "timeout") {
            return true;
        }

        if (result.reason === "http-error") {
            const status = result.status ?? 0;
            return status >= 500 || status === 429;
        }

        return false;
    }

    private async runPollingRouteProbe(): Promise<SocketRouteProbeResult> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);

        try {
            const baseUrl = getSocketUrl().replace(/\/+$/, "");
            const probeUrl = `${baseUrl}/socket.io/listen-together/?EIO=4&transport=polling&t=${Date.now().toString(36)}`;
            const response = await fetch(probeUrl, {
                method: "GET",
                credentials: "include",
                cache: "no-store",
                headers: { Accept: "*/*" },
                signal: controller.signal,
            });

            const text = (await response.text()).trim();
            const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
            const sample = text.slice(0, 120);
            const isEnginePayload =
                (text.includes("\"sid\"") && text.includes("\"upgrades\"")) ||
                text.startsWith("0{") ||
                text.includes(":0{");

            if (!response.ok) {
                return {
                    ok: false,
                    reason: "http-error",
                    status: response.status,
                    sample,
                };
            }

            if (isEnginePayload) {
                return { ok: true };
            }

            const isHtml = contentType.includes("text/html") || /^<!doctype html|^<html/i.test(text);
            return {
                ok: false,
                reason: isHtml ? "frontend-route" : "unexpected-response",
                status: response.status,
                sample,
            };
        } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") {
                return { ok: false, reason: "timeout" };
            }
            return { ok: false, reason: "network-error" };
        } finally {
            clearTimeout(timeout);
        }
    }

    private async runWebSocketRouteProbe(): Promise<SocketRouteProbeResult> {
        return await new Promise<SocketRouteProbeResult>((resolve) => {
            const baseUrl = getSocketUrl().replace(/\/+$/, "");
            if (!baseUrl) {
                resolve({ ok: false, reason: "network-error" });
                return;
            }

            const wsBaseUrl =
                baseUrl.startsWith("https://") ?
                    `wss://${baseUrl.slice("https://".length)}`
                : baseUrl.startsWith("http://") ?
                    `ws://${baseUrl.slice("http://".length)}`
                : `wss://${baseUrl.replace(/^\/+/, "")}`;

            const probeUrl = `${wsBaseUrl}/socket.io/listen-together/?EIO=4&transport=websocket&t=${Date.now().toString(36)}`;
            let settled = false;
            let timeoutId: ReturnType<typeof setTimeout> | null = null;
            let ws: WebSocket | null = null;

            const settle = (result: SocketRouteProbeResult) => {
                if (settled) return;
                settled = true;
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
                if (ws) {
                    try {
                        ws.close();
                    } catch {
                        // ignore close failures
                    }
                    ws = null;
                }
                resolve(result);
            };

            timeoutId = setTimeout(() => {
                settle({ ok: false, reason: "timeout" });
            }, 6000);

            try {
                ws = new WebSocket(probeUrl);
                ws.onopen = () => settle({ ok: true });
                ws.onerror = () => settle({ ok: false, reason: "network-error" });
                ws.onclose = () => settle({ ok: false, reason: "network-error" });
            } catch {
                settle({ ok: false, reason: "network-error" });
            }
        });
    }

    disconnect(): void {
        this.currentGroupId = null;
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.disconnect();
            this.socket = null;
        }
        this.callbacks = null;
    }

    get isConnected(): boolean {
        return this.socket?.connected ?? false;
    }

    get activeGroupId(): string | null {
        return this.currentGroupId;
    }

    get hasActiveGroup(): boolean {
        return Boolean(this.currentGroupId);
    }

    // -----------------------------------------------------------------------
    // Client → Server commands
    // -----------------------------------------------------------------------

    joinGroup(groupId: string): Promise<void> {
        this.currentGroupId = groupId;
        return this.emit("join-group", { groupId });
    }

    leaveGroup(): Promise<void> {
        this.currentGroupId = null;
        return this.emit("leave-group");
    }

    play(): Promise<void> {
        return this.emit("playback", { action: "play" });
    }

    pause(): Promise<void> {
        return this.emit("playback", { action: "pause" });
    }

    seek(positionMs: number): Promise<void> {
        return this.emit("playback", { action: "seek", positionMs }, TRANSIENT_CONFLICT_RETRY_POLICY);
    }

    next(): Promise<void> {
        return this.emit("playback", { action: "next" }, TRANSIENT_CONFLICT_RETRY_POLICY);
    }

    previous(): Promise<void> {
        return this.emit("playback", { action: "previous" }, TRANSIENT_CONFLICT_RETRY_POLICY);
    }

    setTrack(index: number): Promise<void> {
        return this.emit("playback", { action: "set-track", index }, TRANSIENT_CONFLICT_RETRY_POLICY);
    }

    addToQueue(trackIds: string[]): Promise<void> {
        return this.emit("queue", { action: "add", trackIds });
    }

    insertNext(trackIds: string[]): Promise<void> {
        return this.emit("queue", { action: "insert-next", trackIds });
    }

    removeFromQueue(index: number): Promise<void> {
        return this.emit("queue", { action: "remove", index });
    }

    reorderQueue(fromIndex: number, toIndex: number): Promise<void> {
        return this.emit("queue", { action: "reorder", fromIndex, toIndex });
    }

    clearQueue(): Promise<void> {
        return this.emit("queue", { action: "clear" });
    }

    reportReady(): Promise<void> {
        return this.emit("ready", undefined, TRANSIENT_CONFLICT_RETRY_POLICY);
    }

    /** Measure round-trip time. Returns server's Date.now(). */
    async ping(): Promise<number> {
        return new Promise((resolve, reject) => {
            if (!this.socket?.connected) {
                reject(new Error("Not connected"));
                return;
            }
            this.socket.emit("lt-ping", (res: { serverTime?: number; error?: string }) => {
                if (res?.error) reject(new Error(res.error));
                else resolve(res?.serverTime ?? Date.now());
            });
        });
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    private async emit(
        event: string,
        data?: unknown,
        retryPolicy?: EmitRetryPolicy
    ): Promise<void> {
        let retries = 0;

        while (true) {
            const response = await this.emitOnce(event, data);
            if (!response?.error) {
                return;
            }

            if (
                !retryPolicy ||
                !this.isTransientConflictAck(response) ||
                retries >= retryPolicy.maxRetries
            ) {
                throw this.createAckError(response);
            }

            const waitMs = this.computeRetryDelayMs(retries, retryPolicy, response.retryAfterMs);
            retries += 1;
            await this.delay(waitMs);
        }
    }

    private emitOnce(event: string, data?: unknown): Promise<ListenTogetherAckResponse> {
        return new Promise((resolve, reject) => {
            if (!this.socket?.connected) {
                reject(new Error("Not connected"));
                return;
            }

            const onAck = (res: ListenTogetherAckResponse) => {
                resolve(res ?? {});
            };

            if (data === undefined) {
                this.socket.emit(event, onAck);
            } else {
                this.socket.emit(event, data, onAck);
            }
        });
    }

    private isTransientConflictAck(response: ListenTogetherAckResponse): boolean {
        return (
            response.code === "CONFLICT" &&
            response.transient === true &&
            response.retryable === true
        );
    }

    private createAckError(response: ListenTogetherAckResponse): Error {
        const err = new Error(response.error || "Listen Together request failed");
        const ackError = err as Error & {
            code?: string;
            transient?: boolean;
            retryable?: boolean;
            retryAfterMs?: number;
        };
        if (response.code) {
            ackError.code = response.code;
        }
        if (response.transient === true) {
            ackError.transient = true;
        }
        if (response.retryable === true) {
            ackError.retryable = true;
        }
        if (
            typeof response.retryAfterMs === "number" &&
            Number.isFinite(response.retryAfterMs)
        ) {
            ackError.retryAfterMs = response.retryAfterMs;
        }
        return err;
    }

    private computeRetryDelayMs(
        retryAttempt: number,
        policy: EmitRetryPolicy,
        retryAfterMs?: number
    ): number {
        const exponentialDelay = Math.min(
            policy.maxDelayMs,
            policy.baseDelayMs * 2 ** retryAttempt
        );
        const serverHintDelay =
            typeof retryAfterMs === "number" &&
            Number.isFinite(retryAfterMs) &&
            retryAfterMs > 0
                ? Math.min(policy.maxDelayMs, retryAfterMs)
                : 0;
        const baselineDelay = Math.max(exponentialDelay, serverHintDelay);
        const jitterWindow = Math.max(
            1,
            Math.floor(baselineDelay * policy.jitterFactor)
        );
        const jitter = Math.floor(Math.random() * (jitterWindow + 1));

        return Math.min(policy.maxDelayMs, baselineDelay + jitter);
    }

    private async delay(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }
}

/** Singleton instance. */
export const listenTogetherSocket = new ListenTogetherSocket();
