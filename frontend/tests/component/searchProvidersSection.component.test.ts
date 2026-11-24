import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SystemSettings } from "../../features/settings/types";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

async function mount(settings: Partial<SystemSettings>) {
    const { SearchProvidersSection } =
        await import("../../features/settings/components/sections/SearchProvidersSection");
    const { createRoot } = await import("react-dom/client");
    const updates: Array<Partial<SystemSettings>> = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(SearchProvidersSection, {
                settings: settings as SystemSettings,
                onUpdate: (update: Partial<SystemSettings>) =>
                    updates.push(update),
            }),
        );
    });
    return {
        container,
        updates,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

function providerNames(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("[data-search-provider]")).map(
        (row) => row.getAttribute("data-search-provider") ?? "",
    );
}

async function click(element: Element | null): Promise<void> {
    assert.ok(element instanceof HTMLElement, "missing element");
    await React.act(async () => {
        element.click();
    });
}

test("lists providers in the stored priority order", async (t) => {
    const harness = await mount({
        searchProviderOrder: "deezer,lastfm,youtube,tidal",
        searchProvidersEnabled: "deezer,lastfm",
    });
    t.after(harness.unmount);

    assert.deepEqual(providerNames(harness.container), [
        "deezer",
        "lastfm",
        "youtube",
        "tidal",
    ]);
});

test("moving a provider up saves the new order", async (t) => {
    const harness = await mount({
        searchProviderOrder: "lastfm,deezer,tidal,youtube",
        searchProvidersEnabled: "lastfm,deezer",
    });
    t.after(harness.unmount);

    await click(
        harness.container.querySelector('[aria-label="Move Deezer up"]'),
    );

    assert.deepEqual(harness.updates, [
        { searchProviderOrder: "deezer,lastfm,tidal,youtube" },
    ]);
});

test("the first provider cannot move up and the last cannot move down", async (t) => {
    const harness = await mount({
        searchProviderOrder: "lastfm,deezer,tidal,youtube",
        searchProvidersEnabled: "lastfm",
    });
    t.after(harness.unmount);

    const up = harness.container.querySelector(
        '[aria-label="Move Last.fm up"]',
    ) as HTMLButtonElement;
    const down = harness.container.querySelector(
        '[aria-label="Move YouTube Music down"]',
    ) as HTMLButtonElement;
    assert.equal(up.disabled, true);
    assert.equal(down.disabled, true);
});

test("turning a provider on adds it to the enabled list in priority order", async (t) => {
    const harness = await mount({
        searchProviderOrder: "tidal,lastfm,deezer,youtube",
        searchProvidersEnabled: "lastfm",
    });
    t.after(harness.unmount);

    await click(
        harness.container.querySelector(
            '[data-search-provider="tidal"] input[type="checkbox"]',
        ),
    );

    assert.deepEqual(harness.updates, [
        { searchProvidersEnabled: "tidal,lastfm" },
    ]);
});
