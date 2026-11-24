import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("@/lib/api", {
    namedExports: {
        api: {
            searchMusicBrainzArtists: async () => [],
            searchMusicBrainzReleaseGroups: async () => [],
        },
    },
});

const toast = Object.assign(() => undefined, {
    success: () => undefined,
    error: () => undefined,
    info: () => undefined,
});
mock.module("sonner", { namedExports: { toast } });
mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: () => undefined,
            warn: () => undefined,
            info: () => undefined,
            debug: () => undefined,
        },
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    document.body.replaceChildren();
});

async function mountLookup(currentValue: string) {
    const { MusicBrainzLookup } =
        await import("../../components/ui/MusicBrainzLookup");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(MusicBrainzLookup, {
                type: "artist",
                currentValue,
                currentName: "Artist",
                onSelect: () => undefined,
            }),
        );
    });

    return async () => {
        await React.act(async () => root.unmount());
        container.remove();
    };
}

test("flags an artist without a MusicBrainz id as needing a match", async (t) => {
    t.after(await mountLookup(""));

    assert.match(document.body.textContent ?? "", /needs matching/i);
});

test("flags a legacy synthetic id as needing a match", async (t) => {
    t.after(await mountLookup("temp-artist-1"));

    assert.match(document.body.textContent ?? "", /needs matching/i);
});

test("shows a real MusicBrainz id as matched", async (t) => {
    t.after(await mountLookup("0383dadf-2a4e-4d10-a46a-e9e041da8eb3"));

    const text = document.body.textContent ?? "";
    assert.doesNotMatch(text, /needs matching/i);
    assert.match(text, /0383dadf/);
});
