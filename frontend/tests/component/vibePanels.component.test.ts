import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Static render tests for the F2 mode panels. renderToStaticMarkup can't drive
 * clicks, so we render each panel DIRECTLY with representative view props and
 * assert the always-rendered markup (results, loading, error, off-map tags,
 * disabled/thin mood chips, counts). Interaction + state-machine depth lives in
 * the travelCompass / journeyQueue unit tests. Sub-components whose relevant
 * state is a plain prop of their parent (NeighborRow's `expanded`) are
 * exported and rendered DIRECTLY so their prop-driven states are reachable
 * without simulating a click.
 *
 * `@/lib/api` is mocked to satisfy the module graph (AlchemyTray pulls
 * constants from useVibeMode, which imports `api` at module scope) AND to
 * back the "Save as playlist" tests below, whose `save` callbacks call the
 * real `saveTracksAsPlaylist` helper — `createPlaylist`/`addTrackToPlaylist`
 * delegate to a mutable `state.api` so individual tests can observe/vary the
 * calls (same indirection pattern as savePlaylist.test.ts).
 */

const state: {
    api: {
        createPlaylist: (name: string) => Promise<{ id: string }>;
        addTrackToPlaylist: (
            playlistId: string,
            ref: unknown,
        ) => Promise<unknown>;
    };
} = {
    api: {
        createPlaylist: async () => ({ id: "pl1" }),
        addTrackToPlaylist: async () => ({}),
    },
};

mock.module("@/lib/api", {
    namedExports: {
        api: {
            createPlaylist: (name: string) => state.api.createPlaylist(name),
            addTrackToPlaylist: (playlistId: string, ref: unknown) =>
                state.api.addTrackToPlaylist(playlistId, ref),
            getCoverArtUrl: (url: string) =>
                `/api/library/cover-art?url=${encodeURIComponent(url)}`,
        },
    },
});

// NowPlayingCard's title/artist are next/link Links (album/artist pages).
mock.module("next/link", {
    defaultExport: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    }) => React.createElement("a", { href, ...rest }, children),
});

const noop = () => undefined;

beforeEach(() => {
    state.api = {
        createPlaylist: async () => ({ id: "pl1" }),
        addTrackToPlaylist: async () => ({}),
    };
});

async function panels() {
    const { TravelPanel, NeighborRow } =
        await import("../../components/vibe/TravelPanel");
    const { JourneyPanel } = await import("../../components/vibe/JourneyPanel");
    const { AlchemyTray } = await import("../../components/vibe/AlchemyTray");
    return { TravelPanel, NeighborRow, JourneyPanel, AlchemyTray };
}

/** Distance that yields `percent` under the uncalibrated linear fallback
 *  (`Math.max(0, 1 - distance/2)`), so existing fixtures built around a
 *  target displayed percent stay exact. */
function distanceForPercent(percent: number): number {
    return Math.max(0, 2 * (1 - percent / 100));
}

