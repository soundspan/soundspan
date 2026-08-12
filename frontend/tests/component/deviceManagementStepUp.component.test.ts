import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let generateFailure: Error | null = null;
const request = mock.fn(async (endpoint: string, options?: RequestInit) => {
    if (endpoint === "/device-link/devices" && !options?.method) {
        return [
            {
                id: "device-1",
                name: "Living Room",
                lastUsed: "2026-08-12T00:00:00.000Z",
                createdAt: "2026-08-01T00:00:00.000Z",
            },
        ];
    }
    if (endpoint === "/device-link/generate" && generateFailure) {
        throw generateFailure;
    }
    if (endpoint === "/device-link/devices/device-1") {
        throw new Error("Interactive session authentication required");
    }
    return {};
});

mock.module("next/navigation", {
    namedExports: { useRouter: () => ({ push: () => undefined }) },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({ isAuthenticated: true, isLoading: false }),
    },
});

mock.module("@/hooks/useVisibilityGatedInterval", {
    namedExports: { useVisibilityGatedInterval: () => undefined },
});

mock.module("@/lib/api", { namedExports: { api: { request } } });

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
    generateFailure = null;
    request.mock.resetCalls();
    document.body.replaceChildren();
});

async function mountDevicePage() {
    const { default: DeviceLinkPage } = await import("../../app/device/page");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(React.createElement(DeviceLinkPage));
        await Promise.resolve();
        await Promise.resolve();
    });

    return {
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

function findButton(text: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) =>
            candidate.textContent?.trim() === text || candidate.title === text,
    );
    assert.ok(button instanceof HTMLButtonElement, `Missing ${text} button`);
    return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
    await React.act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
    });
}

test("shows the interactive-session message when device revocation is forbidden", async (t) => {
    const harness = await mountDevicePage();
    t.after(harness.unmount);

    await click(findButton("Revoke device"));

    assert.match(
        document.body.textContent ?? "",
        /Interactive session authentication required/,
    );
});

test("shows the interactive-session message when link-code generation is forbidden", async (t) => {
    generateFailure = new Error("Interactive session authentication required");
    const harness = await mountDevicePage();
    t.after(harness.unmount);

    await click(findButton("Generate Code"));

    assert.match(
        document.body.textContent ?? "",
        /Interactive session authentication required/,
    );
});
