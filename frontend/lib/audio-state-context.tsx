"use client";

import {
    createContext,
    useContext,
    useState,
    useEffect,
    useRef,
    ReactNode,
    useMemo,
} from "react";
import { api } from "@/lib/api";
import type {
    CanonicalMediaProviderIdentity,
    CanonicalMediaSource,
} from "@soundspan/media-metadata-contract";
import type { Episode } from "@/features/podcast/types";
import {
    createMigratingStorageKey,
    readMigratingStorageItem,
    removeMigratingStorageItem,
    writeMigratingStorageItem,
    type MigratingStorageKey,
} from "@/lib/storage-migration";
import {
    LAST_PLAYBACK_STATE_SAVE_AT_KEY_SUFFIX,
    QUEUE_CLEARED_AT_KEY_SUFFIX,
    parsePlaybackStateSaveTimestamp,
    shouldSkipPlaybackStatePoll,
    createDebouncedStorageFlush,
} from "@/lib/playback-state-cadence";
import { resolvePollingJitter } from "@/hooks/pollingCadence";
import { clampNonNegativePlaybackTime } from "@/lib/audio-playback-normalization";
import { resolveInitialAudioVolume } from "@/lib/audio-volume";
import {
    normalizeQueueIndex,
    queuesMatchByTrackId,
    resolveServerPlaybackPollDecision,
    type PlaybackSnapshotType,
} from "@/lib/playback-state-reconciliation";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

function queueDebugEnabled(): boolean {
    try {
        return (
            typeof window !== "undefined" &&
            window.localStorage?.getItem("soundspanQueueDebug") === "1"
        );
    } catch {
        // Intentionally ignored: localStorage may throw in SSR or restricted contexts
        return false;
    }
}

function queueDebugLog(message: string, data?: Record<string, unknown>) {
    if (!queueDebugEnabled()) return;
    sharedFrontendLogger.info(`[QueueDebug] ${message}`, data || {});
}

export type PlayerMode = "full" | "mini" | "overlay";

// Audio features for vibe mode visualization
export interface AudioFeatures {
    bpm?: number | null;
    energy?: number | null;
    valence?: number | null;
    arousal?: number | null;
    danceability?: number | null;
    keyScale?: string | null;
    instrumentalness?: number | null;
    // ML Mood predictions (Enhanced mode)
    moodHappy?: number | null;
    moodSad?: number | null;
    moodRelaxed?: number | null;
    moodAggressive?: number | null;
    moodParty?: number | null;
    moodAcoustic?: number | null;
    moodElectronic?: number | null;
    analysisMode?: string | null;
}

export interface Track {
    id: string;
    title: string;
    artist: { name: string; id?: string; mbid?: string };
    album: { title: string; coverArt?: string; id?: string };
    duration: number;
    filePath?: string;
    // Streaming source fields
    mediaSource?: CanonicalMediaSource;
    provider?: CanonicalMediaProviderIdentity;
    streamSource?: "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    // Metadata override fields
    displayTitle?: string | null;
    displayTrackNo?: number | null;
    hasUserOverrides?: boolean;
    streamBitrate?: number;
    // Audio features for vibe mode visualization
    audioFeatures?: {
        bpm?: number | null;
        energy?: number | null;
        valence?: number | null;
        arousal?: number | null;
        danceability?: number | null;
        keyScale?: string | null;
        instrumentalness?: number | null;
        analysisMode?: string | null;
        // ML mood predictions
        moodHappy?: number | null;
        moodSad?: number | null;
        moodRelaxed?: number | null;
        moodAggressive?: number | null;
        moodParty?: number | null;
        moodAcoustic?: number | null;
        moodElectronic?: number | null;
    } | null;
}

export interface Audiobook {
    id: string;
    title: string;
    author: string;
    narrator?: string;
    coverUrl: string | null;
    duration: number;
    progress?: {
        currentTime: number;
        progress: number;
        isFinished: boolean;
        lastPlayedAt: Date;
    } | null;
}

export interface Podcast {
    id: string; // Format: "podcastId:episodeId"
    title: string;
    podcastTitle: string;
    coverUrl: string | null;
    duration: number;
    progress?: {
        currentTime: number;
        progress: number;
        isFinished: boolean;
        lastPlayedAt: Date;
    } | null;
}

type SetStateAction<T> = T | ((prev: T) => T);

interface AudioStateContextType {
    // Media state
    currentTrack: Track | null;
    currentAudiobook: Audiobook | null;
    currentPodcast: Podcast | null;
    playbackType: "track" | "audiobook" | "podcast" | null;