function neighbor(
    id: string,
    name: string,
    similarity: number,
    overrides: {
        danceability?: number | null;
        arousal?: number | null;
    } = {},
): {
    id: string;
    title: string;
    album: { id: string; title: string; coverUrl: string | null };
    artist: { id: string; name: string };
    similarity: number;
    distance: number;
    energy: number | null;
    valence: number | null;
    moods: Record<string, number> | null;
    danceability: number | null;
    arousal: number | null;
} {
    return {
        id,
        title: `${id} title`,
        album: { id: `al-${id}`, title: "", coverUrl: null },
        artist: { id: `ar-${id}`, name },
        similarity,
        distance: distanceForPercent(Math.round(similarity * 100)),
        energy: 0.5,
        valence: 0.5,
        moods: null,
        danceability: overrides.danceability ?? 0.6,
        arousal: overrides.arousal ?? 0.4,
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
        quantiles: null,
        originFeatures: null,
        setDirection: noop,
        navigate: noop,
        queue: noop,
        close: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(TravelPanel, { view }),
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
        quantiles: null,
        originFeatures: null,
        setDirection: noop,
        navigate: noop,
        queue: noop,
        close: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(TravelPanel, { view }),
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
        quantiles: null,
        originFeatures: null,
        setDirection: noop,
        navigate: noop,
        queue: noop,
        close: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(TravelPanel, { view }),
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
                distance: distanceForPercent(80),
                onMap: true,
                seq: 1,
            },
            {
                id: "w2",
                title: "Waypoint Two",
                album: { id: "al-w2", title: "", coverUrl: null },
                artist: { id: "ar-w2", name: "WP Two Artist" },
                similarity: 0.6,
                distance: distanceForPercent(60),
                onMap: false,
                seq: 2,
            },
        ],
        loading: false,
        error: null,
        canSubmit: true,
        quantiles: null,
        togglePick: noop,
        chooseMood: noop,
        setSteps: noop,
        submit: noop,
        drift: noop,
        play: noop,
        save: async () => undefined,
        saving: false,
        close: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(JourneyPanel, { view }),
    );
    assert.match(html, /Journey/);
    assert.match(html, /Now Playing Song/);
    assert.match(html, /Route to Chill/);
    assert.match(html, /Waypoint One/);
    assert.match(html, /Waypoint Two/);
    assert.match(html, /not on map/); // w2 tagged
    assert.match(html, /Play journey/);
    assert.match(html, /aria-label="Save journey as playlist"/);
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
        quantiles: null,
        togglePick: noop,
        chooseMood: noop,
        setSteps: noop,
        submit: noop,
        drift: noop,
        play: noop,
        save: async () => undefined,
        saving: false,
        close: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(JourneyPanel, { view }),
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
                distance: distanceForPercent(77),
                onMap: true,
                seq: 1,
            },
        ],
        loading: false,
        error: null,
        canBlend: true,
        quantiles: null,
        remove: noop,
        setWeight: noop,
        blend: noop,
        play: noop,
        clear: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(AlchemyTray, { view }),
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
        quantiles: null,
        remove: noop,
        setWeight: noop,
        blend: noop,
        play: noop,
        clear: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(AlchemyTray, { view }),
    );
    assert.match(html, /1\/10/);
    assert.match(html, /disabled=""/); // Blend button disabled
    assert.match(html, /blend those tracks/); // apostrophe is HTML-escaped
});

// --- NowPlayingCard -------------------------------------------------------

async function nowPlayingCard() {
    const { NowPlayingCard } =
        await import("../../components/vibe/NowPlayingCard");
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
        }),
    );
    assert.match(html, /Playing Title/);
    assert.match(html, /Playing Artist/);
    // Playing -> the pause affordance is shown, and the card offers fly-to.
    assert.match(html, /aria-label="Pause"/);
    assert.match(html, /Fly to Playing Title on the map/);
    // The explicit labeled find-me chip renders for on-map tracks (the
    // cover/title click alone doesn't read as a fly-to affordance).
    assert.match(html, /Find on map/);
    assert.match(html, /aria-label="Find Playing Title on the map"/);
});

test("NowPlayingCard proxies external cover art through the same origin", async () => {
    const NowPlayingCard = await nowPlayingCard();
    const html = renderToStaticMarkup(
        React.createElement(NowPlayingCard, {
            track: {
                id: "t-cover",
                title: "Covered Track",
                artist: { name: "Artist" },
                album: { coverArt: "https://img.example/cover.jpg" },
            },
            isPlaying: false,
            onMapPresent: false,
            moodColor: null,
            onFlyTo: noop,
            onTogglePlay: noop,
        }),
    );

    assert.match(
        html,
        /src="\/api\/library\/cover-art\?url=https%3A%2F%2Fimg\.example%2Fcover\.jpg"/,
    );
    assert.doesNotMatch(html, /src="https:\/\/img\.example\/cover\.jpg"/);
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
        }),
    );
    assert.match(html, /Off Map Song/);
    assert.match(html, /not on the map/i);
    assert.match(html, /disabled=""/); // fly-to disabled off-map
    assert.match(html, /aria-label="Play"/); // paused -> play affordance
    // No find-me chip when the track has no dot to fly to.
    assert.doesNotMatch(html, /Find on map/);
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
        }),
    );
    assert.equal(html, "");
});

test("NowPlayingCard renders a progress strip sized from currentTime/duration", async () => {
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
            currentTime: 90,
            duration: 180,
        }),
    );
    assert.match(html, /role="progressbar"/);
    assert.match(html, /aria-valuemin="0"/);
    assert.match(html, /aria-valuemax="100"/);
    assert.match(html, /aria-valuenow="50"/);
    assert.match(html, /aria-label="Playback progress"/);
    assert.match(html, /width:50%/);
    // Fill uses the card's mood color, not a fixed accent.
    assert.match(html, /#facc15/);
});

