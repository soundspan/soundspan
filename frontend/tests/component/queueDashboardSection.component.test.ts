import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Behaviour tests for the admin Queue Dashboard section: opening asks the
 * server for the dashboard cookie and then opens the dashboard path in an
 * opener-less tab; a failed request never opens a tab and says so; ending
 * access calls the server. `@/lib/api` is the boundary mock and window.open
 * is stubbed so no tab is really opened.
 */

GlobalRegistrator.register({ url: "http://localhost/admin" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let createFailure: Error | null = null;
const createQueueDashboardSession = mock.fn(async () => {
    if (createFailure) throw createFailure;
});
const closeQueueDashboardSession = mock.fn(async () => undefined);
const opened: Array<[string, string, string]> = [];

mock.module("@/lib/api", {
    namedExports: {
        api: { createQueueDashboardSession, closeQueueDashboardSession },
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
    createFailure = null;
    opened.length = 0;
    createQueueDashboardSession.mock.resetCalls();
    closeQueueDashboardSession.mock.resetCalls();
    Object.defineProperty(window, "open", {
        configurable: true,
        writable: true,
        value: (url: string, target: string, features: string) => {
            opened.push([url, target, features]);
            return null;
        },
    });
    document.body.replaceChildren();
});

async function flush(): Promise<void> {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

async function mountSection() {
    const { QueueDashboardSection } =
        await import("../../features/settings/components/sections/QueueDashboardSection");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(React.createElement(QueueDashboardSection));
        await flush();
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

async function click(button: HTMLButtonElement): Promise<void> {
    await React.act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flush();
    });
}

test("opening mints the session and then opens the dashboard in a new tab", async (t) => {
    const harness = await mountSection();
    t.after(harness.unmount);

    await click(findButton("Open queue dashboard"));

    assert.equal(createQueueDashboardSession.mock.callCount(), 1);
    assert.deepEqual(opened, [
        ["/api/admin/queues", "_blank", "noopener,noreferrer"],
    ]);
    assert.match(
        harness.container.textContent ?? "",
        /Dashboard opened in a new tab/,
    );
});

test("a failed session request opens nothing and reports the error", async (t) => {
    createFailure = new Error("forbidden");
    const harness = await mountSection();
    t.after(harness.unmount);

    await click(findButton("Open queue dashboard"));

    assert.equal(opened.length, 0);
    assert.match(
        harness.container.textContent ?? "",
        /Couldn't open the dashboard/,
    );
});

test("ending access calls the server and confirms", async (t) => {
    const harness = await mountSection();
    t.after(harness.unmount);

    await click(findButton("End dashboard access"));

    assert.equal(closeQueueDashboardSession.mock.callCount(), 1);
    assert.match(harness.container.textContent ?? "", /access ended/);
});

test("explains the 15-minute window before anything is opened", async (t) => {
    const harness = await mountSection();
    t.after(harness.unmount);
    assert.match(harness.container.textContent ?? "", /15 minutes/);
});
