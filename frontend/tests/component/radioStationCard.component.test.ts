import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const feedbackState = {
    showSpinner: false,
    triggerCalls: 0,
};

const Icon = ({ "data-icon": dataIcon }: { "data-icon"?: string }) =>
    React.createElement("svg", { "data-icon": dataIcon });

mock.module("lucide-react", {
    namedExports: {
        Play: () => React.createElement(Icon, { "data-icon": "play" }),
        Loader2: () => React.createElement(Icon, { "data-icon": "loader" }),
    },
});

mock.module("@/hooks/usePlayButtonFeedback", {
    namedExports: {
        usePlayButtonFeedback: () => ({
            showSpinner: feedbackState.showSpinner,
            triggerPlayFeedback: () => {
                feedbackState.triggerCalls += 1;
            },
        }),
    },
});

mock.module("@/app/radio/RadioStationMosaic", {
    namedExports: {
        RadioStationMosaic: ({ filter }: { filter: { type: string } }) =>
            React.createElement("div", { "data-testid": "radio-station-mosaic" }, filter.type),
    },
});

beforeEach(() => {
    feedbackState.showSpinner = false;
    feedbackState.triggerCalls = 0;
});

type Station = {
    id: string;
    name: string;
    description: string;
    color: string;
    filter: { type: "genre"; value: string };
};

const baseStation: Station = {
    id: "station-1",
    name: "Deep Focus Radio",
    description: "Instrumental focus picks",
    color: "from-blue-500 to-cyan-400",
    filter: { type: "genre", value: "focus" },
};

async function loadCardComponent() {
    const mod = await import("../../components/ui/RadioStationCard");
    const named = mod as { RadioStationCard?: (props: Record<string, unknown>) => React.ReactElement };
    const cjsDefault = (mod as { default?: { RadioStationCard?: (props: Record<string, unknown>) => React.ReactElement } }).default;
    const RadioStationCard = named.RadioStationCard ?? cjsDefault?.RadioStationCard;
    assert.ok(RadioStationCard, "RadioStationCard export is available");
    return RadioStationCard;
}

test("RadioStationCard renders station metadata and mosaic", async () => {
    const RadioStationCard = await loadCardComponent();
    const html = renderToStaticMarkup(
        React.createElement(RadioStationCard, {
            station: baseStation,
            onPlay: () => undefined,
            isLoading: false,
        })
    );

    assert.match(html, /Deep Focus Radio/);
    assert.match(html, /Instrumental focus picks/);
    assert.match(html, /radio-station-mosaic/);
    assert.match(html, /genre/);
});

test("RadioStationCard shows play icon when not loading", async () => {
    const RadioStationCard = await loadCardComponent();
    const html = renderToStaticMarkup(
        React.createElement(RadioStationCard, {
            station: baseStation,
            onPlay: () => undefined,
            isLoading: false,
        })
    );

    assert.match(html, /data-icon="play"/);
    assert.doesNotMatch(html, /data-icon="loader"/);
});

test("RadioStationCard shows spinner icon while loading or play feedback spinner is active", async () => {
    const RadioStationCard = await loadCardComponent();

    const loadingHtml = renderToStaticMarkup(
        React.createElement(RadioStationCard, {
            station: baseStation,
            onPlay: () => undefined,
            isLoading: true,
        })
    );
    assert.match(loadingHtml, /data-icon="loader"/);

    feedbackState.showSpinner = true;
    const feedbackSpinnerHtml = renderToStaticMarkup(
        React.createElement(RadioStationCard, {
            station: baseStation,
            onPlay: () => undefined,
            isLoading: false,
        })
    );
    assert.match(feedbackSpinnerHtml, /data-icon="loader"/);
});

test("RadioStationCard click handler triggers feedback and onPlay callback", async () => {
    const RadioStationCard = await loadCardComponent();
    let playCalls = 0;

    const element = RadioStationCard({
        station: baseStation,
        onPlay: () => {
            playCalls += 1;
        },
        isLoading: false,
    });

    const onClick = (element.props as { onClick?: () => void }).onClick;
    assert.equal(typeof onClick, "function");

    onClick?.();

    assert.equal(feedbackState.triggerCalls, 1);
    assert.equal(playCalls, 1);
    assert.equal((element.props as { disabled?: boolean }).disabled, false);
});

test("RadioStationCard suppresses click side effects while loading", async () => {
    const RadioStationCard = await loadCardComponent();
    let playCalls = 0;

    const element = RadioStationCard({
        station: baseStation,
        onPlay: () => {
            playCalls += 1;
        },
        isLoading: true,
    });

    const onClick = (element.props as { onClick?: () => void }).onClick;
    assert.equal(typeof onClick, "function");
    assert.equal((element.props as { disabled?: boolean }).disabled, true);

    onClick?.();

    assert.equal(feedbackState.triggerCalls, 0);
    assert.equal(playCalls, 0);
});
