"use client";

export const LISTEN_TOGETHER_SESSION_STORAGE_KEY = "soundspan_listen_together_session";

export interface ListenTogetherSessionSnapshot {
    groupId: string;
    isHost: boolean;
    playback: {
        isPlaying: boolean;
        positionMs: number;
        serverTime: number;
        currentIndex: number;
    };
}

export function getListenTogetherSessionSnapshot(): ListenTogetherSessionSnapshot | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(LISTEN_TOGETHER_SESSION_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as ListenTogetherSessionSnapshot;
        if (
            !parsed ||
            typeof parsed.groupId !== "string" ||
            typeof parsed.isHost !== "boolean" ||
            !parsed.playback ||
            typeof parsed.playback.isPlaying !== "boolean" ||
            typeof parsed.playback.positionMs !== "number" ||
            typeof parsed.playback.serverTime !== "number" ||
            typeof parsed.playback.currentIndex !== "number"
        ) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

export function setListenTogetherSessionSnapshot(snapshot: ListenTogetherSessionSnapshot | null): void {
    if (typeof window === "undefined") return;
    try {
        if (!snapshot) {
            window.localStorage.removeItem(LISTEN_TOGETHER_SESSION_STORAGE_KEY);
            return;
        }
        window.localStorage.setItem(
            LISTEN_TOGETHER_SESSION_STORAGE_KEY,
            JSON.stringify(snapshot),
        );
    } catch {
        // Ignore storage failures
    }
}
