import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

const apiState = {
    featuresCalls: 0,
    uiSettingsCalls: 0,
};

const apiExports = {
    api: {
        getFeatures: async () => {
            apiState.featuresCalls += 1;
            return {
                musicCNN: false,
                vibeEmbeddings: false,
                audioAnalysis: true,
                discovery: true,
                autoPlaylists: true,
            };
        },
        getUiSettings: async () => {
            apiState.uiSettingsCalls += 1;
            return { showVersion: false };
        },
    },
};

mock.module("@/lib/api", {
    namedExports: apiExports,
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    apiState.featuresCalls = 0;
    apiState.uiSettingsCalls = 0;
    setVisibility("visible");
});

function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: state,
    });
}

async function changeVisibility(state: DocumentVisibilityState): Promise<void> {
    await React.act(async () => {
        setVisibility(state);
        document.dispatchEvent(new Event("visibilitychange"));
    });
}

async function flushMicrotasks(): Promise<void> {
    await React.act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

async function mountProvider() {
    const { FeaturesProvider } = await import("../../lib/features-context");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(FeaturesProvider, null, "content")
        );
    });
    await flushMicrotasks();

    return {
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

async function dispatchTabReturn(): Promise<void> {
    await React.act(async () => {
        setVisibility("visible");
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
        await Promise.resolve();
        await Promise.resolve();
    });
}

test("refreshes exactly once when a hidden tab becomes visible", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const harness = await mountProvider();
    t.after(harness.unmount);
    assert.equal(apiState.featuresCalls, 1);
    assert.equal(apiState.uiSettingsCalls, 1);

    await changeVisibility("hidden");
    await dispatchTabReturn();

    assert.equal(apiState.featuresCalls, 2);
    assert.equal(apiState.uiSettingsCalls, 2);
});

test("does not refresh on the interval while hidden", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const harness = await mountProvider();
    t.after(harness.unmount);
    assert.equal(apiState.featuresCalls, 1);
    assert.equal(apiState.uiSettingsCalls, 1);

    await changeVisibility("hidden");
    await React.act(async () => {
        t.mock.timers.tick(60_000);
        await Promise.resolve();
    });

    assert.equal(apiState.featuresCalls, 1);
    assert.equal(apiState.uiSettingsCalls, 1);
});