    // Queue state
    queue: Track[];
    currentIndex: number;
    isShuffle: boolean;
    repeatMode: "off" | "one" | "all";
    isRepeat: boolean;
    shuffleIndices: number[];
    podcastEpisodeQueue: Episode[] | null;

    // UI state
    playerMode: PlayerMode;
    previousPlayerMode: PlayerMode;
    volume: number;
    isMuted: boolean;

    // Vibe mode state
    vibeMode: boolean;
    vibeSourceFeatures: AudioFeatures | null;
    vibeQueueIds: string[];

    // Internal state
    isHydrated: boolean;
    lastServerSync: Date | null;
    repeatOneCount: number;

    // State setters (for controls context)
    setCurrentTrack: (track: SetStateAction<Track | null>) => void;
    setCurrentAudiobook: (audiobook: SetStateAction<Audiobook | null>) => void;
    setCurrentPodcast: (podcast: SetStateAction<Podcast | null>) => void;
    setPlaybackType: (
        type: SetStateAction<"track" | "audiobook" | "podcast" | null>
    ) => void;
    setQueue: (queue: SetStateAction<Track[]>) => void;
    setCurrentIndex: (index: SetStateAction<number>) => void;
    setIsShuffle: (shuffle: SetStateAction<boolean>) => void;
    setRepeatMode: (mode: SetStateAction<"off" | "one" | "all">) => void;
    setShuffleIndices: (indices: SetStateAction<number[]>) => void;
    setPodcastEpisodeQueue: (queue: SetStateAction<Episode[] | null>) => void;
    setPlayerMode: (mode: SetStateAction<PlayerMode>) => void;
    setPreviousPlayerMode: (mode: SetStateAction<PlayerMode>) => void;
    setVolume: (volume: SetStateAction<number>) => void;
    setIsMuted: (muted: SetStateAction<boolean>) => void;
    setLastServerSync: (date: SetStateAction<Date | null>) => void;
    setRepeatOneCount: (count: SetStateAction<number>) => void;
    setVibeMode: (mode: SetStateAction<boolean>) => void;
    setVibeSourceFeatures: (
        features: SetStateAction<AudioFeatures | null>
    ) => void;
    setVibeQueueIds: (ids: SetStateAction<string[]>) => void;
}

const AudioStateContext = createContext<AudioStateContextType | undefined>(
    undefined
);

// LocalStorage keys
const STORAGE_KEYS = {
    CURRENT_TRACK: createMigratingStorageKey("current_track"),
    CURRENT_AUDIOBOOK: createMigratingStorageKey("current_audiobook"),
    CURRENT_PODCAST: createMigratingStorageKey("current_podcast"),
    PLAYBACK_TYPE: createMigratingStorageKey("playback_type"),
    QUEUE: createMigratingStorageKey("queue"),
    CURRENT_INDEX: createMigratingStorageKey("current_index"),
    IS_SHUFFLE: createMigratingStorageKey("is_shuffle"),
    REPEAT_MODE: createMigratingStorageKey("repeat_mode"),
    PLAYER_MODE: createMigratingStorageKey("player_mode"),
    VOLUME: createMigratingStorageKey("volume"),
    IS_MUTED: createMigratingStorageKey("muted"),
    PODCAST_EPISODE_QUEUE: createMigratingStorageKey("podcast_episode_queue"),
    CURRENT_TIME: createMigratingStorageKey("current_time"),
    CURRENT_TIME_TRACK_ID: createMigratingStorageKey("current_time_track_id"),
    LAST_PLAYBACK_STATE_SAVE_AT: createMigratingStorageKey(
        LAST_PLAYBACK_STATE_SAVE_AT_KEY_SUFFIX
    ),
    QUEUE_CLEARED_AT: createMigratingStorageKey(QUEUE_CLEARED_AT_KEY_SUFFIX),
};

function readStorage(key: MigratingStorageKey): string | null {
    return readMigratingStorageItem(key);
}