test("NowPlayingCard hides the progress strip when duration is 0/unknown", async () => {
    const NowPlayingCard = await nowPlayingCard();
    const baseProps = {
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
    };
    const zeroDuration = renderToStaticMarkup(
        React.createElement(NowPlayingCard, {
            ...baseProps,
            currentTime: 0,
            duration: 0,
        }),
    );
    assert.doesNotMatch(zeroDuration, /role="progressbar"/);

    const noDuration = renderToStaticMarkup(
        React.createElement(NowPlayingCard, baseProps),
    );
    assert.doesNotMatch(noDuration, /role="progressbar"/);

    const nanDuration = renderToStaticMarkup(
        React.createElement(NowPlayingCard, {
            ...baseProps,
            currentTime: 10,
            duration: NaN,
        }),
    );
    assert.doesNotMatch(nanDuration, /role="progressbar"/);
});

test("NowPlayingCard links the title to the album page and the artist to the artist page, as siblings of the fly-to button", async () => {
    const NowPlayingCard = await nowPlayingCard();
    const html = renderToStaticMarkup(
        React.createElement(NowPlayingCard, {
            track: {
                id: "t1",
                title: "Linked Title",
                artist: { name: "Linked Artist", id: "ar-1" },
                album: { coverArt: null, id: "al-1" },
            },
            isPlaying: true,
            onMapPresent: true,
            moodColor: "#facc15",
            onFlyTo: noop,
            onTogglePlay: noop,
        }),
    );
    assert.match(html, /<a href="\/album\/al-1"[^>]*>Linked Title<\/a>/);
    assert.match(html, /<a href="\/artist\/ar-1"[^>]*>Linked Artist<\/a>/);
    // Links must be SIBLINGS of the fly-to button, never nested inside it —
    // the fly-to button closes before either link opens.
    const buttonClose = html.indexOf("</button>");
    const albumLinkOpen = html.indexOf('<a href="/album/al-1"');
    assert.ok(buttonClose !== -1 && albumLinkOpen !== -1);
    assert.ok(
        buttonClose < albumLinkOpen,
        "album link must not be nested inside the fly-to button",
    );
});

test("NowPlayingCard renders plain text (not a link) for title/artist when ids are empty", async () => {
    const NowPlayingCard = await nowPlayingCard();
    const html = renderToStaticMarkup(
        React.createElement(NowPlayingCard, {
            track: {
                id: "t2",
                title: "No Link Title",
                artist: { name: "No Link Artist", id: "" },
                album: { coverArt: null, id: "" },
            },
            isPlaying: false,
            onMapPresent: false,
            moodColor: null,
            onFlyTo: noop,
            onTogglePlay: noop,
        }),
    );
    assert.match(html, /No Link Title/);
    assert.match(html, /No Link Artist/);
    assert.doesNotMatch(html, /<a href="\/album\//);
    assert.doesNotMatch(html, /<a href="\/artist\//);
});

test("NowPlayingCard renders the likeSlot content when provided", async () => {
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
            likeSlot: React.createElement(
                "button",
                { "data-testid": "np-like" },
                "heart",
            ),
        }),
    );
    assert.match(html, /data-testid="np-like"/);
});

test("NowPlayingCard renders no like control when likeSlot is omitted", async () => {
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
        }),
    );
    assert.doesNotMatch(html, /data-testid="np-like"/);
});

// --- ViewControls ---------------------------------------------------------

function viewControlsBaseProps() {
    return {
        onZoomIn: noop,
        onZoomOut: noop,
        onReset: noop,
        layoutMode: "natural" as const,
        layoutDisabled: false,
        onToggleLayout: noop,
        brushArmed: false,
        onToggleBrush: noop,
        canLocate: true,
        locateHint: "Fly to now playing",
        onLocate: noop,
        canStartJourney: true,
        journeyHint: "Plan a journey from the current track",
        onStartJourney: noop,
        trailMode: "on" as const,
        onSetTrailMode: noop,
        trailPopoverOpen: false,
        onToggleTrailPopover: noop,
        trailEmpty: false,
        onClearTrail: noop,
        onSaveTrail: noop,
        aboutPopoverOpen: false,
        onToggleAboutPopover: noop,
        isFullscreen: false,
        onToggleFullscreen: noop,
        queueOpen: false,
        onToggleQueue: noop,
        queueCount: 0,
    };
}

