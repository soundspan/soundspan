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
 */

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

// --- leaf mocks (audio contexts stay REAL) ---------------------------------
// Any api method resolves to null so the mount-time playback-state restore is a
// no-op and nothing sets a track (which would re-render UniversalPlayer).
const apiStub = new Proxy(
    {},
    { get: () => async () => null },
) as Record<string, unknown>;
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
const childRenderCounts = { "full-player-stub": 0, "mini-player-stub": 0, "overlay-player-stub": 0 };
const childStub =
    (label: keyof typeof childRenderCounts) =>
    () => {
        childRenderCounts[label] += 1;
        return React.createElement("div", { "data-stub": label }, label);
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

test("UniversalPlayer commits <= 2 renders across 8 clock ticks (real provider stack)", async (t) => {
    const { createRoot } = await import("react-dom/client");
    const { AudioStateProvider } = await import("../../lib/audio-state-context");
    const { AudioPlaybackProvider, useAudioPlayback } = await import(
        "../../lib/audio-playback-context"
    );
    const { UniversalPlayer } = await import(
        "../../components/player/UniversalPlayer"
    );

    let commitCount = 0;
    let playbackRenders = 0;
    let capturedEngineTick: EngineTickFn | null = null;

    // A real playback subscriber. It re-renders whenever the ticking clock is
    // published to state — the A/B control that proves the ticks actually drive
    // state changes (otherwise a "0 UniversalPlayer renders" result would be
    // vacuous). UniversalPlayer must NOT track this counter.
    const Probe = () => {
        const playback = useAudioPlayback();
        capturedEngineTick = playback.setCurrentTimeFromEngine;
        playbackRenders += 1;
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
    const mountPlaybackRenders = playbackRenders;
    const mountChildRenders = childRenderCounts["full-player-stub"];
    assert.ok(
        capturedEngineTick,
        "expected the playback provider's engine-tick setter to be captured",
    );

    // 8 ticks = 2 simulated seconds at 4Hz. With no active track the guard accepts
    // every tick; post-fix these publish only at the 1.0s and 2.0s boundaries and,
    // crucially, UniversalPlayer subscribes to STATE (not the clock) so it should
    // not re-render at all.
    const ticks = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
    for (const time of ticks) {
        await React.act(async () => {
            capturedEngineTick!(time, null);
        });
    }

    const tickCommits = commitCount - mountCommits;
    const tickPlaybackRenders = playbackRenders - mountPlaybackRenders;
    const tickChildRenders =
        childRenderCounts["full-player-stub"] - mountChildRenders;
    t.diagnostic(
        `UniversalPlayer commits — mount:${mountCommits} tick-phase(Profiler):${tickCommits} ` +
            `tick-phase(child-render):${tickChildRenders} total:${commitCount}; ` +
            `playback-subscriber tick-phase renders:${tickPlaybackRenders}`,
    );

    // Non-vacuity control: the same 8 ticks DID re-render a real playback
    // subscriber, so a 0 for UniversalPlayer is a genuine isolation result.
    assert.ok(
        tickPlaybackRenders >= 1,
        `sanity: clock ticks must re-render a playback subscriber (got ${tickPlaybackRenders})`,
    );

    // Weak secondary signal (see the header note — the Profiler under-reports
    // context-only re-renders here, so this passes trivially on both trees).
    assert.ok(
        tickCommits <= 2,
        `UniversalPlayer Profiler commits must be <= 2 across 8 clock ticks (got ${tickCommits})`,
    );
    // AUTHORITATIVE guard: the child stub re-renders exactly when UniversalPlayer
    // does. Pre-fix this is 8 (re-render every tick) and fails; post-fix it is 0.
    assert.ok(
        tickChildRenders <= 2,
        `UniversalPlayer subtree must render <= 2 times across 8 clock ticks (child-render count ${tickChildRenders})`,
    );

    await React.act(async () => {
        root.unmount();
    });
});
