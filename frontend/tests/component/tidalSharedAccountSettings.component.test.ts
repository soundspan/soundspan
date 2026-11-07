import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
    SystemSettings,
    UserSettings,
} from "../../features/settings/types";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type StreamingStatus = {
    enabled: boolean;
    available: boolean;
    authenticated: boolean;
    credentialsConfigured: boolean;
    accountMode?: "user" | "instance";
};

let streamingStatus: StreamingStatus;

const getTidalStreamingStatus = mock.fn(async () => streamingStatus);

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getTidalStreamingStatus,
            initiateTidalAuth: async () => ({}),
            pollTidalAuth: async () => ({ status: "pending" }),
            clearTidalStreamingAuth: async () => ({ success: true }),
            tidalDeviceAuth: async () => ({}),
            tidalPollAuth: async () => ({ success: false }),
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        createFrontendLogger: () => ({
            error: () => undefined,
            warn: () => undefined,
            info: () => undefined,
            debug: () => undefined,
        }),
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
    getTidalStreamingStatus.mock.resetCalls();
    document.body.replaceChildren();
});

const userSettings = {
    showTidalExplore: true,
    tidalStreamingQuality: "HIGH",
} as UserSettings;

const systemSettings = {
    tidalEnabled: true,
    tidalConnected: true,
    tidalUserId: "12345",
    tidalCountryCode: "GB",
    tidalQuality: "HIGH",
    tidalFileTemplate: "",
    tidalStreamingUseInstanceAccount: false,
} as SystemSettings;

async function mount(element: React.ReactElement) {
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(element);
        await Promise.resolve();
        await Promise.resolve();
    });
    return {
        container,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

function buttonLabels(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("button")).map(
        (button) => button.textContent?.trim() ?? "",
    );
}

test("user card shows the server account and no link controls in shared mode", async () => {
    streamingStatus = {
        enabled: true,
        available: true,
        authenticated: true,
        credentialsConfigured: true,
        accountMode: "instance",
    };
    const { TidalStreamingCard } =
        await import("../../features/settings/components/sections/TidalStreamingSection");

    const view = await mount(
        React.createElement(TidalStreamingCard, {
            settings: userSettings,
            onUpdate: () => undefined,
        }),
    );

    assert.match(view.container.textContent ?? "", /server's TIDAL account/);
    assert.ok(!buttonLabels(view.container).includes("Disconnect"));
    assert.ok(!buttonLabels(view.container).includes("Connect"));
    assert.match(view.container.textContent ?? "", /Streaming Quality/);
    await view.unmount();
});

test("user card keeps the per-user connect flow when sharing is off", async () => {
    streamingStatus = {
        enabled: true,
        available: true,
        authenticated: false,
        credentialsConfigured: false,
        accountMode: "user",
    };
    const { TidalStreamingCard } =
        await import("../../features/settings/components/sections/TidalStreamingSection");

    const view = await mount(
        React.createElement(TidalStreamingCard, {
            settings: userSettings,
            onUpdate: () => undefined,
        }),
    );

    assert.match(view.container.textContent ?? "", /Not connected/);
    assert.ok(buttonLabels(view.container).includes("Connect"));
    await view.unmount();
});

test("admin card toggles sharing the TIDAL account with every user", async () => {
    const { TidalCard } =
        await import("../../features/settings/components/sections/TidalSection");
    const updates: Array<Partial<SystemSettings>> = [];

    const view = await mount(
        React.createElement(TidalCard, {
            settings: systemSettings,
            onUpdate: (next: Partial<SystemSettings>) => updates.push(next),
            onTest: async () => ({ success: true }),
            isTesting: false,
        }),
    );

    const toggle = view.container.querySelector<HTMLInputElement>(
        "#tidal-streaming-shared-account",
    );
    assert.ok(toggle, "expected the shared-account toggle");
    assert.equal(toggle.checked, false);
    assert.match(
        view.container.textContent ?? "",
        /Share this account with all users/,
    );

    await React.act(async () => {
        toggle.click();
        await Promise.resolve();
    });

    assert.deepEqual(updates, [{ tidalStreamingUseInstanceAccount: true }]);
    await view.unmount();
});
