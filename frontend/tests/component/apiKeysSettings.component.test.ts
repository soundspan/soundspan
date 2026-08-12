import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface ListedApiKey {
    id: string;
    name: string;
    createdAt: string;
    expiresAt: string;
    lastUsed: string | null;
}

let listedApiKeys: ListedApiKey[] = [];
let createFailure: Error | null = null;
let revokeFailure: Error | null = null;

const listApiKeys = mock.fn(async () => ({ apiKeys: listedApiKeys }));
const createApiKey = mock.fn(async () => {
    if (createFailure) throw createFailure;
    return {
        apiKey: "generated-key",
        name: "Test key",
        createdAt: "2026-08-12T00:00:00.000Z",
        expiresAt: "2026-11-10T00:00:00.000Z",
        message: "Created",
    };
});
const revokeApiKey = mock.fn(async () => {
    if (revokeFailure) throw revokeFailure;
    return { message: "Revoked" };
});

mock.module("@/lib/api", {
    namedExports: {
        api: { listApiKeys, createApiKey, revokeApiKey },
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
    listedApiKeys = [];
    createFailure = null;
    revokeFailure = null;
    listApiKeys.mock.resetCalls();
    createApiKey.mock.resetCalls();
    revokeApiKey.mock.resetCalls();
    document.body.replaceChildren();
});

async function mountApiKeysSection() {
    const { APIKeysSection } =
        await import("../../features/settings/components/sections/APIKeysSection");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(React.createElement(APIKeysSection));
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

function findButton(text: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === text,
    );
    assert.ok(button instanceof HTMLButtonElement, `Missing ${text} button`);
    return button;
}

function findLastButton(text: string): HTMLButtonElement {
    const buttons = Array.from(document.querySelectorAll("button")).filter(
        (candidate) => candidate.textContent?.trim() === text,
    );
    const button = buttons.at(-1);
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

function typeInto(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
    )?.set;
    assert.ok(setter, "expected the input value setter");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

function formatDate(dateString: string): string {
    return new Date(dateString).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

test("lists API-key expiry dates with expired and expiring-soon states", async (t) => {
    t.mock.method(Date, "now", () => Date.parse("2026-08-12T00:00:00.000Z"));
    const expiringSoon = "2026-08-15T00:00:00.000Z";
    listedApiKeys = [
        {
            id: "expired-key",
            name: "Expired key",
            createdAt: "2025-01-01T00:00:00.000Z",
            expiresAt: "2025-04-01T00:00:00.000Z",
            lastUsed: null,
        },
        {
            id: "soon-key",
            name: "Soon key",
            createdAt: "2026-08-01T00:00:00.000Z",
            expiresAt: expiringSoon,
            lastUsed: null,
        },
    ];

    const harness = await mountApiKeysSection();
    t.after(harness.unmount);
    const text = harness.container.textContent ?? "";

    assert.match(text, /Expires/);
    assert.match(text, /Expired/);
    assert.match(text, /Expires soon/);
    assert.match(text, new RegExp(formatDate(expiringSoon)));
});

test("shows the interactive-session message when API-key creation is forbidden", async (t) => {
    createFailure = new Error("Interactive session authentication required");
    const harness = await mountApiKeysSection();
    t.after(harness.unmount);

    await click(findButton("Generate New API Key"));
    const input = document.querySelector(
        'input[placeholder^="e.g., My Laptop"]',
    );
    assert.ok(input instanceof HTMLInputElement);
    await React.act(async () => typeInto(input, "Automation"));
    await click(findButton("Create"));

    assert.equal(createApiKey.mock.callCount(), 1);
    assert.match(
        document.body.textContent ?? "",
        /Interactive session authentication required/,
    );
});

test("shows the interactive-session message when API-key revocation is forbidden", async (t) => {
    listedApiKeys = [
        {
            id: "api-key-1",
            name: "Automation",
            createdAt: "2026-08-01T00:00:00.000Z",
            expiresAt: "2026-10-30T00:00:00.000Z",
            lastUsed: null,
        },
    ];
    revokeFailure = new Error("Interactive session authentication required");
    const harness = await mountApiKeysSection();
    t.after(harness.unmount);

    await click(findButton("Revoke"));
    await click(findLastButton("Revoke"));

    assert.equal(revokeApiKey.mock.callCount(), 1);
    assert.match(
        document.body.textContent ?? "",
        /Interactive session authentication required/,
    );
});
