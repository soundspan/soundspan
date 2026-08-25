import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * TRUE render-count regression for roadmap F12 item (A)+(B).
 *
 * Mounts the REAL AudioStateProvider + AudioPlaybackProvider and the REAL
 * UniversalPlayer under happy-dom with react-dom/client, then drives 8 engine
 * timeupdate ticks (2 simulated seconds at 4Hz) through the playback provider and
 * counts how many times the UniversalPlayer subtree renders.
 *
 * Only leaves are mocked (network api, the three heavy child players,
 * framer-motion, the media-query hooks, the controls context); the STATE and
 * PLAYBACK contexts are the real ones, so this measures the actual subscription
 * behaviour. Post-fix UniversalPlayer reads only the granular state context, so
 * clock ticks must not re-render it; the pre-fix tree (useAudio) re-rendered it
 * on every tick.
 *
 * Measurement note: React.Profiler is wired for the subtree, but in this
 * react-dom + happy-dom combination its onRender does NOT fire for context-only
 * re-renders that mutate no host DOM (verified: on the pre-fix tree the Profiler
 * reported 0 while UniversalPlayer actually re-rendered 8x). So the AUTHORITATIVE
 * count is a child-stub render counter (a mocked child re-renders exactly when
 * UniversalPlayer does): pre-fix child-render tick-phase = 8, post-fix = 0.
 *
 * The assertions are EXACT (=== 0 subtree renders, === 2 clock publishes), not
 * bounds: a loose >=1/<=2 band would keep passing if quantization silently
 * regressed to publishing every tick (8 publishes) while the subscription fix
 * held. Exactness is deterministic here because the baseline is fully
 * controlled: localStorage is cleared before mount (initial published clock 0),
 * the tick sequence 0.25..2.0 crosses exactly two display-second boundaries
 * (1.0 and 2.0), each tick runs in its own act() flush, and no timers or
 * real audio are involved.
 */

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// --- leaf mocks (audio contexts stay REAL) ---------------------------------
// Any api method resolves to null so the mount-time playback-state restore is a
// no-op and nothing sets a track (which would re-render UniversalPlayer).
const apiStub = new Proxy({}, { get: () => async () => null }) as Record<
    string,
    unknown
>;
mock.module("@/lib/api", { namedExports: { api: apiStub } });

mock.module("@/hooks/useMediaQuery", {
    namedExports: {
        useIsMobile: () => false,
        useIsTablet: () => false,
    },
});

// Stub the CONTROLS context so we can mount only the State + Playback providers
// (the real controls provider drags in listen-together sockets). This is what
// lets the SAME test render on the pre-fix tree too: there UniversalPlayer calls
// useAudio(), which internally calls useAudioControls(). Controls are stable
// actions that never change on a clock tick, so stubbing them cannot affect the
// re-render count on either tree; post-fix UniversalPlayer never calls it at all.
mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({}),
    },
});

// A child stub re-renders exactly when UniversalPlayer re-renders (no memo
// boundary between them), giving a Profiler-independent count of UniversalPlayer
// renders as a cross-check.
const childRenderCounts = {
    "full-player-stub": 0,
    "mini-player-stub": 0,
    "overlay-player-stub": 0,
};
const childStub = (label: keyof typeof childRenderCounts) => {
    const ChildStub = () => {
        childRenderCounts[label] += 1;
        return React.createElement("div", { "data-stub": label }, label);
    };
    ChildStub.displayName = `ChildStub(${label})`;
    return ChildStub;
};
mock.module("../../components/player/MiniPlayer.tsx", {
    namedExports: { MiniPlayer: childStub("mini-player-stub") },
});
mock.module("../../components/player/FullPlayer.tsx", {
    namedExports: { FullPlayer: childStub("full-player-stub") },
});
mock.module("../../components/player/OverlayPlayer.tsx", {
    namedExports: { OverlayPlayer: childStub("overlay-player-stub") },
});

mock.module("framer-motion", {
    namedExports: {
        AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
            React.createElement(React.Fragment, null, children),
        LayoutGroup: ({ children }: { children?: React.ReactNode }) =>
            React.createElement(React.Fragment, null, children),
        motion: {
            div: ({ children }: { children?: React.ReactNode }) =>
                React.createElement("div", null, children),
        },
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // best-effort teardown
    }
});

type EngineTickFn = (time: number, invocationTrackId?: string | null) => void;

