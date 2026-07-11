import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Component tests for issue #20: wire the existing 15-second skip
 * back/forward controls (audio-controls-context.tsx: skipBackward/skipForward)
 * to player UI buttons.
 *
 * Real DOM is required (not renderToStaticMarkup) because the assertion that
 * matters is behavioural: clicking the new button must invoke
 * skipBackward(15)/skipForward(15) at the audio-controls boundary. SSR string
 * rendering strips event handlers entirely, so this suite mounts FullPlayer
 * and OverlayPlayer for real under happy-dom via react-dom/client + act,
 * exactly like universalPlayerRenderCount.component.test.ts and
 * audioPlaybackStoragePrecision.component.test.ts.
 *
 * Every dependency is boundary-mocked (data hooks + child components reached
 * via an "@/" alias) so only FullPlayer's/OverlayPlayer's own render logic
 * plus the new buttons are under test. A few real, relative-imported leaves
 * (./SeekSlider, ./TrackPreferenceButtons, ./SyncedLyrics) are left
 * unmocked because `mock.module` resolves relative specifiers against the
 * *importing* file, not this test file — each was audited to be
 * self-contained (no unmocked network/effect calls) or unreachable given the
 * fixture state below (SyncedLyrics only mounts inside the lyrics tab, which
 * this fixture never opens).
 */

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

const Icon = (props: Record<string, unknown>) => React.createElement("i", props);

// ---------------------------------------------------------------------------
// Shared leaf mocks (specifiers used by both FullPlayer and OverlayPlayer)
// ---------------------------------------------------------------------------

mock.module("lucide-react", {
    namedExports: {
        Play: Icon,
        Pause: Icon,
        SkipBack: Icon,
        SkipForward: Icon,
        RotateCcw: Icon,
        RotateCw: Icon,
        Volume2: Icon,
        VolumeX: Icon,
        ChevronUp: Icon,
        ChevronDown: Icon,
        Music: Icon,
        ListMusic: Icon,
        Shuffle: Icon,
        Repeat: Icon,
        Repeat1: Icon,
        Loader2: Icon,
        AudioWaveform: Icon,
        RefreshCw: Icon,
        Radio: Icon,
        Heart: Icon,
        Trash2: Icon,
        X: Icon,
        Plus: Icon,
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
        props: { href: string; children?: React.ReactNode; [key: string]: unknown },
    ) => React.createElement("a", { href: props.href }, props.children),
});

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            push: () => undefined,
            back: () => undefined,
            replace: () => undefined,
            prefetch: () => undefined,
        }),
        usePathname: () => "/",
    },
});

// NOTE: referenced before its textual declaration below — safe because this
// factory only reads `fullPlayerState` when React actually calls the mocked
// hook (during a test's mount), by which point the whole module (including
// the `fullPlayerState` const) has finished initializing.
mock.module("@/hooks/useMediaInfo", {
    namedExports: {
        useMediaInfo: () => ({
            title: "Test Media",
            subtitle: "Test Subtitle",
            coverUrl: null,
            artistLink: null,
            mediaLink: null,
            hasMedia: !!(
                fullPlayerState.currentTrack ||
                fullPlayerState.currentAudiobook ||
                fullPlayerState.currentPodcast
            ),
        }),
    },
});

mock.module("@/hooks/useStreamBitrate", {
    namedExports: {
        useStreamBitrate: () => ({ qualityBadge: null }),
        resolvePlaybackQualityBadgeFromStreamSource: () => null,
    },
});

mock.module("@/hooks/useTrackPreference", {
    namedExports: {
        buildPreferenceMetadata: () => undefined,
        useTrackPreference: () => ({
            signal: "clear",
            isSaving: false,
            toggleLike: async () => undefined,
        }),
    },
});

mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => ({ musicCNN: false, vibeEmbeddings: false, loading: false }),
    },
});

mock.module("@/components/player/SyncBadge", {
    namedExports: { SyncBadge: () => null },
});

mock.module("@/components/ui/TrackOverflowMenu", {
    namedExports: {
        TrackOverflowMenu: () => null,
        TrackMenuButton: () => null,
    },
});

// ---------------------------------------------------------------------------
// FullPlayer-only mocks (granular audio contexts)
// ---------------------------------------------------------------------------

