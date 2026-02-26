import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = (props: Record<string, unknown>) => React.createElement("i", props);

const state = {
    hasMedia: true,
    mediaTitle: "Test Track",
    mediaSubtitle: "Test Artist",
    currentTrack: {
        id: "track-1",
        duration: 200,
        audioFeatures: null as null | Record<string, number>,
    },
    currentAudiobook: null as null | {
        id: string;
        duration?: number;
        progress?: { currentTime?: number };
    },
    currentPodcast: null as null | {
        id: string;
        duration?: number;
        progress?: { currentTime?: number };
    },
    playbackType: "track" as "track" | "audiobook" | "podcast" | null,
    volume: 0.8,
    isMuted: false,
    isShuffle: false,
    repeatMode: "off" as "off" | "all" | "one",
    vibeMode: false,
    vibeSourceFeatures: null as null | Record<string, number>,
    queue: [{ audioFeatures: null as null | Record<string, number> }],
    currentIndex: 0,
    isPlaying: false,
    isBuffering: false,
    currentTime: 12,
    duration: 200,
    canSeek: true,
    downloadProgress: null as number | null,
    audioError: null as string | null,
};

mock.module("lucide-react", {
    namedExports: {
        Play: Icon,
        Pause: Icon,
        SkipBack: Icon,
        SkipForward: Icon,
        Volume2: Icon,
        VolumeX: Icon,
        ChevronUp: Icon,
        Music: Icon,
        Shuffle: Icon,
        Repeat: Icon,
        Repeat1: Icon,
        Loader2: Icon,
        AudioWaveform: Icon,
        RefreshCw: Icon,
        Info: Icon,
        Heart: Icon,
        ThumbsUp: Icon,
        ThumbsDown: Icon,
        Users: Icon,
    },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", {
            src: props.src as string,
            alt: props.alt as string,
        }),
});

mock.module("next/link", {
    defaultExport: (
        props: {
            href: string;
            children?: React.ReactNode;
            [key: string]: unknown;
        },
    ) => React.createElement("a", { href: props.href }, props.children),
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: state.currentTrack,
            currentAudiobook: state.currentAudiobook,
            currentPodcast: state.currentPodcast,
            playbackType: state.playbackType,
            volume: state.volume,
            isMuted: state.isMuted,
            isShuffle: state.isShuffle,
            repeatMode: state.repeatMode,
            vibeMode: state.vibeMode,
            vibeSourceFeatures: state.vibeSourceFeatures,
            queue: state.queue,
            currentIndex: state.currentIndex,
        }),
    },
});

mock.module("@/lib/audio-playback-context", {
    namedExports: {
        useAudioPlayback: () => ({
            isPlaying: state.isPlaying,
            isBuffering: state.isBuffering,
            currentTime: state.currentTime,
            duration: state.duration,
            canSeek: state.canSeek,
            downloadProgress: state.downloadProgress,
            audioError: state.audioError,
            clearAudioError: () => undefined,
        }),
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            pause: () => undefined,
            resume: () => undefined,
            next: () => undefined,
            previous: () => undefined,
            setPlayerMode: () => undefined,
            seek: () => undefined,
            setVolume: () => undefined,
            toggleMute: () => undefined,
            toggleShuffle: () => undefined,
            toggleRepeat: () => undefined,
        }),
    },
});

mock.module("@/hooks/useMediaInfo", {
    namedExports: {
        useMediaInfo: () => ({
            title: state.mediaTitle,
            subtitle: state.mediaSubtitle,
            coverUrl: null,
            artistLink: null,
            mediaLink: null,
            hasMedia: state.hasMedia,
        }),
    },
});

mock.module("@/hooks/useStreamBitrate", {
    namedExports: {
        useStreamBitrate: () => ({
            qualityBadge: null,
        }),
    },
});

mock.module("@/hooks/useTrackPreference", {
    namedExports: {
        useTrackPreference: () => ({
            signal: "clear",
            isSaving: false,
            toggleLike: () => undefined,
        }),
    },
});

mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => ({
            musicCNN: false,
            vibeEmbeddings: false,
            loading: false,
        }),
    },
});

mock.module("@/components/player/SyncBadge", {
    namedExports: {
        SyncBadge: () => null,
    },
});

beforeEach(() => {
    state.hasMedia = true;
    state.mediaTitle = "Test Track";
    state.mediaSubtitle = "Test Artist";
    state.currentTrack = {
        id: "track-1",
        duration: 200,
        audioFeatures: null,
    };
    state.currentAudiobook = null;
    state.currentPodcast = null;
    state.playbackType = "track";
    state.volume = 0.8;
    state.isMuted = false;
    state.isShuffle = false;
    state.repeatMode = "off";
    state.vibeMode = false;
    state.vibeSourceFeatures = null;
    state.queue = [{ audioFeatures: null }];
    state.currentIndex = 0;
    state.isPlaying = false;
    state.isBuffering = false;
    state.currentTime = 12;
    state.duration = 200;
    state.canSeek = true;
    state.downloadProgress = null;
    state.audioError = null;
});

test("FullPlayer shows retry affordance when audioError is present", async () => {
    state.audioError = "network failure";

    const { FullPlayer } = await import("../../components/player/FullPlayer.tsx");
    const html = renderToStaticMarkup(React.createElement(FullPlayer));

    assert.match(html, /aria-label="Retry playback"/);
    assert.match(html, /title="Retry playback"/);
});

test("FullPlayer uses podcast saved progress when live currentTime is zero", async () => {
    state.playbackType = "podcast";
    state.currentTrack = null;
    state.currentPodcast = {
        id: "pod-1",
        duration: 300,
        progress: {
            currentTime: 120,
        },
    };
    state.mediaTitle = "Podcast Episode";
    state.currentTime = 0;
    state.duration = 0;

    const { FullPlayer } = await import("../../components/player/FullPlayer.tsx");
    const html = renderToStaticMarkup(React.createElement(FullPlayer));

    assert.match(html, />2:00</);
    assert.match(html, />-3:00</);
});
