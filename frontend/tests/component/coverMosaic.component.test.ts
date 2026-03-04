import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Mock next/image as a plain <img>
mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", {
            src: props.src as string,
            alt: props.alt as string,
            "data-sizes": props.sizes as string,
            className: props.className as string,
        }),
});

// Mock lucide-react Music icon
mock.module("lucide-react", {
    namedExports: {
        Music: ({ className }: { className?: string }) =>
            React.createElement("svg", {
                "data-icon": "music",
                className,
            }),
    },
});

// Mock cn utility — just concatenate
mock.module("@/utils/cn", {
    namedExports: {
        cn: (...args: unknown[]) =>
            args.filter((a) => typeof a === "string" && a.length > 0).join(" "),
    },
});

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type CoverMosaicMod = typeof import("../../components/ui/CoverMosaic");

const loadComponent = async () => {
    const mod: CoverMosaicMod = await import("../../components/ui/CoverMosaic");
    return mod.CoverMosaic;
};

describe("CoverMosaic", () => {
    test("renders empty state with default Music icon when 0 URLs", async () => {
        const CoverMosaic = await loadComponent();
        const html = renderToStaticMarkup(
            React.createElement(CoverMosaic, { coverUrls: [] }),
        );
        assert.ok(html.includes('data-icon="music"'), "Should render Music icon");
        assert.ok(!html.includes("<img"), "Should not render any images");
    });

    test("renders custom emptyState when 0 URLs", async () => {
        const CoverMosaic = await loadComponent();
        const html = renderToStaticMarkup(
            React.createElement(CoverMosaic, {
                coverUrls: [],
                emptyState: React.createElement("span", null, "custom-empty"),
            }),
        );
        assert.ok(html.includes("custom-empty"), "Should render custom empty state");
        assert.ok(!html.includes('data-icon="music"'), "Should not render default Music icon");
    });

    test("renders loading skeleton when isLoading and 0 URLs", async () => {
        const CoverMosaic = await loadComponent();
        const html = renderToStaticMarkup(
            React.createElement(CoverMosaic, {
                coverUrls: [],
                isLoading: true,
            }),
        );
        assert.ok(html.includes("animate-pulse"), "Should show pulse animation");
        assert.ok(!html.includes('data-icon="music"'), "Should not render Music icon when loading");
    });

    test("renders single full-bleed image for 1 URL in 2x2", async () => {
        const CoverMosaic = await loadComponent();
        const html = renderToStaticMarkup(
            React.createElement(CoverMosaic, {
                coverUrls: ["url-1"],
                imageSizes: "200px",
            }),
        );
        assert.ok(html.includes('src="url-1"'), "Should render the image");
        assert.ok(html.includes('data-sizes="200px"'), "Should pass sizes prop");
        // Should NOT be in a grid
        assert.ok(!html.includes("grid-cols-2"), "Single image should not be in a grid");
    });

    test("renders 2x2 grid for multiple URLs", async () => {
        const CoverMosaic = await loadComponent();
        const html = renderToStaticMarkup(
            React.createElement(CoverMosaic, {
                coverUrls: ["url-1", "url-2", "url-3", "url-4"],
            }),
        );
        assert.ok(html.includes("grid-cols-2"), "Should render 2-column grid");
        assert.ok(html.includes('src="url-1"'));
        assert.ok(html.includes('src="url-4"'));
    });

    test("renders 3x2 grid", async () => {
        const CoverMosaic = await loadComponent();
        const html = renderToStaticMarkup(
            React.createElement(CoverMosaic, {
                coverUrls: ["u1", "u2", "u3", "u4", "u5", "u6"],
                layout: "3x2",
            }),
        );
        assert.ok(html.includes("grid-cols-3"), "Should render 3-column grid");
    });

    test("renders empty cells when fewer URLs than grid size", async () => {
        const CoverMosaic = await loadComponent();
        const html = renderToStaticMarkup(
            React.createElement(CoverMosaic, {
                coverUrls: ["url-1", "url-2"],
                showEmptyCellIcon: true,
            }),
        );
        // 2 images + 2 empty cells (2x2=4 total)
        const imgCount = (html.match(/<img/g) || []).length;
        assert.equal(imgCount, 2, "Should render 2 images");
        // empty cells should have music icon
        const iconCount = (html.match(/data-icon="music"/g) || []).length;
        assert.equal(iconCount, 2, "Should render 2 music icons in empty cells");
    });

    test("empty cells have no icon when showEmptyCellIcon is false", async () => {
        const CoverMosaic = await loadComponent();
        const html = renderToStaticMarkup(
            React.createElement(CoverMosaic, {
                coverUrls: ["url-1"],
                layout: "2x2",
            }),
        );
        // 1 URL in 2x2 = full-bleed, no empty cells
        // Let's test with 2 URLs instead
        const html2 = renderToStaticMarkup(
            React.createElement(CoverMosaic, {
                coverUrls: ["url-1", "url-2"],
                showEmptyCellIcon: false,
            }),
        );
        assert.ok(!html2.includes('data-icon="music"'), "Should not show music icons in empty cells");
    });

    test("applies greyed class", async () => {
        const CoverMosaic = await loadComponent();
        const html = renderToStaticMarkup(
            React.createElement(CoverMosaic, {
                coverUrls: ["url-1", "url-2"],
                greyed: true,
            }),
        );
        assert.ok(html.includes("opacity-50"), "Should have opacity");
        assert.ok(html.includes("grayscale"), "Should have grayscale");
    });

    test("applies hoverScale class", async () => {
        const CoverMosaic = await loadComponent();
        const html = renderToStaticMarkup(
            React.createElement(CoverMosaic, {
                coverUrls: ["url-1", "url-2", "url-3", "url-4"],
                hoverScale: true,
            }),
        );
        assert.ok(
            html.includes("group-hover:scale-105"),
            "Should have hover scale class on images",
        );
    });

    test("loading skeleton in 3x2 layout renders 6 cells", async () => {
        const CoverMosaic = await loadComponent();
        const html = renderToStaticMarkup(
            React.createElement(CoverMosaic, {
                coverUrls: [],
                layout: "3x2",
                isLoading: true,
            }),
        );
        assert.ok(html.includes("grid-cols-3"), "Should render 3-column grid");
        const pulseCount = (html.match(/animate-pulse/g) || []).length;
        assert.equal(pulseCount, 6, "Should render 6 skeleton cells");
    });
});