const fullPlayerState = {
    currentTrack: { id: "track-1", duration: 200, audioFeatures: null as null | Record<string, number> },
    currentAudiobook: null as null | { id: string; duration?: number; progress?: { currentTime?: number } },
    currentPodcast: null as null | { id: string; duration?: number; progress?: { currentTime?: number } },
    playbackType: "track" as "track" | "audiobook" | "podcast" | null,
    volume: 0.8,
    isMuted: false,
    isShuffle: false,
    repeatMode: "off" as "off" | "all" | "one",
    vibeMode: false,
    vibeSourceFeatures: null as null | Record<string, number>,
    queue: [{ audioFeatures: null as null | Record<string, number> }],
    currentIndex: 0,
    playerMode: "full",
    isPlaying: false,
    isBuffering: false,
    currentTime: 12,
    duration: 200,
    canSeek: true,
    downloadProgress: null as number | null,
    audioError: null as string | null,
};

const fullPlayerCalls = {
    skipBackward: [] as number[],
    skipForward: [] as number[],
    previous: 0,
    next: 0,
};

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: fullPlayerState.currentTrack,
            currentAudiobook: fullPlayerState.currentAudiobook,
            currentPodcast: fullPlayerState.currentPodcast,
            playbackType: fullPlayerState.playbackType,
            volume: fullPlayerState.volume,
            isMuted: fullPlayerState.isMuted,
            isShuffle: fullPlayerState.isShuffle,
            repeatMode: fullPlayerState.repeatMode,
            vibeMode: fullPlayerState.vibeMode,
            vibeSourceFeatures: fullPlayerState.vibeSourceFeatures,
            queue: fullPlayerState.queue,
            currentIndex: fullPlayerState.currentIndex,
            playerMode: fullPlayerState.playerMode,
        }),
    },
});

mock.module("@/lib/audio-playback-context", {
    namedExports: {
        useAudioPlayback: () => ({
            isPlaying: fullPlayerState.isPlaying,
            isBuffering: fullPlayerState.isBuffering,
            currentTime: fullPlayerState.currentTime,
            duration: fullPlayerState.duration,
            canSeek: fullPlayerState.canSeek,
            downloadProgress: fullPlayerState.downloadProgress,
            audioError: fullPlayerState.audioError,
            clearAudioError: () => undefined,
        }),
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            pause: () => undefined,
            resume: () => undefined,
            next: () => {
                fullPlayerCalls.next += 1;
            },
            previous: () => {
                fullPlayerCalls.previous += 1;
            },
            setPlayerMode: () => undefined,
            returnToPreviousMode: () => undefined,
            seek: () => undefined,
            setVolume: () => undefined,
            toggleMute: () => undefined,
            toggleShuffle: () => undefined,
            toggleRepeat: () => undefined,
            startVibeMode: async () => ({ success: false, trackCount: 0 }),
            stopVibeMode: () => undefined,
            setUpcoming: () => undefined,
            skipForward: (seconds: number = 30) => {
                fullPlayerCalls.skipForward.push(seconds);
            },
            skipBackward: (seconds: number = 30) => {
                fullPlayerCalls.skipBackward.push(seconds);
            },
        }),
    },
});

// ---------------------------------------------------------------------------
// OverlayPlayer-only mocks (compat useAudio() + its extra leaves)
// ---------------------------------------------------------------------------

const overlayState = {
    currentTrack: null as null | { id: string; duration?: number },
    currentAudiobook: null as null | { id: string; duration?: number },
    currentPodcast: {
        id: "pod-1",
        duration: 1800,
        progress: null as null | { currentTime: number },
    } as null | { id: string; duration?: number; progress?: { currentTime: number } | null },
    playbackType: "podcast" as "track" | "audiobook" | "podcast" | null,
    isPlaying: false,
    isBuffering: false,
    currentTime: 60,
    canSeek: true,
    downloadProgress: null as number | null,
    isShuffle: false,
    repeatMode: "off" as "off" | "all" | "one",
    vibeMode: false,
    audioError: null as string | null,
    duration: 1800,
    queue: [{}],
    currentIndex: 0,
};