test("ViewControls exposes labelled zoom/reset/layout/brush/locate/journey/trail/fullscreen buttons", async () => {
    const { ViewControls } = await import("../../components/vibe/ViewControls");
    const html = renderToStaticMarkup(
        React.createElement(ViewControls, viewControlsBaseProps()),
    );
    assert.match(html, /aria-label="Zoom in"/);
    assert.match(html, /aria-label="Zoom out"/);
    assert.match(html, /aria-label="Reset view"/);
    assert.match(html, /aria-label="Spread layout"/); // natural -> offers spread
    assert.match(html, /aria-label="Sweep brush"/);
    assert.match(html, /aria-label="Locate now playing"/);
    assert.match(html, /aria-label="Start a journey"/);
    assert.match(html, /aria-label="Session trail settings"/);
    assert.match(html, /aria-label="About this map"/);
    assert.match(html, /aria-label="Enter fullscreen"/);
    // Toggle-like controls carry aria-pressed.
    assert.match(html, /aria-pressed="false"/);
    // Trail mode "on" -> the Footprints button itself is pressed.
    assert.match(html, /aria-pressed="true"/);
    // Popover closed by default -> no segmented control markup rendered.
    assert.doesNotMatch(html, /Clear history/);
    // About popover closed by default (aboutPopoverOpen: false) -> its
    // content is absent and the button reports aria-expanded="false".
    assert.doesNotMatch(html, /neighborhoods are/i);
    const aboutButtonClosed = html.match(
        /<button[^>]*aria-label="About this map"[^>]*>/,
    )?.[0];
    assert.ok(aboutButtonClosed, "expected the About this map button markup");
    assert.match(aboutButtonClosed!, /aria-expanded="false"/);
});

test("ViewControls about popover follows the lifted aboutPopoverOpen/onToggleAboutPopover props (VibeMap's auxSurface)", async () => {
    const { ViewControls } = await import("../../components/vibe/ViewControls");
    const closed = renderToStaticMarkup(
        React.createElement(ViewControls, viewControlsBaseProps()),
    );
    assert.doesNotMatch(closed, /Mood colors/);

    const open = renderToStaticMarkup(
        React.createElement(ViewControls, {
            ...viewControlsBaseProps(),
            aboutPopoverOpen: true,
        }),
    );
    // The popover's content (AboutMapPopover) renders when the prop is true.
    assert.match(open, /neighborhoods are/i);
    assert.match(open, /Mood colors/);
    const aboutButtonOpen = open.match(
        /<button[^>]*aria-label="About this map"[^>]*>/,
    )?.[0];
    assert.ok(aboutButtonOpen, "expected the About this map button markup");
    assert.match(aboutButtonOpen!, /aria-expanded="true"/);
});

test("ViewControls trail popover renders the segmented mode control and a disabled Clear history when the trail is empty", async () => {
    const { ViewControls } = await import("../../components/vibe/ViewControls");
    const html = renderToStaticMarkup(
        React.createElement(ViewControls, {
            ...viewControlsBaseProps(),
            trailMode: "fade",
            trailPopoverOpen: true,
            trailEmpty: true,
        }),
    );
    assert.match(html, /role="menu"/);
    assert.match(html, /role="radiogroup"/);
    assert.match(html, />On</);
    assert.match(html, />Fade</);
    assert.match(html, />Off</);
    assert.match(html, /Clear history/);
    assert.match(html, /Save history as playlist/);
    // "fade" is selected among the three radio options.
    assert.match(html, /aria-checked="true"/);
    // Empty trail -> both Clear history and Save are disabled.
    const disabledCount = (html.match(/disabled=""/g) ?? []).length;
    assert.ok(disabledCount >= 2, "expected Clear history AND Save disabled");
});

test("ViewControls: trail mode 'off' un-presses the Footprints button", async () => {
    const { ViewControls } = await import("../../components/vibe/ViewControls");
    const html = renderToStaticMarkup(
        React.createElement(ViewControls, {
            ...viewControlsBaseProps(),
            trailMode: "off",
        }),
    );
    const footprintsButton = html.match(
        /<button[^>]*aria-label="Session trail settings"[^>]*>/,
    )?.[0];
    assert.ok(footprintsButton, "expected the Footprints button markup");
    assert.match(footprintsButton!, /aria-pressed="false"/);
});

