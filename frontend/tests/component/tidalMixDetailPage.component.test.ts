import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    routeId: "mix-123",
    paramsCalls: 0,
    getMixCalls: 0,
    trackListRendered: false,
};

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        ArrowLeft: Icon,
        Play: Icon,
        Pause: Icon,
        Music2: Icon,
        ListMusic: Icon,
        Shuffle: Icon,
        Plus: Icon,
        Heart: Icon,
        Loader2: Icon,
    },
});

mock.module("next/navigation", {
    namedExports: {
        useParams: () => {
            state.paramsCalls += 1;
            return { id: state.routeId };
        },
        useRouter: () => ({
            push: () => undefined,
            back: () => undefined,
        }),
    },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", { src: props.src as string, alt: props.alt as string }),
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getTidalBrowseMix: async () => {
                state.getMixCalls += 1;
                return {
                    id: "mix-1",
                    title: "Mix",
                    trackCount: 0,
                    thumbnailUrl: null,
                    tracks: [],
                };
            },
            getTidalBrowseImageUrl: (url: string) => url,
            addTrackToPlaylist: async () => undefined,
        },
    },
});

mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                success: () => undefined,
                error: () => undefined,
            },
        }),
    },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: {
        GradientSpinner: () => React.createElement("span", null, "gradient-spinner"),
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: null,
        }),
    },
});

mock.module("@/lib/audio-playback-context", {
    namedExports: {
        useAudioPlayback: () => ({
            isPlaying: false,
        }),
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: () => undefined,
            playNow: () => undefined,
            addTracksToQueue: () => undefined,
            pause: () => undefined,
            resume: () => undefined,
        }),
    },
});

mock.module("@/hooks/usePlayButtonFeedback", {
    namedExports: {
        usePlayButtonFeedback: () => ({
            showSpinner: false,
            trigger: () => undefined,
        }),
    },
});

mock.module("@/hooks/useCollectionLikeAll", {
    namedExports: {
        useCollectionLikeAll: () => ({
            isAllLiked: false,
            isApplying: false,
            toggleLikeAll: () => undefined,
        }),
    },
});

mock.module("@/components/ui/PlaylistSelector", {
    namedExports: {
        PlaylistSelector: () => React.createElement("div", null, "playlist-selector"),
    },
});

mock.module("@/lib/trackRef", {
    namedExports: {
        toAddToPlaylistRef: (value: Record<string, unknown>) => value,
    },
});

mock.module("@/utils/shuffle", {
    namedExports: {
        shuffleArray: <T,>(value: T[]) => value,
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
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

mock.module("@/components/ui/TidalBadge", {
    namedExports: {
        TidalBadge: () => React.createElement("span", null, "tidal-badge"),
    },
});

mock.module("@/components/track", {
    namedExports: {
        TrackList: () => {
            state.trackListRendered = true;
            return React.createElement("div", null, "track-list");
        },
        TrackListHeader: () => React.createElement("div", null, "track-list-header"),
    },
});

beforeEach(() => {
    state.routeId = "mix-123";
    state.paramsCalls = 0;
    state.getMixCalls = 0;
    state.trackListRendered = false;
});

async function loadPage() {
    const mod = await import("../../app/explore/tidal-mix/[id]/page");
    const directDefault = (mod as { default?: unknown }).default;
    const Page = typeof directDefault === "function"
        ? (directDefault as React.FC)
        : (directDefault as { default?: React.FC } | undefined)?.default;
    assert.ok(Page, "tidal mix page default export is available");
    return Page;
}

test("tidal mix page renders deterministic loading state on server render", async () => {
    const Page = await loadPage();
    const html = renderToStaticMarkup(React.createElement(Page));

    assert.match(html, /gradient-spinner/);
    assert.ok(state.paramsCalls >= 1);
    assert.equal(state.trackListRendered, false);
    assert.equal(
        state.getMixCalls,
        0,
        "useEffect fetch does not run during static server render"
    );
});

test("tidal mix page tolerates malformed encoded route id via decode fallback", async () => {
    state.routeId = "%E0%A4%A";
    const Page = await loadPage();

    assert.doesNotThrow(() => {
        renderToStaticMarkup(React.createElement(Page));
    });
    assert.ok(state.paramsCalls >= 1);
});