const overlayCalls = {
    skipBackward: [] as number[],
    skipForward: [] as number[],
    previous: 0,
    next: 0,
};

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudio: () => ({
            currentTrack: overlayState.currentTrack,
            currentAudiobook: overlayState.currentAudiobook,
            currentPodcast: overlayState.currentPodcast,
            playbackType: overlayState.playbackType,
            isPlaying: overlayState.isPlaying,
            isBuffering: overlayState.isBuffering,
            currentTime: overlayState.currentTime,
            canSeek: overlayState.canSeek,
            downloadProgress: overlayState.downloadProgress,
            isShuffle: overlayState.isShuffle,
            repeatMode: overlayState.repeatMode,
            vibeMode: overlayState.vibeMode,
            audioError: overlayState.audioError,
            clearAudioError: () => undefined,
            pause: () => undefined,
            resume: () => undefined,
            next: () => {
                overlayCalls.next += 1;
            },
            previous: () => {
                overlayCalls.previous += 1;
            },
            returnToPreviousMode: () => undefined,
            seek: () => undefined,
            toggleShuffle: () => undefined,
            toggleRepeat: () => undefined,
            startVibeMode: async () => ({ success: false, trackCount: 0 }),
            stopVibeMode: () => undefined,
            duration: overlayState.duration,
            queue: overlayState.queue,
            currentIndex: overlayState.currentIndex,
            playTrack: () => undefined,
            playQueueIndex: () => undefined,
            setUpcoming: () => undefined,
            removeFromQueue: () => undefined,
            clearQueue: () => undefined,
            skipForward: (seconds: number = 30) => {
                overlayCalls.skipForward.push(seconds);
            },
            skipBackward: (seconds: number = 30) => {
                overlayCalls.skipBackward.push(seconds);
            },
        }),
    },
});

mock.module("@/hooks/useLyrics", {
    namedExports: {
        useLyrics: () => ({ data: null, isLoading: false, isError: false }),
    },
});

// @tanstack/react-query is used for real (wrapped in a QueryClientProvider at
// mount time below), matching the established pattern in
// myLikedPlaylist.component.test.ts / playlistDetailProviderPlayability.component.test.ts
// rather than mocking the module — `--experimental-test-module-mocks` does not
// reliably intercept it. All 3 of OverlayPlayer's useQuery calls are gated by
// `enabled: isTabPanelVisible && activeTab === "related" && ...`, which stays
// false for the whole fixture below (activeTab defaults to "queue", the drawer
// never opens), so no query ever fetches.

mock.module("framer-motion", {
    namedExports: {
        AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
            (children ?? null) as React.ReactElement | null,
        motion: new Proxy(
            {},
            {
                get: (_target, tagName: string) => {
                    const MotionTag = React.forwardRef(
                        (props: { children?: React.ReactNode }, ref) =>
                            React.createElement(String(tagName), { ref }, props.children),
                    );
                    MotionTag.displayName = `motion.${String(tagName)}`;
                    return MotionTag;
                },
            },
        ),
        useReducedMotion: () => false,
    },
});

mock.module("@/hooks/useMediaQuery", {
    namedExports: {
        useIsMobile: () => true,
        useIsTablet: () => false,
    },
});

mock.module("sonner", {
    namedExports: {
        toast: {
            success: () => undefined,
            error: () => undefined,
            info: () => undefined,
        },
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: new Proxy({}, { get: () => async () => null }),
    },
});

mock.module("@/components/ui/TidalBadge", { namedExports: { TidalBadge: () => null } });
mock.module("@/components/ui/YouTubeBadge", { namedExports: { YouTubeBadge: () => null } });

mock.module("@/lib/listen-together-context", {
    namedExports: {
        useListenTogether: () => ({ isInGroup: false, isHost: false, syncSetTrack: () => undefined }),
    },
});

mock.module("@/lib/storage-migration", {
    namedExports: {
        OVERLAY_ACTIVE_TAB_STORAGE_KEY: "overlay_active_tab",
        readMigratingStorageItem: () => null,
        writeMigratingStorageItem: () => undefined,
    },
});

mock.module("@/components/ui/PlaylistSelector", {
    namedExports: { PlaylistSelector: () => null },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: () => undefined,
            warn: () => undefined,
            info: () => undefined,
            debug: () => undefined,
        },
    },
});

