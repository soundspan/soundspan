import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ModalProps } from "../../components/ui/Modal";

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

const Icon = (props: Record<string, unknown>) => React.createElement("i", props);

mock.module("lucide-react", {
    namedExports: { X: Icon },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // best-effort teardown
    }
});

async function mountModal(onClose: () => void = () => undefined) {
    const { createRoot } = await import("react-dom/client");
    const { Modal } = await import("../../components/ui/Modal");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const render = async (isOpen: boolean) => {
        await React.act(async () => {
            root.render(
                React.createElement(
                    Modal,
                    {
                        isOpen,
                        onClose,
                        title: "Accessible modal",
                    } as ModalProps, // children is supplied via createElement's third argument, so this is sound at runtime.
                    React.createElement("button", null, "Modal action"),
                ),
            );
        });
    };
    await render(true);

    return { container, render, root };
}

async function unmountModal(mounted: Awaited<ReturnType<typeof mountModal>>) {
    await React.act(async () => {
        mounted.root.unmount();
    });
    mounted.container.remove();
}

test("Modal exposes labelled modal dialog semantics", async () => {
    const mounted = await mountModal();
    const dialog = mounted.container.querySelector('[role="dialog"]');
    assert.ok(dialog, "expected a dialog panel");
    assert.equal(dialog.getAttribute("aria-modal"), "true");

    const titleId = dialog.getAttribute("aria-labelledby");
    assert.ok(titleId, "expected the dialog to reference its title");
    const title = mounted.container.querySelector(`h2[id="${titleId}"]`);
    assert.equal(title?.textContent, "Accessible modal");
    assert.ok(
        mounted.container.querySelector('button[aria-label="Close"]'),
        "expected an accessible close button name",
    );

    await unmountModal(mounted);
});

test("Modal moves initial focus inside the dialog", async () => {
    const mounted = await mountModal();
    const dialog = mounted.container.querySelector('[role="dialog"]');
    assert.ok(dialog, "expected a dialog panel");
    assert.ok(dialog.contains(document.activeElement));
    await unmountModal(mounted);
});

test("Modal closes when Escape is pressed", async () => {
    let closeCalls = 0;
    const mounted = await mountModal(() => {
        closeCalls += 1;
    });

    await React.act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    assert.equal(closeCalls, 1);
    await unmountModal(mounted);
});

test("Modal restores focus when it closes", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const mounted = await mountModal();

    await mounted.render(false);

    assert.equal(document.activeElement, trigger);
    await unmountModal(mounted);
    trigger.remove();
});
