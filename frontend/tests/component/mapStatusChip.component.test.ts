import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MapStatusChip } from "../../components/vibe/MapStatusChip";
import type { MapStatusView } from "../../components/vibe/mapStatus";

/**
 * Static render tests for the map status chip. renderToStaticMarkup cannot
 * drive clicks, so each prop-driven state is rendered DIRECTLY and the
 * always-rendered markup is asserted: the live status text, the tooltip, the
 * sample badge, and whether the admin rebuild control exists and is enabled.
 * The copy itself is covered by the mapStatus unit tests.
 */

const IDLE: MapStatusView = {
    summary: "Built 3h ago · 5,617 songs",
    detail: "The map is rebuilt automatically about once a day.",
    sampled: false,
    busy: false,
    migration: null,
};

function render(props: Partial<React.ComponentProps<typeof MapStatusChip>>) {
    return renderToStaticMarkup(
        React.createElement(MapStatusChip, {
            status: IDLE,
            canRebuild: false,
            onRebuild: () => undefined,
            ...props,
        }),
    );
}

test("renders the live status text with its tooltip", () => {
    const html = render({});
    assert.match(html, /role="status"/);
    assert.match(html, /Built 3h ago · 5,617 songs/);
    assert.match(
        html,
        /title="The map is rebuilt automatically about once a day\."/,
    );
    assert.match(html, /data-vibe-panel="map-status"/);
});

test("non-admins see no rebuild control", () => {
    const html = render({ canRebuild: false });
    assert.doesNotMatch(html, /Rebuild map/);
    assert.doesNotMatch(html, /<button/);
});

test("admins get an enabled rebuild button with an accessible name", () => {
    const html = render({ canRebuild: true });
    assert.match(html, /<button[^>]*type="button"/);
    assert.match(html, /aria-label="Rebuild map"/);
    assert.match(html, />Rebuild</);
    assert.doesNotMatch(html, /disabled=""/);
});

test("a busy rebuild disables the button and shows progress", () => {
    const html = render({
        canRebuild: true,
        status: { ...IDLE, summary: "Rebuilding the map…", busy: true },
    });
    assert.match(html, /disabled=""/);
    assert.match(html, /animate-spin/);
    assert.match(html, /Rebuilding the map…/);
});

test("compact mode keeps the icon-only button", () => {
    const html = render({ canRebuild: true, compact: true });
    assert.match(html, /aria-label="Rebuild map"/);
    assert.doesNotMatch(html, />Rebuild</);
});

test("a sampled map shows the sample badge", () => {
    const html = render({ status: { ...IDLE, sampled: true } });
    assert.match(html, />Sample</);
    assert.match(html, /Random sample of your library/);
});

test("an in-progress re-analysis shows its badge and explanation", () => {
    const html = render({
        status: {
            ...IDLE,
            migration: {
                badge: "Re-analyzing · 21%",
                detail: "A newer analysis is in progress: 5,617 of 26,716 songs done.",
            },
        },
    });
    assert.match(html, />Re-analyzing · 21%</);
    assert.match(html, /title="A newer analysis is in progress/);
});

test("no migration means no re-analysis badge", () => {
    assert.doesNotMatch(render({}), /Re-analyzing/);
});