mock.module("@/lib/trackRef", {
    namedExports: {
        toAddToPlaylistRef: () => ({}),
        isRemoteTrack: () => false,
    },
});

mock.module("@/utils/artistRoute", {
    namedExports: { getArtistHref: () => null },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // best-effort teardown
    }
});

beforeEach(() => {
    fullPlayerCalls.skipBackward.length = 0;
    fullPlayerCalls.skipForward.length = 0;
    fullPlayerCalls.previous = 0;
    fullPlayerCalls.next = 0;
    fullPlayerState.playbackType = "track";
    fullPlayerState.currentTrack = { id: "track-1", duration: 200, audioFeatures: null };
    fullPlayerState.queue = [{ audioFeatures: null }];
    fullPlayerState.canSeek = true;

    overlayCalls.skipBackward.length = 0;
    overlayCalls.skipForward.length = 0;
    overlayCalls.previous = 0;
    overlayCalls.next = 0;
    overlayState.playbackType = "podcast";
    overlayState.currentPodcast = { id: "pod-1", duration: 1800, progress: null };
    overlayState.queue = [{}];
    overlayState.canSeek = true;
});

async function mount(element: React.ReactElement) {
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(element);
    });
    await React.act(async () => {
        await Promise.resolve();
    });
    return { container, root };
}

async function unmount(mounted: { container: HTMLDivElement; root: { unmount: () => void } }) {
    await React.act(async () => {
        mounted.root.unmount();
    });
    mounted.container.remove();
}

function withQueryClient(element: React.ReactElement) {
    return React.createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        element,
    );
}

// ---------------------------------------------------------------------------
// FullPlayer
// ---------------------------------------------------------------------------

test("FullPlayer renders Skip back/forward 15 seconds buttons alongside unchanged Previous/Next", async () => {
    const { FullPlayer } = await import("../../components/player/FullPlayer");
    const mounted = await mount(React.createElement(FullPlayer));

    const skipBack = mounted.container.querySelector('[aria-label="Skip back 15 seconds"]');
    const skipForward = mounted.container.querySelector('[aria-label="Skip forward 15 seconds"]');
    const previous = mounted.container.querySelector('[aria-label="Previous track"]');
    const next = mounted.container.querySelector('[aria-label="Next track"]');

    assert.ok(skipBack, "expected a 'Skip back 15 seconds' button");
    assert.ok(skipForward, "expected a 'Skip forward 15 seconds' button");
    assert.ok(previous, "Previous track button must still be present");
    assert.ok(next, "Next track button must still be present");

    await unmount(mounted);
});

test("FullPlayer: clicking 'Skip back 15 seconds' calls skipBackward(15)", async () => {
    const { FullPlayer } = await import("../../components/player/FullPlayer");
    const mounted = await mount(React.createElement(FullPlayer));

    const button = mounted.container.querySelector(
        '[aria-label="Skip back 15 seconds"]',
    ) as HTMLButtonElement | null;
    assert.ok(button, "expected a 'Skip back 15 seconds' button");

    await React.act(async () => {
        button!.click();
    });

    assert.deepEqual(fullPlayerCalls.skipBackward, [15]);
    assert.deepEqual(fullPlayerCalls.skipForward, []);

    await unmount(mounted);
});

test("FullPlayer: clicking 'Skip forward 15 seconds' calls skipForward(15)", async () => {
    const { FullPlayer } = await import("../../components/player/FullPlayer");
    const mounted = await mount(React.createElement(FullPlayer));

    const button = mounted.container.querySelector(
        '[aria-label="Skip forward 15 seconds"]',
    ) as HTMLButtonElement | null;
    assert.ok(button, "expected a 'Skip forward 15 seconds' button");

    await React.act(async () => {
        button!.click();
    });

    assert.deepEqual(fullPlayerCalls.skipForward, [15]);
    assert.deepEqual(fullPlayerCalls.skipBackward, []);

    await unmount(mounted);
});