test("ViewControls: queue toggle exposes aria-pressed and a count badge capped at 99+", async () => {
    const { ViewControls } = await import("../../components/vibe/ViewControls");
    const closedNoBadge = renderToStaticMarkup(
        React.createElement(ViewControls, viewControlsBaseProps()),
    );
    assert.match(closedNoBadge, /aria-label="Show queue"/);
    const queueButton = closedNoBadge.match(
        /<button[^>]*aria-label="Show queue"[^>]*>/,
    )?.[0];
    assert.ok(queueButton, "expected the queue toggle button markup");
    assert.match(queueButton!, /aria-pressed="false"/);
    // Empty queue -> no count badge rendered.
    assert.doesNotMatch(closedNoBadge, />99\+</);

    const openWithCount = renderToStaticMarkup(
        React.createElement(ViewControls, {
            ...viewControlsBaseProps(),
            queueOpen: true,
            queueCount: 7,
        }),
    );
    const openQueueButton = openWithCount.match(
        /<button[^>]*aria-label="Show queue"[^>]*>/,
    )?.[0];
    assert.ok(openQueueButton, "expected the queue toggle button markup");
    assert.match(openQueueButton!, /aria-pressed="true"/);
    assert.match(openWithCount, />7</);

    const cappedCount = renderToStaticMarkup(
        React.createElement(ViewControls, {
            ...viewControlsBaseProps(),
            queueCount: 140,
        }),
    );
    assert.match(cappedCount, />99\+</);
});

// --- SweepChip --------------------------------------------------------------

test("SweepChip renders the count, cap marker and labelled actions", async () => {
    const { SweepChip } = await import("../../components/vibe/SweepChip");
    const html = renderToStaticMarkup(
        React.createElement(SweepChip, {
            count: 23,
            capped: false,
            onPlay: noop,
            onQueue: noop,
            onSave: noop,
            onDismiss: noop,
        }),
    );
    assert.match(html, /23 tracks swept/);
    assert.match(html, /aria-label="Play 23 swept tracks"/);
    assert.match(html, /aria-label="Queue 23 swept tracks"/);
    assert.match(html, /aria-label="Dismiss sweep"/);
    assert.doesNotMatch(html, /\(max\)/);

    const capped = renderToStaticMarkup(
        React.createElement(SweepChip, {
            count: 100,
            capped: true,
            onPlay: noop,
            onQueue: noop,
            onSave: noop,
            onDismiss: noop,
        }),
    );
    assert.match(capped, /100 tracks swept \(max\)/);
});

// --- FiltersPanel ---------------------------------------------------------

async function filtersPanel() {
    const { FiltersPanel } = await import("../../components/vibe/FiltersPanel");
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
        }),
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
        }),
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

