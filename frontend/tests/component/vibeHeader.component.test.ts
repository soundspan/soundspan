import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const baseProps = {
    currentTrack: null,
    sourceTrackId: null,
    isLoading: false,
    hasLibraryTracks: true,
    embeddedTrackCount: 1234,
    vibeTab: "explore" as const,
    onTabChange: () => undefined,
    onUseCurrentTrack: () => undefined,
    onRandomTrack: () => undefined,
    onRefresh: () => undefined,
};

test("renders the title, fingerprint count, and view toggle", async () => {
    const { VibeHeader } = await import("../../components/vibe/VibeHeader");
    const html = renderToStaticMarkup(
        React.createElement(VibeHeader, baseProps),
    );
    assert.match(html, />Vibe</);
    assert.match(html, /1,234 tracks with audio fingerprints/);
    assert.match(html, /aria-label="Vibe view"/);
    assert.match(html, /Explore/);
    assert.match(html, /Map/);
});

test("omits the subtitle when no fingerprint count is known", async () => {
    const { VibeHeader } = await import("../../components/vibe/VibeHeader");
    const html = renderToStaticMarkup(
        React.createElement(VibeHeader, {
            ...baseProps,
            embeddedTrackCount: null,
        }),
    );
    assert.doesNotMatch(html, /tracks with audio fingerprints/);
});

test("shows the Now Playing seed action only while a track plays", async () => {
    const { VibeHeader } = await import("../../components/vibe/VibeHeader");
    const idle = renderToStaticMarkup(
        React.createElement(VibeHeader, baseProps),
    );
    assert.doesNotMatch(idle, /Now Playing/);
    const playing = renderToStaticMarkup(
        React.createElement(VibeHeader, {
            ...baseProps,
            currentTrack: { id: "t1", title: "Song" },
            sourceTrackId: "t1",
        }),
    );
    assert.match(playing, /Now Playing/);
    assert.match(playing, /text-brand bg-brand\/10/);
});

test("disables the Random action when the library is empty", async () => {
    const { VibeHeader } = await import("../../components/vibe/VibeHeader");
    const enabled = renderToStaticMarkup(
        React.createElement(VibeHeader, baseProps),
    );
    assert.equal(enabled.match(/disabled=""/g), null);
    const emptyLibrary = renderToStaticMarkup(
        React.createElement(VibeHeader, {
            ...baseProps,
            hasLibraryTracks: false,
        }),
    );
    // Only the Random seed action disables; Refresh stays available.
    assert.equal(emptyLibrary.match(/disabled=""/g)?.length, 1);
});