test("FullPlayer: Previous/Next buttons are unchanged (still call previous()/next())", async () => {
    const { FullPlayer } = await import("../../components/player/FullPlayer");
    const mounted = await mount(React.createElement(FullPlayer));

    const previous = mounted.container.querySelector(
        '[aria-label="Previous track"]',
    ) as HTMLButtonElement | null;
    const next = mounted.container.querySelector(
        '[aria-label="Next track"]',
    ) as HTMLButtonElement | null;
    assert.ok(previous);
    assert.ok(next);

    await React.act(async () => {
        previous!.click();
    });
    await React.act(async () => {
        next!.click();
    });

    assert.equal(fullPlayerCalls.previous, 1);
    assert.equal(fullPlayerCalls.next, 1);

    await unmount(mounted);
});

test("FullPlayer: skip buttons are disabled when no media is loaded", async () => {
    fullPlayerState.currentTrack = null as unknown as typeof fullPlayerState.currentTrack;
    fullPlayerState.playbackType = null;
    fullPlayerState.queue = [];

    const { FullPlayer } = await import("../../components/player/FullPlayer");
    const mounted = await mount(React.createElement(FullPlayer));

    const skipBack = mounted.container.querySelector(
        '[aria-label="Skip back 15 seconds"]',
    ) as HTMLButtonElement | null;
    const skipForward = mounted.container.querySelector(
        '[aria-label="Skip forward 15 seconds"]',
    ) as HTMLButtonElement | null;

    assert.ok(skipBack, "expected a 'Skip back 15 seconds' button even without media");
    assert.ok(skipForward, "expected a 'Skip forward 15 seconds' button even without media");
    assert.equal(skipBack!.disabled, true);
    assert.equal(skipForward!.disabled, true);

    await unmount(mounted);
});

test("FullPlayer: skip buttons are disabled and inert while canSeek is false; Previous/Next stay enabled", async () => {
    // The uncached-podcast window: media is loaded (hasMedia true) but the
    // playback provider has flipped canSeek false until caching completes.
    // The seek slider disables in this window — the skip buttons are seeks,
    // so they must too. Previous/Next are track switches, not seeks, and
    // must NOT be gated on canSeek.
    fullPlayerState.canSeek = false;

    const { FullPlayer } = await import("../../components/player/FullPlayer");
    const mounted = await mount(React.createElement(FullPlayer));

    const skipBack = mounted.container.querySelector(
        '[aria-label="Skip back 15 seconds"]',
    ) as HTMLButtonElement | null;
    const skipForward = mounted.container.querySelector(
        '[aria-label="Skip forward 15 seconds"]',
    ) as HTMLButtonElement | null;
    const previous = mounted.container.querySelector(
        '[aria-label="Previous track"]',
    ) as HTMLButtonElement | null;
    const next = mounted.container.querySelector(
        '[aria-label="Next track"]',
    ) as HTMLButtonElement | null;
    assert.ok(skipBack);
    assert.ok(skipForward);
    assert.equal(skipBack!.disabled, true, "skip-back must disable while !canSeek");
    assert.equal(skipForward!.disabled, true, "skip-forward must disable while !canSeek");
    assert.equal(previous!.disabled, false, "Previous is a track switch, not a seek — not gated on canSeek");
    assert.equal(next!.disabled, false, "Next is a track switch, not a seek — not gated on canSeek");

    await React.act(async () => {
        skipBack!.click();
    });
    await React.act(async () => {
        skipForward!.click();
    });

    assert.deepEqual(fullPlayerCalls.skipBackward, [], "clicking the disabled skip-back must fire nothing");
    assert.deepEqual(fullPlayerCalls.skipForward, [], "clicking the disabled skip-forward must fire nothing");

    await unmount(mounted);
});

// ---------------------------------------------------------------------------
// OverlayPlayer
// ---------------------------------------------------------------------------

test("OverlayPlayer renders Skip back/forward 15 seconds buttons for podcast playback", async () => {
    const { OverlayPlayer } = await import("../../components/player/OverlayPlayer");
    const mounted = await mount(withQueryClient(React.createElement(OverlayPlayer)));

    const skipBack = mounted.container.querySelector('[aria-label="Skip back 15 seconds"]');
    const skipForward = mounted.container.querySelector('[aria-label="Skip forward 15 seconds"]');

    assert.ok(skipBack, "expected a 'Skip back 15 seconds' button");
    assert.ok(skipForward, "expected a 'Skip forward 15 seconds' button");

    await unmount(mounted);
});

