import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("lucide-react", {
    namedExports: {
        Download: (props: Record<string, unknown> = {}) =>
            React.createElement("svg", props),
        Network: (props: Record<string, unknown> = {}) =>
            React.createElement("svg", props),
    },
});

test("SearchFilters hides the Peers pill when federation is disabled", async () => {
    const { SearchFilters } =
        await import("../../features/search/components/SearchFilters");
    const html = renderToStaticMarkup(
        React.createElement(SearchFilters, {
            filterTab: "all",
            onFilterChange: () => undefined,
            soulseekEnabled: false,
            federationEnabled: false,
            hasSearched: true,
        }),
    );
    assert.doesNotMatch(html, />Peers</);
});

test("SearchFilters shows the Peers pill when federation is enabled", async () => {
    const { SearchFilters } =
        await import("../../features/search/components/SearchFilters");
    const html = renderToStaticMarkup(
        React.createElement(SearchFilters, {
            filterTab: "peers",
            onFilterChange: () => undefined,
            soulseekEnabled: false,
            federationEnabled: true,
            hasSearched: true,
        }),
    );
    assert.match(html, />Peers</);
    assert.match(html, /bg-brand/);
});

test("SearchFilters keeps TV navigation attributes on every pill", async () => {
    const { SearchFilters } =
        await import("../../features/search/components/SearchFilters");
    const html = renderToStaticMarkup(
        React.createElement(SearchFilters, {
            filterTab: "all",
            onFilterChange: () => undefined,
            soulseekEnabled: true,
            federationEnabled: false,
            hasSearched: true,
        }),
    );
    assert.match(html, /data-tv-section="search-filters"/);
    // Soulseek takes index 4 when federation is disabled
    assert.match(html, /data-tv-card-index="4"[^>]*>[\s\S]*?Soulseek/);
    assert.equal(html.match(/data-tv-card=""/g)?.length, 5);
});

test("SearchFilters renders nothing before a search has run", async () => {
    const { SearchFilters } =
        await import("../../features/search/components/SearchFilters");
    const html = renderToStaticMarkup(
        React.createElement(SearchFilters, {
            filterTab: "all",
            onFilterChange: () => undefined,
            soulseekEnabled: true,
            federationEnabled: true,
            hasSearched: false,
        }),
    );
    assert.equal(html, "");
});
