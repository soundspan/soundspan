import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

after(() => {
    GlobalRegistrator.unregister();
});

mock.module("@/components/ui/Card", {
    namedExports: {
        Card: ({ children }: { children?: React.ReactNode }) =>
            React.createElement("div", null, children),
    },
});

const sections = Array.from({ length: 51 }, (_, index) => ({
    index,
    title: `Section ${index + 1}`,
    startSeconds: index * 60,
}));

async function render(props: Record<string, unknown>) {
    const { ChapterList } =
        await import("../../features/audiobook/components/ChapterList");
    return renderToStaticMarkup(
        React.createElement(ChapterList, {
            kind: "chapters",
            sections,
            sectionsPlayable: true,
            onSeekToSection: () => undefined,
            formatTime: (seconds: number) => `${seconds}s`,
            ...props,
        } as never),
    );
}

test("renders validated section navigation without a chapter-count heuristic", async () => {
    const html = await render({});

    assert.match(html, />Chapters</);
    assert.match(html, /Section 51/);
    assert.match(html, /3000s/);
});

test("labels file-derived navigation as parts", async () => {
    const html = await render({
        kind: "parts",
        sections: sections.slice(0, 2),
    });

    assert.match(html, />Parts</);
    assert.match(html, /Section 2/);
});

test("hides navigation for honest-empty and non-playable sections", async () => {
    assert.equal(
        await render({ kind: "none", sections: [], sectionsPlayable: false }),
        "",
    );
    assert.equal(await render({ sectionsPlayable: false }), "");
});

test("seeks to the validated section start", async () => {
    const { createRoot } = await import("react-dom/client");
    const { ChapterList } =
        await import("../../features/audiobook/components/ChapterList");
    const seekCalls: number[] = [];
    const container = document.createElement("div");
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(ChapterList, {
                kind: "chapters",
                sections: sections.slice(0, 2),
                sectionsPlayable: true,
                onSeekToSection: (seconds: number) => seekCalls.push(seconds),
                formatTime: (seconds: number) => `${seconds}s`,
            }),
        );
    });

    const buttons = container.querySelectorAll("button");
    assert.equal(buttons.length, 2);
    await React.act(async () => buttons[1]?.click());
    assert.deepEqual(seekCalls, [60]);

    await React.act(async () => root.unmount());
});