test("OverlayPlayer: clicking 'Skip back 15 seconds' calls skipBackward(15)", async () => {
    const { OverlayPlayer } = await import("../../components/player/OverlayPlayer");
    const mounted = await mount(withQueryClient(React.createElement(OverlayPlayer)));

    const button = mounted.container.querySelector(
        '[aria-label="Skip back 15 seconds"]',
    ) as HTMLButtonElement | null;
    assert.ok(button, "expected a 'Skip back 15 seconds' button");

    await React.act(async () => {
        button!.click();
    });

    assert.deepEqual(overlayCalls.skipBackward, [15]);
    assert.deepEqual(overlayCalls.skipForward, []);

    await unmount(mounted);
});

test("OverlayPlayer: clicking 'Skip forward 15 seconds' calls skipForward(15)", async () => {
    const { OverlayPlayer } = await import("../../components/player/OverlayPlayer");
    const mounted = await mount(withQueryClient(React.createElement(OverlayPlayer)));

    const button = mounted.container.querySelector(
        '[aria-label="Skip forward 15 seconds"]',
    ) as HTMLButtonElement | null;
    assert.ok(button, "expected a 'Skip forward 15 seconds' button");

    await React.act(async () => {
        button!.click();
    });

    assert.deepEqual(overlayCalls.skipForward, [15]);
    assert.deepEqual(overlayCalls.skipBackward, []);

    await unmount(mounted);
});

test("OverlayPlayer: Previous/Next buttons are unchanged (still call previous()/next())", async () => {
    const { OverlayPlayer } = await import("../../components/player/OverlayPlayer");
    const mounted = await mount(withQueryClient(React.createElement(OverlayPlayer)));

    const previous = mounted.container.querySelector(
        '[aria-label="Previous"]',
    ) as HTMLButtonElement | null;
    const next = mounted.container.querySelector(
        '[aria-label="Next"]',
    ) as HTMLButtonElement | null;
    assert.ok(previous);
    assert.ok(next);

    await React.act(async () => {
        previous!.click();
    });
    await React.act(async () => {
        next!.click();
    });

    assert.equal(overlayCalls.previous, 1);
    assert.equal(overlayCalls.next, 1);

    await unmount(mounted);
});

test("OverlayPlayer: skip buttons are disabled and inert while canSeek is false; Previous/Next stay enabled", async () => {
    // Same uncached-podcast window as the FullPlayer test: OverlayPlayer only
    // renders with media loaded, so the gate is canSeek alone.
    overlayState.canSeek = false;

    const { OverlayPlayer } = await import("../../components/player/OverlayPlayer");
    const mounted = await mount(withQueryClient(React.createElement(OverlayPlayer)));

    const skipBack = mounted.container.querySelector(
        '[aria-label="Skip back 15 seconds"]',
    ) as HTMLButtonElement | null;
    const skipForward = mounted.container.querySelector(
        '[aria-label="Skip forward 15 seconds"]',
    ) as HTMLButtonElement | null;
    const previous = mounted.container.querySelector(
        '[aria-label="Previous"]',
    ) as HTMLButtonElement | null;
    const next = mounted.container.querySelector(
        '[aria-label="Next"]',
    ) as HTMLButtonElement | null;
    assert.ok(skipBack);
    assert.ok(skipForward);
    assert.equal(skipBack!.disabled, true, "skip-back must disable while !canSeek");
    assert.equal(skipForward!.disabled, true, "skip-forward must disable while !canSeek");
    assert.equal(previous!.disabled, false, "Previous is a track switch, not a seek — not gated on canSeek");
    assert.equal(next!.disabled, false, "Next is a track switch, not a seek — not gated on canSeek");

    await React.act(async () => {
        skipBack!.click();
    });
    await React.act(async () => {
        skipForward!.click();
    });

    assert.deepEqual(overlayCalls.skipBackward, [], "clicking the disabled skip-back must fire nothing");
    assert.deepEqual(overlayCalls.skipForward, [], "clicking the disabled skip-forward must fire nothing");

    await unmount(mounted);
});
