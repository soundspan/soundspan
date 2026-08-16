import { useEffect, type MutableRefObject } from "react";
import type { Podcast, Track } from "@/lib/audio-state-context";
import type { QueueItem } from "@/lib/queue-item";
import { api, type SegmentedStreamingSessionResponse } from "@/lib/api";
import { isSegmentedModeEnabled } from "@/lib/audio-engine/engineMode";
import {
    getNextTrackInfo,
    resolveSegmentedTrackContext,
    type SegmentedTrackContext,
} from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import {
    buildSegmentedSessionKey,
    isSegmentedSessionPrewarmEnabled,
    isSegmentedSessionUsable,
} from "@/lib/audio-engine/audioPlaybackRuntimePolicy";
import { resolveRemoteStreamFormat } from "../audioPlaybackOrchestratorPolicy";
import { audioEngine } from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";

interface UseNextTrackPreloadOptions {
    playbackType: "track" | "audiobook" | "podcast" | null;
    currentTrack: Track | null;
    currentPodcast: Podcast | null;
    isPlaying: boolean;
    queue: QueueItem[];
    currentIndex: number;
    isShuffle: boolean;
    shuffleIndices: number[];
    repeatMode: "off" | "one" | "all";
    prewarmSegmentedSession: (options: {
        sessionKey: string;
        context: SegmentedTrackContext;
        trackId: string;
        reason: "startup_background" | "next_track";
        retryCount?: number;
    }) => void;
    isListenTogetherSegmentedPlaybackAllowed: () => boolean;
    prewarmedSegmentedSessionRef: MutableRefObject<
        Map<string, SegmentedStreamingSessionResponse>
    >;
    lastPreloadedTrackIdRef: MutableRefObject<string | null>;
    ytMusicAuthenticatedRef: MutableRefObject<boolean>;
}

/** Preloads the next music queue item without changing playback state. */
export function useNextTrackPreload({
    playbackType,
    currentTrack,
    currentPodcast,
    isPlaying,
    queue,
    currentIndex,
    isShuffle,
    shuffleIndices,
    repeatMode,
    prewarmSegmentedSession,
    isListenTogetherSegmentedPlaybackAllowed,
    prewarmedSegmentedSessionRef,
    lastPreloadedTrackIdRef,
    ytMusicAuthenticatedRef,
}: UseNextTrackPreloadOptions): void {
    // Preload next track for gapless playback (music only)
    useEffect(() => {
        // Preload while a track or podcast episode plays — but only when the
        // NEXT queue item is a music track (getNextTrackInfo returns null for
        // episode items). Audiobooks have no queue and never preload.
        const hasActiveQueueMedia =
            playbackType === "track"
                ? Boolean(currentTrack)
                : playbackType === "podcast"
                  ? Boolean(currentPodcast)
                  : false;
        if (!hasActiveQueueMedia || !isPlaying) {
            return;
        }

        for (const [
            sessionKey,
            session,
        ] of prewarmedSegmentedSessionRef.current) {
            if (!isSegmentedSessionUsable(session)) {
                prewarmedSegmentedSessionRef.current.delete(sessionKey);
            }
        }

        const nextTrack = getNextTrackInfo(
            queue,
            currentIndex,
            isShuffle,
            shuffleIndices,
            repeatMode,
        );

        // Don't preload if no next track or already preloaded this one
        if (!nextTrack || nextTrack.id === lastPreloadedTrackIdRef.current) {
            return;
        }

        let streamUrl: string;
        let format: string | undefined = "mp3";

        if (nextTrack.streamSource === "tidal" && nextTrack.tidalTrackId) {
            streamUrl = api.getTidalStreamUrl(nextTrack.tidalTrackId);
            format = resolveRemoteStreamFormat("tidal");
        } else if (
            nextTrack.streamSource === "youtube" &&
            nextTrack.youtubeVideoId
        ) {
            streamUrl = api.getYtMusicStreamUrl(
                nextTrack.youtubeVideoId,
                undefined,
                !ytMusicAuthenticatedRef.current,
            );
            format = resolveRemoteStreamFormat("youtube");
        } else if (
            nextTrack.streamSource === "youtube-direct" &&
            nextTrack.youtubeVideoId
        ) {
            streamUrl = api.getYouTubeStreamUrl(nextTrack.youtubeVideoId);
            format = nextTrack.youtubeAudioFormat === "webm" ? "webm" : "mp4";
        } else {
            streamUrl = api.getStreamUrl(nextTrack.id);
            // Determine format from file path
            const filePath = nextTrack.filePath || "";
            if (filePath) {
                const ext = filePath.split(".").pop()?.toLowerCase();
                if (ext === "flac") format = "flac";
                else if (ext === "m4a" || ext === "aac") format = "mp4";
                else if (ext === "ogg" || ext === "opus") format = "webm";
                else if (ext === "wav") format = "wav";
            }
        }

        audioEngine.preload(streamUrl, format);
        lastPreloadedTrackIdRef.current = nextTrack.id;

        const nextSegmentedTrackContext =
            resolveSegmentedTrackContext(nextTrack);
        const shouldPrewarmSegmentedSession =
            isSegmentedSessionPrewarmEnabled() &&
            Boolean(nextSegmentedTrackContext) &&
            isListenTogetherSegmentedPlaybackAllowed() &&
            isSegmentedModeEnabled();

        if (!shouldPrewarmSegmentedSession || !nextSegmentedTrackContext) {
            return;
        }

        const nextSessionKey = buildSegmentedSessionKey(
            nextSegmentedTrackContext,
        );
        const existingPrewarmedSession =
            prewarmedSegmentedSessionRef.current.get(nextSessionKey);
        if (
            existingPrewarmedSession &&
            isSegmentedSessionUsable(existingPrewarmedSession)
        ) {
            return;
        }
        prewarmSegmentedSession({
            sessionKey: nextSessionKey,
            context: nextSegmentedTrackContext,
            trackId: nextTrack.id,
            reason: "next_track",
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [
        playbackType,
        currentTrack,
        currentPodcast,
        isPlaying,
        queue,
        currentIndex,
        isShuffle,
        shuffleIndices,
        repeatMode,
        prewarmSegmentedSession,
        isListenTogetherSegmentedPlaybackAllowed,
    ]);
}