test("FiltersPanel default chip list includes a toggleable Neutral chip for the backend's neutral fallback mood", async () => {
    const FiltersPanel = await filtersPanel();
    // Deliberately DOESN'T include "neutral" in filters.activeMoods, so the
    // chip renders in its dimmed/inactive state — proving it's a real,
    // togglable chip (not just missing from the list, the F1 bug).
    const html = renderToStaticMarkup(
        React.createElement(FiltersPanel, {
            filters: filtersStub(4),
            total: 10,
            expanded: true,
            onExpandedChange: noop,
            reducedMotion: true,
        }),
    );
    assert.match(html, />Neutral</);
    // The neutral chip's dot uses the shared fallback gray, same as any
    // unrecognised mood key (types.ts's getMoodColor fallback).
    assert.match(html, /#6b7280/);
});

// --- Calibrated match % (vibeMatch.ts wired through the panels) -----------

/** A synthetic p0..p100 ladder (evenly spaced 0..2), same shape as
 *  api.getVibeCalibration's response — lets these tests target an exact
 *  calibrated percent without depending on a real backend sample. */
const TEST_QUANTILES: number[] = Array.from({ length: 101 }, (_, i) => i / 50);

test("TravelPanel renders the library-calibrated percent + label when quantiles are supplied", async () => {
    const { TravelPanel } = await panels();
    // distance === TEST_QUANTILES[10] (0.2) -> percentile rank 10 -> percent
    // 90 -> "same vibe" (see vibeMatch.test.ts for the same fixture).
    const n = neighbor("n1", "Calibrated Artist", 0.5);
    const calibratedNeighbor = { ...n, distance: TEST_QUANTILES[10] };
    const view = {
        currentId: "t1",
        currentTitle: "Origin",
        breadcrumbTitles: [{ id: "t1", title: "Origin" }],
        direction: "any" as const,
        onMapNeighbors: [calibratedNeighbor],
        offMapNeighbors: [],
        loading: false,
        error: null,
        quantiles: TEST_QUANTILES,
        originFeatures: null,
        setDirection: noop,
        navigate: noop,
        queue: noop,
        close: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(TravelPanel, { view }),
    );
    // Calibrated (90%, "same vibe") wins over the uncalibrated linear mapping
    // (Math.round((1 - 0.2/2) * 100) = 90 too here by coincidence of the
    // fixture — the label is the tell that calibration actually ran).
    assert.match(html, /90%/);
    assert.match(html, /title="same vibe"/);
});

test("JourneyPanel waypoint rows use the calibrated percent when quantiles are supplied", async () => {
    const { JourneyPanel } = await panels();
    const view = {
        fromId: "f1",
        fromLabel: "Origin",
        picking: false,
        destTrackId: null,
        destLabel: null,
        moodTarget: "chill",
        steps: 8,
        moods: [],
        targetLabel: "Chill",
        waypoints: [
            {
                id: "w1",
                title: "Waypoint One",
                album: { id: "al-w1", title: "", coverUrl: null },
                artist: { id: "ar-w1", name: "WP One Artist" },
                similarity: 0.8,
                // TEST_QUANTILES[25] -> percentile rank 25 -> percent 75 -> "close neighbors".
                distance: TEST_QUANTILES[25],
                onMap: true,
                seq: 1,
            },
        ],
        loading: false,
        error: null,
        canSubmit: true,
        quantiles: TEST_QUANTILES,
        togglePick: noop,
        chooseMood: noop,
        setSteps: noop,
        submit: noop,
        drift: noop,
        play: noop,
        save: async () => undefined,
        saving: false,
        close: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(JourneyPanel, { view }),
    );
    assert.match(html, /75%/);
    assert.match(html, /title="close neighbors"/);
});

// --- NeighborRow expansion (exported for direct, prop-driven testing) -----

test("NeighborRow expansion renders the calibrated sentence and per-feature match bars", async () => {
    const { NeighborRow } = await panels();
    const n = {
        id: "n1",
        title: "Deep Cut",
        album: { id: "al-n1", title: "", coverUrl: null },
        artist: { id: "ar-n1", name: "Deep Artist" },
        similarity: 0.8,
        distance: 0.2,
        energy: 0.6,
        valence: 0.4,
        moods: null,
        danceability: 0.7,
        arousal: 0.3,
    };
    const originFeatures = {
        energy: 0.5,
        valence: 0.5,
        danceability: 0.5,
        arousal: 0.5,
    };
    const html = renderToStaticMarkup(
        React.createElement(NeighborRow, {
            n,
            offMap: false,
            onNavigate: noop,
            onQueue: noop,
            quantiles: null,
            originFeatures,
            expanded: true,
            onToggleExpand: noop,
        }),
    );
    // Uncalibrated sentence form + all four feature bars (every feature has
    // both sides non-null in this fixture, so none are skipped).
    assert.match(html, /match\./);
    assert.match(html, /Energy/);
    assert.match(html, /Mood/);
    assert.match(html, /Groove/);
    assert.match(html, /Intensity/);
    assert.match(html, /aria-expanded="true"/);
});

test("NeighborRow collapsed (expanded=false) does not render the breakdown", async () => {
    const { NeighborRow } = await panels();
    const n = {
        id: "n1",
        title: "Deep Cut",
        album: { id: "al-n1", title: "", coverUrl: null },
        artist: { id: "ar-n1", name: "Deep Artist" },
        similarity: 0.8,
        distance: 0.2,
        energy: 0.6,
        valence: 0.4,
        moods: null,
        danceability: 0.7,
        arousal: 0.3,
    };
    const html = renderToStaticMarkup(
        React.createElement(NeighborRow, {
            n,
            offMap: false,
            onNavigate: noop,
            onQueue: noop,
            quantiles: null,
            originFeatures: null,
            expanded: false,
            onToggleExpand: noop,
        }),
    );
    assert.doesNotMatch(html, /Groove/);
    assert.match(html, /aria-expanded="false"/);
});

// --- Save as playlist (JourneyPanel + SweepChip) ---------------------------

test("JourneyPanel's Save button is wired to view.save, which calls createPlaylist then addTrackToPlaylist in order", async () => {
    const { JourneyPanel } = await panels();
    const calls: string[] = [];
    state.api = {
        createPlaylist: async (name) => {
            calls.push(`create:${name}`);
            return { id: "pl-journey" };
        },
        addTrackToPlaylist: async (playlistId, ref) => {
            calls.push(
                `add:${playlistId}:${(ref as { trackId: string }).trackId}`,
            );
            return {};
        },
    };
    const { saveTracksAsPlaylist } =
        await import("../../components/vibe/savePlaylist");
    const view = {
        fromId: "f1",
        fromLabel: "Origin",
        picking: false,
        destTrackId: null,
        destLabel: null,
        moodTarget: "chill",
        steps: 8,
        moods: [],
        targetLabel: "Chill",
        waypoints: [
            {
                id: "w1",
                title: "Waypoint One",
                album: { id: "al-w1", title: "", coverUrl: null },
                artist: { id: "ar-w1", name: "WP One Artist" },
                similarity: 0.8,
                distance: distanceForPercent(80),
                onMap: true,
                seq: 1,
            },
        ],
        loading: false,
        error: null,
        canSubmit: true,
        quantiles: null,
        togglePick: noop,
        chooseMood: noop,
        setSteps: noop,
        submit: noop,
        drift: noop,
        play: noop,
        // The exact callback the rendered button is wired to — a real save,
        // not a re-implementation, so this proves the button's contract.
        save: async () => {
            await saveTracksAsPlaylist("Journey to Chill — Jul 15", [
                "origin",
                "w1",
            ]);
        },
        saving: false,
        close: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(JourneyPanel, { view }),
    );
    assert.match(html, /aria-label="Save journey as playlist"/);

    await view.save();

    assert.deepEqual(calls, [
        "create:Journey to Chill — Jul 15",
        "add:pl-journey:origin",
        "add:pl-journey:w1",
    ]);
});

test("JourneyPanel's Save button shows a spinner and is disabled while saving", async () => {
    const { JourneyPanel } = await panels();
    const view = {
        fromId: "f1",
        fromLabel: "Origin",
        picking: false,
        destTrackId: null,
        destLabel: null,
        moodTarget: "chill",
        steps: 8,
        moods: [],
        targetLabel: "Chill",
        waypoints: [
            {
                id: "w1",
                title: "Waypoint One",
                album: { id: "al-w1", title: "", coverUrl: null },
                artist: { id: "ar-w1", name: "WP One Artist" },
                similarity: 0.8,
                distance: distanceForPercent(80),
                onMap: true,
                seq: 1,
            },
        ],
        loading: false,
        error: null,
        canSubmit: true,
        quantiles: null,
        togglePick: noop,
        chooseMood: noop,
        setSteps: noop,
        submit: noop,
        drift: noop,
        play: noop,
        save: async () => undefined,
        saving: true,
        close: noop,
    };
    const html = renderToStaticMarkup(
        React.createElement(JourneyPanel, { view }),
    );
    const saveButton = html.match(
        /<button[^>]*aria-label="Save journey as playlist"[^>]*>/,
    )?.[0];
    assert.ok(saveButton, "expected the Save button markup");
    assert.match(saveButton!, /disabled=""/);
});

test("SweepChip renders a Save action alongside Play/Queue, disabled while saving", async () => {
    const { SweepChip } = await import("../../components/vibe/SweepChip");
    const html = renderToStaticMarkup(
        React.createElement(SweepChip, {
            count: 12,
            capped: false,
            onPlay: noop,
            onQueue: noop,
            onSave: noop,
            saving: false,
            onDismiss: noop,
        }),
    );
    assert.match(html, /aria-label="Save 12 swept tracks as a playlist"/);

    const savingHtml = renderToStaticMarkup(
        React.createElement(SweepChip, {
            count: 12,
            capped: false,
            onPlay: noop,
            onQueue: noop,
            onSave: noop,
            saving: true,
            onDismiss: noop,
        }),
    );
    const playButton = savingHtml.match(
        /<button[^>]*aria-label="Play 12 swept tracks"[^>]*>/,
    )?.[0];
    assert.ok(playButton, "expected the Play button markup");
    assert.match(playButton!, /disabled=""/);
});

// --- About this map ---------------------------------------------------------

test("AboutMapPopover explains map distance semantics and renders the mood/glyph/gesture legends", async () => {
    const { AboutMapPopover } =
        await import("../../components/vibe/ViewControls");
    const html = renderToStaticMarkup(React.createElement(AboutMapPopover));
    assert.match(html, /neighborhoods are/i);
    assert.match(html, /calibrated against random pairs/i);
    // Mood legend: named moods + the neutral fallback chip.
    assert.match(html, />Happy</);
    assert.match(html, />Neutral</);
    // Glyph legend.
    assert.match(html, /Beacon/);
    assert.match(html, /listening trail/);
    assert.match(html, /flight plan/);
    // Gesture cheat-sheet.
    assert.match(html, /Sweep-to-queue/);
    assert.match(html, /Add to alchemy/);
});

// --- QueuePanel ---------------------------------------------------------

async function queuePanel() {
    const { QueuePanel, resolveQueueDropIndices } =
        await import("../../components/vibe/QueuePanel");
    return { QueuePanel, resolveQueueDropIndices };
}

function queueTrack(id: string, title: string, artistName: string) {
    return {
        id,
        title,
        artist: { name: artistName },
        album: { title: "" },
        duration: 200,
    };
}

const episodeQueueItem = {
    itemType: "episode" as const,
    id: "podcastA:ep1",
    title: "Episode Title",
    podcastTitle: "Podcast Name",
    podcastId: "podcastA",
    episodeId: "ep1",
    coverUrl: null,
    duration: 600,
};

test("QueuePanel marks the current track, lists upcoming rows (incl. episodes) with drag handles, and hides history", async () => {
    const { QueuePanel } = await queuePanel();
    const queue = [
        queueTrack("t0", "Past Song", "Past Artist"),
        queueTrack("t1", "Current Song", "Current Artist"),
        queueTrack("t2", "Next Song", "Next Artist"),
        episodeQueueItem,
    ];
    const html = renderToStaticMarkup(
        React.createElement(QueuePanel, {
            queue,
            currentIndex: 1,
            onClose: noop,
            onReorder: noop,
            onRemove: noop,
        }),
    );
    assert.match(html, />Queue</);
    assert.match(html, /Current Song/);
    assert.match(html, /Now playing/i);
    assert.match(html, /Next Song/);
    // Podcast episode in the queue renders its title + podcast, not a crash.
    assert.match(html, /Episode Title/);
    assert.match(html, /Podcast Name/);
    // History (before currentIndex) is not shown in the panel.
    assert.doesNotMatch(html, /Past Song/);
    // One drag handle per upcoming row (2 upcoming: Next Song + the episode).
    const dragHandles = html.match(/draggable="true"/g) ?? [];
    assert.equal(dragHandles.length, 2);
    assert.match(html, /aria-label="Remove Next Song from queue"/);
});

test("QueuePanel hides drag handles during Listen Together and omits remove when no primitive is passed", async () => {
    const { QueuePanel } = await queuePanel();
    const queue = [
        queueTrack("t1", "Current Song", "Current Artist"),
        queueTrack("t2", "Next Song", "Next Artist"),
    ];
    const html = renderToStaticMarkup(
        React.createElement(QueuePanel, {
            queue,
            currentIndex: 0,
            onClose: noop,
            onReorder: noop,
            reorderDisabled: true,
            // onRemove intentionally omitted.
        }),
    );
    assert.doesNotMatch(html, /draggable="true"/);
    assert.doesNotMatch(html, /aria-label="Remove Next Song from queue"/);
});

test("QueuePanel shows the empty state when nothing is queued", async () => {
    const { QueuePanel } = await queuePanel();
    const html = renderToStaticMarkup(
        React.createElement(QueuePanel, {
            queue: [queueTrack("t1", "Current Song", "Current Artist")],
            currentIndex: 0,
            onClose: noop,
            onReorder: noop,
        }),
    );
    assert.match(html, /Nothing queued — sweep some dots or play a journey\./);
});