test("UniversalPlayer renders exactly 0 times across 8 clock ticks; clock publishes exactly 2 (real provider stack)", async (t) => {
    // Deterministic baseline: the playback provider lazily restores currentTime
    // from localStorage, so start from a clean slate (initial published clock 0).
    localStorage.clear();
    const { createRoot } = await import("react-dom/client");
    const { AudioStateProvider } =
        await import("../../lib/audio-state-context");
    const { AudioPlaybackProvider, usePlaybackStatus, usePlaybackProgress } =
        await import("../../lib/audio-playback-context");
    const { UniversalPlayer } =
        await import("../../components/player/UniversalPlayer");

    let commitCount = 0;
    // Ref-shaped mutation containers: the react-hooks lint rule forbids
    // reassigning outer variables inside a component, but allows writes to the
    // `.current` field of *Ref-named values (house pattern, see
    // audioContextHookGuards.component.test.ts).
    const playbackRendersRef = { current: 0 };
    const capturedEngineTickRef = { current: null as EngineTickFn | null };

    // A real playback subscriber. It re-renders whenever the ticking clock is
    // published to state — the A/B control that proves the ticks actually drive
    // state changes (otherwise a "0 UniversalPlayer renders" result would be
    // vacuous). UniversalPlayer must NOT track this counter.
    const Probe = () => {
        const playback = usePlaybackStatus();
        const progress = usePlaybackProgress();
        void progress.currentTime;
        capturedEngineTickRef.current = playback.setCurrentTimeFromEngine;
        playbackRendersRef.current += 1;
        return null;
    };

    const tree = React.createElement(
        AudioStateProvider,
        null,
        React.createElement(
            AudioPlaybackProvider,
            null,
            React.createElement(Probe),
            React.createElement(
                React.Profiler,
                {
                    id: "universal-player",
                    onRender: () => {
                        commitCount += 1;
                    },
                },
                React.createElement(UniversalPlayer),
            ),
        ),
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(tree);
    });
    // Flush mount effects + the mocked (immediately-resolving) api calls so any
    // post-mount state settles BEFORE we start counting clock-tick commits.
    await React.act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });

    const mountCommits = commitCount;
    const mountPlaybackRenders = playbackRendersRef.current;
    const mountChildRenders = childRenderCounts["full-player-stub"];
    assert.ok(
        capturedEngineTickRef.current,
        "expected the playback provider's engine-tick setter to be captured",
    );

    // 8 ticks = 2 simulated seconds at 4Hz. With no active track the guard accepts
    // every tick; post-fix these publish only at the 1.0s and 2.0s boundaries and,
    // crucially, UniversalPlayer subscribes to STATE (not the clock) so it should
    // not re-render at all.
    const ticks = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
    for (const time of ticks) {
        await React.act(async () => {
            capturedEngineTickRef.current!(time, null);
        });
    }

    const tickCommits = commitCount - mountCommits;
    const tickPlaybackRenders =
        playbackRendersRef.current - mountPlaybackRenders;
    const tickChildRenders =
        childRenderCounts["full-player-stub"] - mountChildRenders;
    t.diagnostic(
        `UniversalPlayer commits — mount:${mountCommits} tick-phase(Profiler):${tickCommits} ` +
            `tick-phase(child-render):${tickChildRenders} total:${commitCount}; ` +
            `playback-subscriber tick-phase renders:${tickPlaybackRenders}`,
    );

    // Non-vacuity control AND quantization guard (item B): the 8 ticks must
    // publish to state EXACTLY at the two display-second crossings (1.0, 2.0).
    // More than 2 means quantization silently regressed toward per-tick
    // publishing (pre-fix: 8); fewer means ticks stopped reaching state at all.
    assert.equal(
        tickPlaybackRenders,
        2,
        `clock ticks must publish exactly at the 2 display-second boundaries (got ${tickPlaybackRenders} playback-subscriber renders)`,
    );

    // Weak secondary signal (see the header note — the Profiler under-reports
    // context-only re-renders here; kept as a tripwire for renderer changes).
    assert.equal(
        tickCommits,
        0,
        `UniversalPlayer Profiler commits must be 0 across 8 clock ticks (got ${tickCommits})`,
    );
    // AUTHORITATIVE guard (item A): the child stub re-renders exactly when
    // UniversalPlayer does. Pre-fix this is 8 (re-render every tick); post-fix
    // the subtree must not render at all during the tick phase.
    assert.equal(
        tickChildRenders,
        0,
        `UniversalPlayer subtree must render 0 times across 8 clock ticks (child-render count ${tickChildRenders})`,
    );

    await React.act(async () => {
        root.unmount();
    });
});
