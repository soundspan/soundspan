import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Static render tests for the F2 mode panels. renderToStaticMarkup can't drive
 * clicks, so we render each panel DIRECTLY with representative view props and
 * assert the always-rendered markup (results, loading, error, off-map tags,
 * disabled/thin mood chips, counts). Interaction + state-machine depth lives in
 * the travelCompass / journeyQueue unit tests.
 *
 * `@/lib/api` is mocked only to satisfy the module graph (AlchemyTray pulls
 * constants from useVibeMode, which imports `api` at module scope). No panel
 * calls the API.
 */

mock.module("@/lib/api", { namedExports: { api: {} } });

const noop = () => undefined;

async function panels() {
    const { TravelPanel } = await import("../../components/vibe/TravelPanel");
    const { JourneyPanel } = await import("../../components/vibe/JourneyPanel");
    const { AlchemyTray } = await import("../../components/vibe/AlchemyTray");
    return { TravelPanel, JourneyPanel, AlchemyTray };
}

function neighbor(
    id: string,
    name: string,
    similarity: number
): {
    id: string;
    title: string;
    album: { id: string; title: string; coverUrl: string | null };
    artist: { id: string; name: string };
    similarity: number;
    energy: number | null;
    valence: number | null;
    moods: Record<string, number> | null;
} {
    return {
        id,
        title: `${id} title`,
        album: { id: `al-${id}`, title: "", coverUrl: null },
        artist: { id: `ar-${id}`, name },
        similarity,
        energy: 0.5,
        valence: 0.5,
        moods: null,
    };
}

// --- Travel ---------------------------------------------------------------

test("TravelPanel renders compass, breadcrumb and on/off-map neighbours", async () => {
    const { TravelPanel } = await panels();
    const view = {
        currentId: "t1",
        currentTitle: "Origin Song",
        breadcrumbTitles: [
            { id: "t1", title: "Origin Song" },
            { id: "t2", title: "Second Song" },
        ],
        direction: "happier" as const,
        onMapNeighbors: [neighbor("n1", "Near Artist", 0.91)],
        offMapNeighbors: [neighbor("n2", "Far Artist", 0.4)],
        loading: false,
        error: null,
        setDirection: noop,
        navigate: noop,
        queue: noop,
        close: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(TravelPanel, { view })
    );
    assert.match(html, /Travel/);
    assert.match(html, /Origin Song/);
    assert.match(html, /Second Song/); // breadcrumb
    assert.match(html, /Near Artist/);
    assert.match(html, /Far Artist/);
    assert.match(html, /not on map/); // off-map tag on n2
    assert.match(html, /91%/); // similarity of n1
    // Compass options present, with the active one pressed.
    assert.match(html, /Happier/);
    assert.match(html, /Energetic/);
    assert.match(html, /aria-pressed="true"/);
});

test("TravelPanel shows the loading state", async () => {
    const { TravelPanel } = await panels();
    const view = {
        currentId: "t1",
        currentTitle: "Origin",
        breadcrumbTitles: [{ id: "t1", title: "Origin" }],
        direction: "any" as const,
        onMapNeighbors: [],
        offMapNeighbors: [],
        loading: true,
        error: null,
        setDirection: noop,
        navigate: noop,
        queue: noop,
        close: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(TravelPanel, { view })
    );
    assert.match(html, /Finding nearby vibes/);
});

test("TravelPanel surfaces an error", async () => {
    const { TravelPanel } = await panels();
    const view = {
        currentId: "t1",
        currentTitle: "Origin",
        breadcrumbTitles: [{ id: "t1", title: "Origin" }],
        direction: "any" as const,
        onMapNeighbors: [],
        offMapNeighbors: [],
        loading: false,
        error: "Couldn't load nearby vibes",
        setDirection: noop,
        navigate: noop,
        queue: noop,
        close: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(TravelPanel, { view })
    );
    // renderToStaticMarkup HTML-escapes the apostrophe in the copy.
    assert.match(html, /load nearby vibes/);
});

// --- Journey --------------------------------------------------------------