function parseStorageJson<T>(key: MigratingStorageKey, fallback: T): T {
    const raw = readStorage(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/**
 * Renders the AudioStateProvider component.
 */
export function AudioStateProvider({ children }: { children: ReactNode }) {
    const [currentTrack, setCurrentTrack] = useState<Track | null>(
        () => parseStorageJson(STORAGE_KEYS.CURRENT_TRACK, null)
    );
    const [currentAudiobook, setCurrentAudiobook] = useState<Audiobook | null>(
        () => parseStorageJson(STORAGE_KEYS.CURRENT_AUDIOBOOK, null)
    );
    const [currentPodcast, setCurrentPodcast] = useState<Podcast | null>(
        () => parseStorageJson(STORAGE_KEYS.CURRENT_PODCAST, null)
    );
    const [playbackType, setPlaybackType] = useState<
        "track" | "audiobook" | "podcast" | null
    >(() => readStorage(STORAGE_KEYS.PLAYBACK_TYPE) as "track" | "audiobook" | "podcast" | null);
    const [queue, setQueue] = useState<Track[]>(
        () => parseStorageJson(STORAGE_KEYS.QUEUE, [])
    );
    const [currentIndex, setCurrentIndex] = useState(
        () => { const v = readStorage(STORAGE_KEYS.CURRENT_INDEX); return v ? parseInt(v) : 0; }
    );
    const [isShuffle, setIsShuffle] = useState(
        () => readStorage(STORAGE_KEYS.IS_SHUFFLE) === "true"
    );
    const [shuffleIndices, setShuffleIndices] = useState<number[]>([]);
    const [repeatMode, setRepeatMode] = useState<"off" | "one" | "all">(
        () => (readStorage(STORAGE_KEYS.REPEAT_MODE) as "off" | "one" | "all") ?? "off"
    );
    const [repeatOneCount, setRepeatOneCount] = useState(0);
    const [podcastEpisodeQueue, setPodcastEpisodeQueue] = useState<Episode[] | null>(
        () => parseStorageJson(STORAGE_KEYS.PODCAST_EPISODE_QUEUE, null)
    );
    const [playerMode, setPlayerMode] = useState<PlayerMode>(
        () => (readStorage(STORAGE_KEYS.PLAYER_MODE) as PlayerMode) ?? "full"
    );
    const [previousPlayerMode, setPreviousPlayerMode] =
        useState<PlayerMode>("full");
    const [volume, setVolume] = useState(() =>
        resolveInitialAudioVolume(readStorage(STORAGE_KEYS.VOLUME))
    );
    const [isMuted, setIsMuted] = useState(
        () => readStorage(STORAGE_KEYS.IS_MUTED) === "true"
    );
    const [isHydrated] = useState(
        () => typeof window !== "undefined"
    );
    const [lastServerSync, setLastServerSync] = useState<Date | null>(null);

    // Vibe mode state
    const [vibeMode, setVibeMode] = useState(false);
    const [vibeSourceFeatures, setVibeSourceFeatures] =
        useState<AudioFeatures | null>(null);
    const [vibeQueueIds, setVibeQueueIds] = useState<string[]>([]);

    // Refresh audiobook/podcast progress from API on mount, then sync with server
    useEffect(() => {
        if (typeof window === "undefined") return;

        // Fetch fresh audiobook progress
        const savedAudiobook = readStorage(STORAGE_KEYS.CURRENT_AUDIOBOOK);
        if (savedAudiobook) {
            try {
                const audiobookData = JSON.parse(savedAudiobook);
                api.getAudiobook(audiobookData.id)
                    .then((audiobook: { progress?: { currentTime: number; progress: number; isFinished: boolean } }) => {
                        if (audiobook && audiobook.progress) {
                            setCurrentAudiobook({
                                ...audiobookData,
                                progress: audiobook.progress,
                            });
                        }
                    })
                    .catch((err: unknown) => {
                        sharedFrontendLogger.error(
                            "[AudioState] Failed to refresh audiobook progress:",
                            err
                        );
                    });
            } catch { /* ignore parse errors */ }
        }

        // Fetch fresh podcast progress
        const savedPodcast = readStorage(STORAGE_KEYS.CURRENT_PODCAST);
        if (savedPodcast) {
            try {
                const podcastData = JSON.parse(savedPodcast);
                const [podcastId, episodeId] = podcastData.id.split(":");
                if (podcastId && episodeId) {
                    api.getPodcast(podcastId)
                        .then((podcast: { title: string; coverUrl: string; episodes?: Episode[] }) => {
                            const episode = podcast.episodes?.find(
                                (ep: Episode) => ep.id === episodeId
                            );
                            if (episode && episode.progress) {
                                setCurrentPodcast({
                                    ...podcastData,
                                    progress: episode.progress,
                                });
                            }
                        })
                        .catch((err: unknown) => {
                            sharedFrontendLogger.error(
                                "[AudioState] Failed to refresh podcast progress:",
                                err
                            );
                        });
                }
            } catch { /* ignore parse errors */ }
        }

        // Load playback state from server
        api.getPlaybackState()
            .then((serverState) => {
                if (!serverState) return;

                const serverPlaybackType: PlaybackSnapshotType =
                    serverState.playbackType === "track" ||
                    serverState.playbackType === "audiobook" ||
                    serverState.playbackType === "podcast"
                        ? serverState.playbackType
                        : null;
                const serverMediaId =
                    serverState.trackId ||
                    serverState.audiobookId ||
                    serverState.podcastId ||
                    null;
                const serverQueue = Array.isArray(serverState.queue)
                    ? (serverState.queue as Track[])
                    : null;

                const hydratedLocalPlaybackTypeRaw = readStorage(
                    STORAGE_KEYS.PLAYBACK_TYPE
                );
                const hydratedLocalPlaybackType: PlaybackSnapshotType =
                    hydratedLocalPlaybackTypeRaw === "track" ||
                    hydratedLocalPlaybackTypeRaw === "audiobook" ||
                    hydratedLocalPlaybackTypeRaw === "podcast"
                        ? hydratedLocalPlaybackTypeRaw
                        : null;
                const hydratedLocalTrack = parseStorageJson<Track | null>(
                    STORAGE_KEYS.CURRENT_TRACK,
                    null
                );
                const hydratedLocalAudiobook =
                    parseStorageJson<Audiobook | null>(
                        STORAGE_KEYS.CURRENT_AUDIOBOOK,
                        null
                    );
                const hydratedLocalPodcast = parseStorageJson<Podcast | null>(
                    STORAGE_KEYS.CURRENT_PODCAST,
                    null
                );
                const hydratedLocalQueue = parseStorageJson(
                    STORAGE_KEYS.QUEUE,
                    [] as Track[]
                );
                const hydratedLocalMediaId =
                    hydratedLocalTrack?.id ||
                    hydratedLocalAudiobook?.id ||
                    hydratedLocalPodcast?.id ||
                    null;
                const localLastSaveAtMs = parsePlaybackStateSaveTimestamp(
                    readStorage(STORAGE_KEYS.LAST_PLAYBACK_STATE_SAVE_AT)
                );
                const serverUpdatedAtRaw = Date.parse(
                    String(serverState.updatedAt || "")
                );
                const serverUpdatedAtMs = Number.isFinite(serverUpdatedAtRaw)
                    ? serverUpdatedAtRaw
                    : 0;
                const startupDecision = resolveServerPlaybackPollDecision({
                    localPlaybackType: hydratedLocalPlaybackType,
                    localMediaId: hydratedLocalMediaId,
                    localQueue: hydratedLocalQueue,
                    localLastSaveAtMs,
                    serverPlaybackType,
                    serverMediaId,
                    serverQueue,
                    serverUpdatedAtMs,
                });
                if (!startupDecision.shouldApplyServerSnapshot) {
                    queueDebugLog(
                        "Startup ignored server playback snapshot",
                        {
                            reason: startupDecision.reason,
                            localPlaybackType: hydratedLocalPlaybackType,
                            serverPlaybackType,
                            localMediaId: hydratedLocalMediaId,
                            serverMediaId,
                            localQueueLen: hydratedLocalQueue.length,
                            serverQueueLen: serverQueue?.length || 0,
                            serverUpdatedAt: serverState.updatedAt,
                        }
                    );
                    return;
                }

                if (
                    serverPlaybackType === "track" &&
                    serverState.trackId
                ) {
                    api.getTrack(serverState.trackId)
                        .then((track) => {
                            setCurrentTrack(track);
                            setPlaybackType("track");
                            setCurrentAudiobook(null);
                            setCurrentPodcast(null);
                        })
                        .catch(() => {
                            // Fire-and-forget: clearing stale server state, failure is non-critical
                            api.clearPlaybackState().catch(() => {});
                            setCurrentTrack(null);
                            setCurrentAudiobook(null);
                            setCurrentPodcast(null);
                            setPlaybackType(null);
                            setQueue([]);
                            setCurrentIndex(0);
                        });
                } else if (
                    serverPlaybackType === "audiobook" &&
                    serverState.audiobookId
                ) {
                    api.getAudiobook(serverState.audiobookId).then(
                        (audiobook) => {
                            setCurrentAudiobook(audiobook);
                            setPlaybackType("audiobook");
                            setCurrentTrack(null);
                            setCurrentPodcast(null);
                        }
                    );
                } else if (
                    serverPlaybackType === "podcast" &&
                    serverState.podcastId
                ) {
                    const [podcastId, episodeId] =
                        serverState.podcastId.split(":");
                    api.getPodcast(podcastId).then((podcast: { title: string; coverUrl: string; episodes?: Episode[] }) => {
                        const episode = podcast.episodes?.find(
                            (ep: Episode) => ep.id === episodeId
                        );
                        if (episode) {
                            setCurrentPodcast({
                                id: serverState.podcastId,
                                title: episode.title,
                                podcastTitle: podcast.title,
                                coverUrl: podcast.coverUrl,
                                duration: episode.duration,
                                progress: episode.progress,
                            });
                            setPlaybackType("podcast");
                            setCurrentTrack(null);
                            setCurrentAudiobook(null);
                        }
                    });
                }
                if (
                    serverQueue &&
                    !queuesMatchByTrackId(hydratedLocalQueue, serverQueue)
                ) {
                    setQueue(serverQueue);
                }
                if (serverQueue) {
                    setCurrentIndex(
                        normalizeQueueIndex(
                            serverState.currentIndex,
                            serverQueue.length
                        )
                    );
                }
                if (serverState.isShuffle !== undefined)
                    setIsShuffle(serverState.isShuffle);
                    if (
                        typeof serverState.currentTime === "number" &&
                        Number.isFinite(serverState.currentTime)
                    ) {
                            const safeCurrentTime = clampNonNegativePlaybackTime(
                                serverState.currentTime
                            );
                            try {
                            writeMigratingStorageItem(
                                STORAGE_KEYS.CURRENT_TIME,
                                String(safeCurrentTime)
                            );
                            if (
                                serverState.playbackType === "track" &&
                                typeof serverState.trackId === "string" &&
                                serverState.trackId
                            ) {
                                writeMigratingStorageItem(
                                    STORAGE_KEYS.CURRENT_TIME_TRACK_ID,
                                    serverState.trackId
                                );
                            } else {
                                removeMigratingStorageItem(STORAGE_KEYS.CURRENT_TIME_TRACK_ID);
                            }
                        } catch {
                            // Ignore storage failures (private mode/quota/etc.)
                        }
                    }
            })
            .catch(() => {
                // No server state available - this is expected on first load
            });
    }, []);

    // Effect A (debounced): Persist heavy JSON blobs to localStorage.
    // Debounced at 300ms to coalesce rapid state changes (e.g. queue updates).
    const storageFlushRef = useRef(createDebouncedStorageFlush(300));

    useEffect(() => {
        if (!isHydrated || typeof window === "undefined") return;

        // Snapshot current values for the debounced callback
        const snapshot = {
            currentTrack,
            currentAudiobook,
            currentPodcast,
            playbackType,
            queue,
            currentIndex,
            isShuffle,
            podcastEpisodeQueue,
        };

        storageFlushRef.current.schedule(() => {
            try {
                if (snapshot.currentTrack) {
                    writeMigratingStorageItem(
                        STORAGE_KEYS.CURRENT_TRACK,
                        JSON.stringify(snapshot.currentTrack)
                    );
                } else {
                    removeMigratingStorageItem(STORAGE_KEYS.CURRENT_TRACK);
                }
                if (snapshot.currentAudiobook) {
                    writeMigratingStorageItem(
                        STORAGE_KEYS.CURRENT_AUDIOBOOK,
                        JSON.stringify(snapshot.currentAudiobook)
                    );
                } else {
                    removeMigratingStorageItem(STORAGE_KEYS.CURRENT_AUDIOBOOK);
                }
                if (snapshot.currentPodcast) {
                    writeMigratingStorageItem(
                        STORAGE_KEYS.CURRENT_PODCAST,
                        JSON.stringify(snapshot.currentPodcast)
                    );
                } else {
                    removeMigratingStorageItem(STORAGE_KEYS.CURRENT_PODCAST);
                }
                if (snapshot.playbackType) {
                    writeMigratingStorageItem(STORAGE_KEYS.PLAYBACK_TYPE, snapshot.playbackType);
                } else {
                    removeMigratingStorageItem(STORAGE_KEYS.PLAYBACK_TYPE);
                }
                writeMigratingStorageItem(STORAGE_KEYS.QUEUE, JSON.stringify(snapshot.queue));
                writeMigratingStorageItem(
                    STORAGE_KEYS.CURRENT_INDEX,
                    snapshot.currentIndex.toString()
                );
                writeMigratingStorageItem(STORAGE_KEYS.IS_SHUFFLE, snapshot.isShuffle.toString());
                if (snapshot.podcastEpisodeQueue) {
                    writeMigratingStorageItem(
                        STORAGE_KEYS.PODCAST_EPISODE_QUEUE,
                        JSON.stringify(snapshot.podcastEpisodeQueue)
                    );
                } else {
                    removeMigratingStorageItem(STORAGE_KEYS.PODCAST_EPISODE_QUEUE);
                }
            } catch (error) {
                sharedFrontendLogger.error("[AudioState] Failed to save state (debounced):", error);
            }
        });

        return () => { storageFlushRef.current.flush(); };
    }, [
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        queue,
        currentIndex,
        isShuffle,
        podcastEpisodeQueue,
        isHydrated,
    ]);

    // Effect B (immediate): Persist cheap scalar values to localStorage.
    useEffect(() => {
        if (!isHydrated || typeof window === "undefined") return;

        try {
            writeMigratingStorageItem(STORAGE_KEYS.REPEAT_MODE, repeatMode);
            writeMigratingStorageItem(STORAGE_KEYS.PLAYER_MODE, playerMode);
            writeMigratingStorageItem(STORAGE_KEYS.VOLUME, volume.toString());
            writeMigratingStorageItem(STORAGE_KEYS.IS_MUTED, isMuted.toString());
        } catch (error) {
            sharedFrontendLogger.error("[AudioState] Failed to save scalar state:", error);
        }
    }, [repeatMode, playerMode, volume, isMuted, isHydrated]);

    // Refs for poll effect — read inside setInterval so deps stay stable at [isHydrated]
    const queueRef = useRef(queue);
    const currentIndexRef = useRef(currentIndex);
    const isShuffleRef = useRef(isShuffle);
    const lastServerSyncRef = useRef(lastServerSync);
    const playbackTypeRef = useRef(playbackType);
    const currentTrackIdRef = useRef(currentTrack?.id);
    const currentAudiobookIdRef = useRef(currentAudiobook?.id);
    const currentPodcastIdRef = useRef(currentPodcast?.id);
    const pollInFlightRef = useRef(false);

    // Sync refs via lightweight effects
    useEffect(() => { queueRef.current = queue; }, [queue]);
    useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
    useEffect(() => { isShuffleRef.current = isShuffle; }, [isShuffle]);
    useEffect(() => { lastServerSyncRef.current = lastServerSync; }, [lastServerSync]);
    useEffect(() => { playbackTypeRef.current = playbackType; }, [playbackType]);
    useEffect(() => { currentTrackIdRef.current = currentTrack?.id; }, [currentTrack?.id]);
    useEffect(() => { currentAudiobookIdRef.current = currentAudiobook?.id; }, [currentAudiobook?.id]);
    useEffect(() => { currentPodcastIdRef.current = currentPodcast?.id; }, [currentPodcast?.id]);

    // Poll server for persisted changes for this device (pauses when tab is hidden)
    useEffect(() => {
        if (!isHydrated) return;
        if (typeof document === "undefined") return;

        let isAuthenticated = true;
        let mounted = true;
        let isVisible = !document.hidden;

        // Handle visibility changes to save battery/resources
        const handleVisibilityChange = () => {
            isVisible = !document.hidden;
        };
        document.addEventListener("visibilitychange", handleVisibilityChange);

        let pollInterval: ReturnType<typeof setInterval> | null = null;
        const pollCallback = async () => {
            // Skip polling when tab is hidden, unmounted, or not authenticated
            if (!isAuthenticated || !mounted || !isVisible) return;
            // Prevent overlapping async poll calls
            if (pollInFlightRef.current) return;
            pollInFlightRef.current = true;

            try {
                const lastLocalSave = parsePlaybackStateSaveTimestamp(
                    readStorage(STORAGE_KEYS.LAST_PLAYBACK_STATE_SAVE_AT)
                );
                if (shouldSkipPlaybackStatePoll(lastLocalSave)) {
                    return;
                }

                // Read current state from refs
                const localQueue = queueRef.current;
                const localCurrentIndex = currentIndexRef.current;
                const localIsShuffle = isShuffleRef.current;
                const localLastServerSync = lastServerSyncRef.current;
                const localPlaybackType = playbackTypeRef.current;
                const localCurrentTrackId = currentTrackIdRef.current;
                const localCurrentAudiobookId = currentAudiobookIdRef.current;
                const localCurrentPodcastId = currentPodcastIdRef.current;

                // If the queue was recently cleared, skip adopting server state
                const queueClearedAt = parsePlaybackStateSaveTimestamp(
                    readStorage(STORAGE_KEYS.QUEUE_CLEARED_AT)
                );
                if (queueClearedAt > 0 && localQueue.length === 0) {
                    if (Date.now() - queueClearedAt < 60_000) {
                        return;
                    }
                    removeMigratingStorageItem(STORAGE_KEYS.QUEUE_CLEARED_AT);
                }

                const serverState = await api.getPlaybackState();
                if (!serverState || !mounted) return;

                const serverUpdatedAtMs = Date.parse(
                    String(serverState.updatedAt || "")
                );
                if (!Number.isFinite(serverUpdatedAtMs)) {
                    return;
                }
                const serverUpdatedAt = new Date(serverUpdatedAtMs);

                if (
                    localLastServerSync &&
                    serverUpdatedAt.getTime() <= localLastServerSync.getTime()
                ) {
                    return;
                }

                const serverPlaybackType: PlaybackSnapshotType =
                    serverState.playbackType === "track" ||
                    serverState.playbackType === "audiobook" ||
                    serverState.playbackType === "podcast"
                        ? serverState.playbackType
                        : null;

                const serverMediaId =
                    serverState.trackId ||
                    serverState.audiobookId ||
                    serverState.podcastId;
                const currentMediaId =
                    localCurrentTrackId ||
                    localCurrentAudiobookId ||
                    localCurrentPodcastId;

                const serverQueue = Array.isArray(serverState.queue)
                    ? (serverState.queue as Track[])
                    : null;
                const pollDecision = resolveServerPlaybackPollDecision({
                    localPlaybackType: localPlaybackType,
                    localMediaId: currentMediaId || null,
                    localQueue: localQueue,
                    localLastSaveAtMs: lastLocalSave,
                    serverPlaybackType,
                    serverMediaId: serverMediaId || null,
                    serverQueue,
                    serverUpdatedAtMs,
                });
                if (!pollDecision.shouldApplyServerSnapshot) {
                    queueDebugLog("Polling ignored server playback snapshot", {
                        reason: pollDecision.reason,
                        localPlaybackType: localPlaybackType,
                        serverPlaybackType,
                        localMediaId: currentMediaId,
                        serverMediaId,
                        localQueueLen: localQueue.length,
                        serverQueueLen: serverQueue?.length || 0,
                        serverUpdatedAt: serverState.updatedAt,
                    });
                    setLastServerSync(serverUpdatedAt);
                    return;
                }

                if (
                    serverMediaId !== currentMediaId ||
                    serverPlaybackType !== localPlaybackType
                ) {
                    if (
                        serverPlaybackType === "track" &&
                        serverState.trackId
                    ) {
                        try {
                            const track = await api.getTrack(
                                serverState.trackId
                            );
                            if (!mounted) return;
                            setCurrentTrack(track);
                            setPlaybackType("track");
                            setCurrentAudiobook(null);
                            setCurrentPodcast(null);
                            if (serverQueue && serverQueue.length > 0) {
                                if (!queuesMatchByTrackId(localQueue, serverQueue)) {
                                    setQueue(serverQueue);
                                }
                                setCurrentIndex(
                                    normalizeQueueIndex(
                                        serverState.currentIndex,
                                        serverQueue.length
                                    )
                                );
                                setIsShuffle(Boolean(serverState.isShuffle));
                            }
                        } catch {
                            if (!mounted) return;
                            await api.clearPlaybackState().catch(() => {});
                            setCurrentTrack(null);
                            setCurrentAudiobook(null);
                            setCurrentPodcast(null);
                            setPlaybackType(null);
                            setQueue([]);
                            setCurrentIndex(0);
                            return;
                        }
                    } else if (
                        serverPlaybackType === "audiobook" &&
                        serverState.audiobookId
                    ) {
                        const audiobook = await api.getAudiobook(
                            serverState.audiobookId
                        );
                        if (!mounted) return;
                        setCurrentAudiobook(audiobook);
                        setPlaybackType("audiobook");
                        setCurrentTrack(null);
                        setCurrentPodcast(null);
                    } else if (
                        serverPlaybackType === "podcast" &&
                        serverState.podcastId
                    ) {
                        const [podcastId, episodeId] =
                            serverState.podcastId.split(":");
                        const podcast: { title: string; coverUrl: string; episodes?: Episode[] } = await api.getPodcast(podcastId);
                        if (!mounted) return;
                        const episode = podcast.episodes?.find(
                            (ep: Episode) => ep.id === episodeId
                        );
                        if (episode) {
                            setCurrentPodcast({
                                id: serverState.podcastId,
                                title: episode.title,
                                podcastTitle: podcast.title,
                                coverUrl: podcast.coverUrl,
                                duration: episode.duration,
                                progress: episode.progress,
                            });
                            setPlaybackType("podcast");
                            setCurrentTrack(null);
                            setCurrentAudiobook(null);
                        }
                    }

                    if (!mounted) return;
                    if (
                        serverQueue &&
                        serverQueue.length > 0 &&
                        !queuesMatchByTrackId(localQueue, serverQueue)
                    ) {
                        queueDebugLog("Polling applied server queue", {
                            reason: pollDecision.reason,
                            serverQueueLen: serverQueue.length,
                            localQueueLen: localQueue?.length || 0,
                            serverCurrentIndex: normalizeQueueIndex(
                                serverState.currentIndex,
                                serverQueue.length
                            ),
                            localCurrentIndex: localCurrentIndex,
                            serverIsShuffle: serverState.isShuffle,
                            localIsShuffle: localIsShuffle,
                            serverUpdatedAt: serverState.updatedAt,
                        });
                        setQueue(serverQueue);
                        setCurrentIndex(
                            normalizeQueueIndex(
                                serverState.currentIndex,
                                serverQueue.length
                            )
                        );
                        setIsShuffle(Boolean(serverState.isShuffle));
                    }

                    setLastServerSync(serverUpdatedAt);
                }
            } catch (err: unknown) {
                if (err instanceof Error && err.message === "Not authenticated") {
                    isAuthenticated = false;
                    if (pollInterval) clearInterval(pollInterval);
                }
            } finally {
                pollInFlightRef.current = false;
            }
        };

        // Start polling with jitter to prevent alignment with other intervals
        const jitterDelay = resolvePollingJitter(8000);
        const jitterTimeout = setTimeout(() => {
            pollInterval = setInterval(pollCallback, 30000);
        }, jitterDelay);

        return () => {
            mounted = false;
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange
            );
            clearTimeout(jitterTimeout);
            if (pollInterval) clearInterval(pollInterval);
        };
    }, [isHydrated]);

    // Memoize the context value to prevent unnecessary re-renders
    const value = useMemo(
        () => ({
            currentTrack,
            currentAudiobook,
            currentPodcast,
            playbackType,
            queue,
            currentIndex,
            isShuffle,
            repeatMode,
            isRepeat: repeatMode !== "off",
            shuffleIndices,
            podcastEpisodeQueue,
            playerMode,
            previousPlayerMode,
            volume,
            isMuted,
            vibeMode,
            vibeSourceFeatures,
            vibeQueueIds,
            isHydrated,
            lastServerSync,
            repeatOneCount,
            setCurrentTrack,
            setCurrentAudiobook,
            setCurrentPodcast,
            setPlaybackType,
            setQueue,
            setCurrentIndex,
            setIsShuffle,
            setRepeatMode,
            setShuffleIndices,
            setPodcastEpisodeQueue,
            setPlayerMode,
            setPreviousPlayerMode,
            setVolume,
            setIsMuted,
            setLastServerSync,
            setRepeatOneCount,
            setVibeMode,
            setVibeSourceFeatures,
            setVibeQueueIds,
        }),
        [
            currentTrack,
            currentAudiobook,
            currentPodcast,
            playbackType,
            queue,
            currentIndex,
            isShuffle,
            repeatMode,
            shuffleIndices,
            podcastEpisodeQueue,
            playerMode,
            previousPlayerMode,
            volume,
            isMuted,
            vibeMode,
            vibeSourceFeatures,
            vibeQueueIds,
            isHydrated,
            lastServerSync,
            repeatOneCount,
        ]
    );

    return (
        <AudioStateContext.Provider value={value}>
            {children}
        </AudioStateContext.Provider>
    );
}

/**
 * Executes useAudioState.
 */
export function useAudioState() {
    const context = useContext(AudioStateContext);
    if (!context) {
        throw new Error("useAudioState must be used within AudioStateProvider");
    }
    return context;
}
