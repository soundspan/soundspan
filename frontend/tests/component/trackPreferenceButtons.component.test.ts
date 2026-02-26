import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    signal: "clear" as "thumbs_up" | "thumbs_down" | "clear",
    isSaving: false,
    toggleLikeCalls: 0,
};

mock.module("lucide-react", {
    namedExports: {
        Heart: (props: Record<string, unknown>) =>
            React.createElement("svg", {
                ...props,
                "data-icon": "heart-outline",
            }),
    },
});

mock.module("@/hooks/useTrackPreference", {
    namedExports: {
        useTrackPreference: () => ({
            signal: state.signal,
            isSaving: state.isSaving,
            toggleLike: async () => {
                state.toggleLikeCalls += 1;
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
    state.toggleLikeCalls = 0;
});

test("renders like control without circular chrome", async () => {
    const { TrackPreferenceButtons } = await import(
        "../../components/player/TrackPreferenceButtons.tsx"
    );
    const html = renderToStaticMarkup(
        React.createElement(TrackPreferenceButtons, { trackId: "track-1" })
    );

    assert.match(html, /data-icon="heart-outline"/);
    assert.doesNotMatch(html, /data-icon="thumbs-down-outline"/);
    assert.match(html, /h-11 w-11/);
    assert.match(html, /h-6 w-6/);
    assert.doesNotMatch(html, /rounded-full/);
    assert.doesNotMatch(html, /\bborder\b/);
});

test("active signal renders a filled heart icon", async () => {
    state.signal = "thumbs_up";

    const { TrackPreferenceButtons } = await import(
        "../../components/player/TrackPreferenceButtons.tsx"
    );
    const html = renderToStaticMarkup(
        React.createElement(TrackPreferenceButtons, { trackId: "track-2" })
    );

    assert.match(html, /data-icon="heart-filled"/);
    assert.doesNotMatch(html, /data-icon="heart-outline"/);
});
