import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const Icon = () => React.createElement("i");

mock.module("lucide-react", {
    namedExports: { AlertTriangle: Icon, X: Icon },
});

after(() => {
    GlobalRegistrator.unregister();
});

async function mountNotice(onRetry: () => Promise<void>) {
    const { ExploreDegradedNotice } =
        await import("../../features/explore/components/ExploreDegradedNotice");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const root = createRoot(container);

    await React.act(async () => {
        root.render(React.createElement(ExploreDegradedNotice, { onRetry }));
    });

    return {
        container,
        unmount: async () => {
            await React.act(async () => root.unmount());
        },
    };
}

test("offers retry and can be dismissed", async (testContext) => {
    const onRetry = testContext.mock.fn(async () => undefined);
    const harness = await mountNotice(onRetry);
    testContext.after(harness.unmount);

    assert.match(
        harness.container.textContent ?? "",
        /Some sections failed to load — Retry/,
    );
    const retry = Array.from(harness.container.querySelectorAll("button")).find(
        (button) => button.textContent === "Retry",
    );
    assert.ok(retry);
    await React.act(async () => retry.click());
    assert.equal(onRetry.mock.callCount(), 1);

    const dismiss = harness.container.querySelector(
        'button[aria-label="Dismiss degraded results notice"]',
    );
    assert.ok(dismiss instanceof HTMLButtonElement);
    await React.act(async () => dismiss.click());
    assert.equal(harness.container.textContent, "");
});
