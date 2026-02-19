import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    signal: "clear" as "thumbs_up" | "thumbs_down" | "clear",
    isSaving: false,
    toggleUpCalls: 0,
    toggleDownCalls: 0,
};

mock.module("lucide-react", {
    namedExports: {
        ThumbsUp: (props: Record<string, unknown>) =>
            React.createElement("svg", {
                ...props,
                "data-icon": "thumbs-up-outline",
            }),
        ThumbsDown: (props: Record<string, unknown>) =>
            React.createElement("svg", {
                ...props,
                "data-icon": "thumbs-down-outline",
            }),
    },
});

mock.module("@/hooks/useTrackPreference", {
    namedExports: {
        useTrackPreference: () => ({
            signal: state.signal,
            isSaving: state.isSaving,
            toggleThumbsUp: async () => {
                state.toggleUpCalls += 1;
            },
            toggleThumbsDown: async () => {
                state.toggleDownCalls += 1;
            },
        }),
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

beforeEach(() => {
    state.signal = "clear";
    state.isSaving = false;
    state.toggleUpCalls = 0;
    state.toggleDownCalls = 0;
});

test("renders thumbs-only controls without circular chrome", async () => {
    const { TrackPreferenceButtons } = await import(
        "../../components/player/TrackPreferenceButtons.tsx"
    );
    const html = renderToStaticMarkup(
        React.createElement(TrackPreferenceButtons, { trackId: "track-1" })
    );

    assert.match(html, /data-icon="thumbs-up-outline"/);
    assert.match(html, /data-icon="thumbs-down-outline"/);
    assert.match(html, /class="h-11 w-11/);
    assert.match(html, /class="h-6 w-6/);
    assert.doesNotMatch(html, /rounded-full/);
    assert.doesNotMatch(html, /\bborder\b/);
});

test("active signal renders a filled thumb icon and suppresses opposite fill", async () => {
    state.signal = "thumbs_up";

    const { TrackPreferenceButtons } = await import(
        "../../components/player/TrackPreferenceButtons.tsx"
    );
    const html = renderToStaticMarkup(
        React.createElement(TrackPreferenceButtons, { trackId: "track-2" })
    );

    assert.match(html, /data-icon="thumbs-up-filled"/);
    assert.doesNotMatch(html, /data-icon="thumbs-down-filled"/);
});
