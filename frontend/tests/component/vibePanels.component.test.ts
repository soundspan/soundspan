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

// --- NowPlayingCard -------------------------------------------------------

async function nowPlayingCard() {
    const { NowPlayingCard } = await import(
        "../../components/vibe/NowPlayingCard"
    );
    return NowPlayingCard;
}

test("NowPlayingCard shows the playing track's title, artist and pause control", async () => {
    const NowPlayingCard = await nowPlayingCard();
    const html = renderToStaticMarkup(
        React.createElement(NowPlayingCard, {
            track: {
                id: "t1",
                title: "Playing Title",
                artist: { name: "Playing Artist" },
                album: { coverArt: null },
            },
            isPlaying: true,
            onMapPresent: true,
            moodColor: "#facc15",
            onFlyTo: noop,
            onTogglePlay: noop,
        })
    );
    assert.match(html, /Playing Title/);
    assert.match(html, /Playing Artist/);
    // Playing -> the pause affordance is shown, and the card offers fly-to.
    assert.match(html, /aria-label="Pause"/);
    assert.match(html, /Fly to Playing Title on the map/);
});

test("NowPlayingCard disables fly-to when the track isn't on the map", async () => {
    const NowPlayingCard = await nowPlayingCard();
    const html = renderToStaticMarkup(
        React.createElement(NowPlayingCard, {
            track: {
                id: "t9",
                title: "Off Map Song",
                artist: { name: "Ghost" },
                album: { coverArt: null },
            },
            isPlaying: false,
            onMapPresent: false,
            moodColor: null,
            onFlyTo: noop,
            onTogglePlay: noop,
        })
    );
    assert.match(html, /Off Map Song/);
    assert.match(html, /not on the map/i);
    assert.match(html, /disabled=""/); // fly-to disabled off-map
    assert.match(html, /aria-label="Play"/); // paused -> play affordance
});

test("NowPlayingCard renders nothing when there is no track", async () => {
    const NowPlayingCard = await nowPlayingCard();
    const html = renderToStaticMarkup(
        React.createElement(NowPlayingCard, {
            track: null,
            isPlaying: false,
            onMapPresent: false,
            onFlyTo: noop,
            onTogglePlay: noop,
        })
    );
    assert.equal(html, "");
});

// --- ViewControls ---------------------------------------------------------

test("ViewControls exposes labelled zoom/reset/layout/locate/journey/fullscreen buttons", async () => {
    const { ViewControls } = await import(
        "../../components/vibe/ViewControls"
    );
    const html = renderToStaticMarkup(
        React.createElement(ViewControls, {
            onZoomIn: noop,
            onZoomOut: noop,
            onReset: noop,
            layoutMode: "natural",
            layoutDisabled: false,
            onToggleLayout: noop,
            canLocate: true,
            locateHint: "Fly to now playing",
            onLocate: noop,
            canStartJourney: true,
            journeyHint: "Plan a journey from the current track",
            onStartJourney: noop,
            isFullscreen: false,
            onToggleFullscreen: noop,
        })
    );
    assert.match(html, /aria-label="Zoom in"/);
    assert.match(html, /aria-label="Zoom out"/);
    assert.match(html, /aria-label="Reset view"/);
    assert.match(html, /aria-label="Spread layout"/); // natural -> offers spread
    assert.match(html, /aria-label="Locate now playing"/);
    assert.match(html, /aria-label="Start a journey"/);
    assert.match(html, /aria-label="Enter fullscreen"/);
    // Toggle-like controls carry aria-pressed.
    assert.match(html, /aria-pressed="false"/);
});

// --- FiltersPanel ---------------------------------------------------------

async function filtersPanel() {
    const { FiltersPanel } = await import(
        "../../components/vibe/FiltersPanel"
    );
    return FiltersPanel;
}

function filtersStub(visibleCount: number) {
    return {
        activeMoods: new Set([
            "moodHappy",
            "moodSad",
            "moodRelaxed",
            "moodAggressive",
            "moodParty",
            "moodAcoustic",
            "moodElectronic",
        ]) as ReadonlySet<string>,
        energyRange: [0.2, 0.8] as [number, number],
        valenceRange: [0, 1] as [number, number],
        visibleCount,
        toggleMood: noop,
        soloMood: noop,
        selectAllMoods: noop,
        setEnergyRange: noop,
        setValenceRange: noop,
    };
}

test("FiltersPanel collapsed renders a Filters count pill", async () => {
    const FiltersPanel = await filtersPanel();
    const html = renderToStaticMarkup(
        React.createElement(FiltersPanel, {
            filters: filtersStub(4),
            total: 10,
            expanded: false,
            onExpandedChange: noop,
        })
    );
    assert.match(html, /Filters/);
    assert.match(html, /4\/10/); // {visible}/{total}
    assert.match(html, /aria-expanded="false"/);
});

test("FiltersPanel expanded renders mood chips, the solo hint and both sliders", async () => {
    const FiltersPanel = await filtersPanel();
    const html = renderToStaticMarkup(
        React.createElement(FiltersPanel, {
            filters: filtersStub(4),
            total: 10,
            expanded: true,
            onExpandedChange: noop,
            reducedMotion: true,
        })
    );
    // Mood chips as real toggle buttons (all active in the stub).
    assert.match(html, />Happy</);
    assert.match(html, />Sad</);
    assert.match(html, />Relaxed</);
    assert.match(html, />Party</);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, />All</);
    assert.match(html, /shift-click to solo/);
    // Both range sliders with end labels + accessible min/max inputs.
    assert.match(html, /Energy/);
    assert.match(html, /Mood/);
    assert.match(html, /calm/);
    assert.match(html, /intense/);
    assert.match(html, /aria-label="Energy minimum"/);
    assert.match(html, /aria-label="Mood maximum"/);
    assert.match(html, /aria-expanded="true"/); // collapse button
});
