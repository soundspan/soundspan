import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const distinctiveSubtitle = "Distinctive subtitle";

mock.module("next/link", {
    defaultExport: ({ children, href }: { children: React.ReactNode; href: string }) =>
        React.createElement("a", { href }, children),
});

test("BrowseCard renders a linked image, title, and subtitle", async () => {
    const { BrowseCard } = await import("../../features/explore/components/BrowseCard");
    const html = renderToStaticMarkup(
        React.createElement(BrowseCard, {
            href: "/explore/example",
            imageUrl: "/images/example.jpg",
            title: "Example title",
            subtitle: distinctiveSubtitle,
        })
    );

    assert.match(html, /<a href="\/explore\/example">/);
    assert.match(html, /Example title/);
    assert.match(html, new RegExp(distinctiveSubtitle));
    assert.match(html, /<img[^>]*src="\/images\/example\.jpg"/);
});

test("BrowseCard renders without a link when href is null", async () => {
    const { BrowseCard } = await import("../../features/explore/components/BrowseCard");
    const html = renderToStaticMarkup(
        React.createElement(BrowseCard, {
            href: null,
            imageUrl: null,
            title: "Unlinked title",
        })
    );

    assert.doesNotMatch(html, /<a(?:\s|>)/);
    assert.match(html, /Unlinked title/);
});

test("BrowseCard omits the subtitle paragraph when subtitle is undefined", async () => {
    const { BrowseCard } = await import("../../features/explore/components/BrowseCard");
    const html = renderToStaticMarkup(
        React.createElement(BrowseCard, {
            href: null,
            imageUrl: null,
            title: "Title without subtitle",
        })
    );

    assert.doesNotMatch(html, new RegExp(distinctiveSubtitle));
    assert.doesNotMatch(html, /text-xs text-gray-400 truncate/);
});

test("BrowseCard omits the image when imageUrl is null", async () => {
    const { BrowseCard } = await import("../../features/explore/components/BrowseCard");
    const html = renderToStaticMarkup(
        React.createElement(BrowseCard, {
            href: null,
            imageUrl: null,
            title: "Image-free title",
        })
    );

    assert.doesNotMatch(html, /<img(?:\s|>)/);
});