test("JourneyPanel disables thin mood chips and renders the numbered route", async () => {
    const { JourneyPanel } = await panels();
    const view = {
        fromId: "f1",
        fromLabel: "Now Playing Song",
        picking: false,
        destTrackId: null,
        destLabel: null,
        moodTarget: "chill",
        steps: 8,
        moods: [
            { mood: "chill", trackCount: 120 },
            { mood: "party", trackCount: 2 }, // thin -> disabled
        ],
        targetLabel: "Chill",
        waypoints: [
            {
                id: "w1",
                title: "Waypoint One",
                album: { id: "al-w1", title: "", coverUrl: null },
                artist: { id: "ar-w1", name: "WP One Artist" },
                similarity: 0.8,
                onMap: true,
                seq: 1,
            },
            {
                id: "w2",
                title: "Waypoint Two",
                album: { id: "al-w2", title: "", coverUrl: null },
                artist: { id: "ar-w2", name: "WP Two Artist" },
                similarity: 0.6,
                onMap: false,
                seq: 2,
            },
        ],
        loading: false,
        error: null,
        canSubmit: true,
        togglePick: noop,
        chooseMood: noop,
        setSteps: noop,
        submit: noop,
        drift: noop,
        play: noop,
        close: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(JourneyPanel, { view })
    );
    assert.match(html, /Journey/);
    assert.match(html, /Now Playing Song/);
    assert.match(html, /Route to Chill/);
    assert.match(html, /Waypoint One/);
    assert.match(html, /Waypoint Two/);
    assert.match(html, /not on map/); // w2 tagged
    assert.match(html, /Play journey/);
    // The thin "party" chip is disabled with the thin-mood tooltip.
    assert.match(html, /disabled=""/);
    assert.match(html, /Not enough analyzed tracks for this mood/);
    // Drift section only offers the non-thin mood.
    assert.match(html, /Drift toward/);
});

test("JourneyPanel shows the pick-on-map prompt and a backend 404 error", async () => {
    const { JourneyPanel } = await panels();
    const view = {
        fromId: "f1",
        fromLabel: "Origin",
        picking: true,
        destTrackId: null,
        destLabel: null,
        moodTarget: null,
        steps: 8,
        moods: [],
        targetLabel: null,
        waypoints: [],
        loading: false,
        error: "This track has no embedding yet",
        canSubmit: false,
        togglePick: noop,
        chooseMood: noop,
        setSteps: noop,
        submit: noop,
        drift: noop,
        play: noop,
        close: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(JourneyPanel, { view })
    );
    assert.match(html, /Click a dot to set destination/);
    assert.match(html, /This track has no embedding yet/);
});

// --- Alchemy --------------------------------------------------------------

test("AlchemyTray renders ingredients, weights, count and blend results", async () => {
    const { AlchemyTray } = await panels();
    const view = {
        ingredients: [
            {
                id: "i1",
                title: "Ingredient One",
                artist: "Ing One Artist",
                weight: 1,
                onMap: true,
            },
            {
                id: "i2",
                title: "Ingredient Two",
                artist: "Ing Two Artist",
                weight: 1.5,
                onMap: false,
            },
        ],
        results: [
            {
                id: "r1",
                title: "Blend Result",
                album: { id: "al-r1", title: "", coverUrl: null },
                artist: { id: "ar-r1", name: "Result Artist" },
                similarity: 0.77,
                onMap: true,
                seq: 1,
            },
        ],
        loading: false,
        error: null,
        canBlend: true,
        remove: noop,
        setWeight: noop,
        blend: noop,
        play: noop,
        clear: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(AlchemyTray, { view })
    );
    assert.match(html, /Alchemy/);
    assert.match(html, /2\/10/); // ingredient count
    assert.match(html, /Ingredient One/);
    assert.match(html, /Ingredient Two/);
    assert.match(html, /1\.5/); // i2 weight readout
    assert.match(html, /Blend Result/);
    assert.match(html, /77%/);
    assert.match(html, /Play blend/);
});

test("AlchemyTray disables Blend below two ingredients and shows an error", async () => {
    const { AlchemyTray } = await panels();
    const view = {
        ingredients: [
            {
                id: "i1",
                title: "Only One",
                artist: "Solo",
                weight: 1,
                onMap: true,
            },
        ],
        results: [],
        loading: false,
        error: "Couldn't blend those tracks",
        canBlend: false,
        remove: noop,
        setWeight: noop,
        blend: noop,
        play: noop,
        clear: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(AlchemyTray, { view })
    );
    assert.match(html, /1\/10/);
    assert.match(html, /disabled=""/); // Blend button disabled
    assert.match(html, /blend those tracks/); // apostrophe is HTML-escaped
});
