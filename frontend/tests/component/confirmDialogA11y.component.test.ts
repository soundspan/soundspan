import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

const Icon = (props: Record<string, unknown>) => React.createElement("i", props);

mock.module("lucide-react", {
    namedExports: { AlertTriangle: Icon, X: Icon },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // best-effort teardown
    }
});

async function mountConfirmDialog(onConfirm: () => void, onClose: () => void) {
    const { createRoot } = await import("react-dom/client");
    const { ConfirmDialog } = await import("../../components/ui/ConfirmDialog");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(ConfirmDialog, {
                isOpen: true,
                onClose,
                onConfirm,
                title: "Delete playlist?",
                message: "This action cannot be undone.",
                confirmText: "Delete",
                cancelText: "Keep playlist",
            }),
        );
    });

    return { container, root };
}

async function unmountDialog(
    mounted: Awaited<ReturnType<typeof mountConfirmDialog>>,
) {
    await React.act(async () => {
        mounted.root.unmount();
    });
    mounted.container.remove();
}

test("ConfirmDialog renders its content and actions in a dialog", async () => {
    const mounted = await mountConfirmDialog(() => undefined, () => undefined);
    assert.ok(mounted.container.querySelector('[role="dialog"]'));
    assert.match(mounted.container.textContent, /Delete playlist\?/);
    assert.match(mounted.container.textContent, /This action cannot be undone\./);

    const labels = Array.from(mounted.container.querySelectorAll("button"), (button) =>
        button.textContent?.trim(),
    );
    assert.ok(labels.includes("Keep playlist"));
    assert.ok(labels.includes("Delete"));
    await unmountDialog(mounted);
});

test("ConfirmDialog confirms once and closes once", async () => {
    let confirmCalls = 0;
    let closeCalls = 0;
    const mounted = await mountConfirmDialog(
        () => {
            confirmCalls += 1;
        },
        () => {
            closeCalls += 1;
        },
    );
    const confirmButton = Array.from(
        mounted.container.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "Delete");
    assert.ok(confirmButton, "expected the confirm button");

    await React.act(async () => {
        confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    assert.equal(confirmCalls, 1);
    assert.equal(closeCalls, 1);
    await unmountDialog(mounted);
});
