"use client";

import { io, type Socket } from "socket.io-client";
import { api } from "@/lib/api";

type SocialPresenceUpdateReason =
    | "heartbeat"
    | "playback-state"
    | "playback-state-cleared";

interface SocialPresenceUpdatedEvent {
    userId: string;
    reason: SocialPresenceUpdateReason;
    timestampMs: number;
    deviceId?: string;
}

type SocialPresenceListener = (event: SocialPresenceUpdatedEvent) => void;

const LISTEN_TOGETHER_ALLOW_POLLING =
    process.env.NEXT_PUBLIC_LISTEN_TOGETHER_ALLOW_POLLING === "true";
const LISTEN_TOGETHER_SOCKET_TRANSPORTS: Array<"websocket" | "polling"> =
    LISTEN_TOGETHER_ALLOW_POLLING ? ["websocket", "polling"] : ["websocket"];

class SocialPresenceSocket {
    private socket: Socket | null = null;
    private listeners = new Set<SocialPresenceListener>();

    subscribe(listener: SocialPresenceListener): () => void {
        this.listeners.add(listener);
        this.ensureConnected();

        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0) {
                this.disconnect();
            }
        };
    }

    private ensureConnected(): void {
        if (typeof window === "undefined") {
            return;
        }

        const token = api.getToken();
        if (!token) {
            return;
        }

        if (this.socket) {
            this.socket.auth = { token };
            if (!this.socket.connected) {
                this.socket.connect();
            }
            return;
        }

        this.socket = io(`${window.location.origin}/listen-together`, {
            path: "/socket.io/listen-together",
            auth: { token },
            transports: LISTEN_TOGETHER_SOCKET_TRANSPORTS,
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 10_000,
            randomizationFactor: 0.5,
            reconnectionAttempts: Infinity,
            timeout: 20_000,
        });

        this.socket.on("social:presence-updated", (event) => {
            const payload = event as SocialPresenceUpdatedEvent;
            this.listeners.forEach((activeListener) => {
                activeListener(payload);
            });
        });
    }

    private disconnect(): void {
        if (!this.socket) {
            return;
        }

        this.socket.removeAllListeners();
        this.socket.disconnect();
        this.socket = null;
    }
}

export const socialPresenceSocket = new SocialPresenceSocket();

