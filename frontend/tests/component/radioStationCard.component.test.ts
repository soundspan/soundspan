import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = ({ "data-icon": dataIcon }: { "data-icon"?: string }) =>
    React.createElement("svg", { "data-icon": dataIcon });

mock.module("lucide-react", {
    namedExports: {
        Loader2: () => React.createElement(Icon, { "data-icon": "loader" }),
    },
});

mock.module("@/app/radio/RadioStationMosaic", {
    namedExports: {
        RadioStationMosaic: ({ filter }: { filter: { type: string } }) =>
            React.createElement(
                "div",
                { "data-testid": "radio-station-mosaic" },
                filter.type,
            ),
    },
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
    const named = mod as unknown as {
        RadioStationCard?: (
            props: Record<string, unknown>,
        ) => React.ReactElement;
    };
    const cjsDefault = (
        mod as {
            default?: {
                RadioStationCard?: (
                    props: Record<string, unknown>,
                ) => React.ReactElement;
            };
        }
    ).default;
    const RadioStationCard =
        named.RadioStationCard ?? cjsDefault?.RadioStationCard;
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
        }),
    );

    assert.match(html, /Deep Focus Radio/);
    assert.match(html, /Instrumental focus picks/);
    assert.match(html, /radio-station-mosaic/);
    assert.match(html, /genre/);
});

test("RadioStationCard renders no play overlay or spinner at rest", async () => {
    const RadioStationCard = await loadCardComponent();
    const html = renderToStaticMarkup(
        React.createElement(RadioStationCard, {
            station: baseStation,
            onPlay: () => undefined,
            isLoading: false,
        }),
    );

    assert.doesNotMatch(html, /data-icon="play"/);
    assert.doesNotMatch(html, /data-icon="loader"/);
});

test("RadioStationCard shows spinner only while loading", async () => {
    const RadioStationCard = await loadCardComponent();

    const loadingHtml = renderToStaticMarkup(
        React.createElement(RadioStationCard, {
            station: baseStation,
            onPlay: () => undefined,
            isLoading: true,
        }),
    );
    assert.match(loadingHtml, /data-icon="loader"/);
    assert.doesNotMatch(loadingHtml, /data-icon="play"/);
});

test("RadioStationCard click handler invokes the onPlay callback", async () => {
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

    assert.equal(playCalls, 0);
});
