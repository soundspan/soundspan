import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

const OPTIONS = [
    { value: "all", label: "All Books" },
    { value: "finished", label: "Finished" },
] as const;

test("renders one button per option inside a labelled group", async () => {
    const { FilterPills } = await import("../../components/ui/FilterPills");
    const html = renderToStaticMarkup(
        React.createElement(FilterPills, {
            options: OPTIONS,
            value: "all",
            onChange: () => undefined,
            "aria-label": "Filter audiobooks",
        }),
    );
    assert.equal(html.match(/<button/g)?.length, 2);
    assert.match(html, /role="group"/);
    assert.match(html, /aria-label="Filter audiobooks"/);
    assert.match(html, /All Books/);
    assert.match(html, /Finished/);
});

test("marks only the current value active with the default styling", async () => {
    const { FilterPills } = await import("../../components/ui/FilterPills");
    const html = renderToStaticMarkup(
        React.createElement(FilterPills, {
            options: OPTIONS,
            value: "finished",
            onChange: () => undefined,
        }),
    );
    assert.equal(html.match(/aria-pressed="true"/g)?.length, 1);
    assert.equal(html.match(/aria-pressed="false"/g)?.length, 1);
    const finished = html.slice(html.indexOf('aria-pressed="true"'));
    assert.match(finished, /bg-white text-black/);
    assert.match(finished, /Finished/);
});

test("no pill is active when the value matches no option", async () => {
    const { FilterPills } = await import("../../components/ui/FilterPills");
    const html = renderToStaticMarkup(
        React.createElement(FilterPills, {
            options: OPTIONS,
            value: "listening",
            onChange: () => undefined,
        }),
    );
    assert.equal(html.match(/aria-pressed="true"/g), null);
    assert.equal(html.match(/aria-pressed="false"/g)?.length, 2);
});

test("per-option activeClassName overrides the default active styling", async () => {
    const { FilterPills } = await import("../../components/ui/FilterPills");
    const html = renderToStaticMarkup(
        React.createElement(FilterPills, {
            options: [
                {
                    value: "discovery",
                    label: "Discovery",
                    activeClassName: "bg-ai text-white",
                },
                { value: "owned", label: "Owned" },
            ],
            value: "discovery",
            onChange: () => undefined,
            size: "sm",
        }),
    );
    const active = html.slice(html.indexOf('aria-pressed="true"'));
    assert.match(active, /bg-ai text-white/);
    assert.doesNotMatch(
        active.slice(0, active.indexOf(">")),
        /bg-white text-black/,
    );
});

test("sm size renders the chip scale, md the pill scale", async () => {
    const { FilterPills } = await import("../../components/ui/FilterPills");
    const sm = renderToStaticMarkup(
        React.createElement(FilterPills, {
            options: OPTIONS,
            value: "all",
            onChange: () => undefined,
            size: "sm",
        }),
    );
    assert.match(sm, /px-3 py-1\.5/);
    assert.match(sm, /text-xs font-medium/);
    const md = renderToStaticMarkup(
        React.createElement(FilterPills, {
            options: OPTIONS,
            value: "all",
            onChange: () => undefined,
        }),
    );
    assert.match(md, /px-4 py-2/);
    assert.match(md, /text-sm font-semibold/);
});
