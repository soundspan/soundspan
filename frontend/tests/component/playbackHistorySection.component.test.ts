import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = () => React.createElement("i");

mock.module("next/link", {
    defaultExport: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    }) =>
        React.createElement("a", { href, ...rest }, children),
});

mock.module("lucide-react", {
    namedExports: {
        AlertTriangle: Icon,
        ChevronDown: Icon,
        Check: Icon,
        X: Icon,
        Loader2: Icon,
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getPlayHistorySummary: async () => ({
                allTime: 0,
                last7Days: 0,
                last30Days: 0,
                last365Days: 0,
            }),
            clearPlayHistory: async () => ({ deletedCount: 0 }),
        },
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

test("renders history settings row with my-history route", async () => {
    const { PlaybackHistorySection } = await import(
        "../../features/settings/components/sections/PlaybackHistorySection.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(PlaybackHistorySection)
    );

    assert.match(html, /History &amp; Personalization/);
    assert.match(html, /Open My History/);
    assert.match(html, /href="\/my-history"/);
    assert.match(html, /Clear History/);
});

test("renders configured history range options", async () => {
    const { PlaybackHistorySection } = await import(
        "../../features/settings/components/sections/PlaybackHistorySection.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(PlaybackHistorySection)
    );

    assert.match(html, />Past week</);
    assert.match(html, />Past month</);
    assert.match(html, />Past year</);
    assert.match(html, />All time</);
    assert.match(html, /Loading history totals/);
});
