import { useCallback, useEffect, type MutableRefObject } from "react";
import { api } from "@/lib/api";
import { getListenTogetherSessionSnapshot } from "@/lib/listen-together-session";
import { AUTO_MATCH_VIBE_RETRY_COOLDOWN_MS } from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";

/** Keeps the YouTube Music authentication snapshot current. */
export function useYtMusicAuth(
    ytMusicAuthenticatedRef: MutableRefObject<boolean>,
): void {
    // Fetch YouTube Music auth status on mount and whenever the user
    // connects/disconnects their YT Music account via settings.
    useEffect(() => {
        const refreshYtAuth = () => {
            api.getYtMusicStatus()
                .then((status) => {
                    ytMusicAuthenticatedRef.current =
                        !!status.enabled &&
                        !!status.available &&
                        !!status.authenticated;
                })
                .catch(() => {
                    ytMusicAuthenticatedRef.current = false;
                });
        };
        refreshYtAuth();
        if (typeof window !== "undefined") {
            window.addEventListener("ytmusic-auth-changed", refreshYtAuth);
            return () => {
                window.removeEventListener(
                    "ytmusic-auth-changed",
                    refreshYtAuth,
                );
            };
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, []);
}

interface UseAutoMatchVibeOptions {
    refs: PlaybackOrchestratorRefs;
    startVibeMode: () => Promise<{ success: boolean; trackCount: number }>;
}

/** Returns the existing deduplicated automatic Vibe request callback. */
export function useAutoMatchVibe({
    refs,
    startVibeMode,
}: UseAutoMatchVibeOptions) {
    const {
        autoMatchVibePromiseRef,
        autoMatchVibeTrackIdRef,
        autoMatchVibeLastAttemptAtRef,
    } = refs;

    const requestAutoMatchVibe = useCallback(
        (
            seedTrackId: string | null,
            options?: { force?: boolean },
        ): Promise<boolean> => {
            if (!seedTrackId) return Promise.resolve(false);
            if (getListenTogetherSessionSnapshot()?.groupId) {
                return Promise.resolve(false);
            }

            if (autoMatchVibePromiseRef.current) {
                if (autoMatchVibeTrackIdRef.current === seedTrackId) {
                    return autoMatchVibePromiseRef.current;
                }
                return Promise.resolve(false);
            }

            const now = Date.now();
            if (
                !options?.force &&
                autoMatchVibeTrackIdRef.current === seedTrackId &&
                now - autoMatchVibeLastAttemptAtRef.current <
                    AUTO_MATCH_VIBE_RETRY_COOLDOWN_MS
            ) {
                return Promise.resolve(false);
            }

            autoMatchVibeTrackIdRef.current = seedTrackId;
            autoMatchVibeLastAttemptAtRef.current = now;

            const request = startVibeMode()
                .then((result) => result.success && result.trackCount > 0)
                .catch((error) => {
                    sharedFrontendLogger.error(
                        "[AudioPlaybackOrchestrator] Auto Match Vibe request failed:",
                        error,
                    );
                    return false;
                })
                .finally(() => {
                    autoMatchVibePromiseRef.current = null;
                });

            autoMatchVibePromiseRef.current = request;
            return request;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [startVibeMode],
    );

    return requestAutoMatchVibe;
}
