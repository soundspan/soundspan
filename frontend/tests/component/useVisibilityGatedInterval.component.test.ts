import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
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

async function mountHook(
    callback: () => void,
    options?: { enabled?: boolean; leadingOnVisible?: boolean }
) {
    const { useVisibilityGatedInterval } = await import(
        "../../hooks/useVisibilityGatedInterval"
    );
    const { createRoot } = await import("react-dom/client");

    function Probe({ onTick }: { onTick: () => void }) {
        useVisibilityGatedInterval(onTick, 1_000, options);
        return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () =>
        root.render(React.createElement(Probe, { onTick: callback }))
    );

    return {
        rerender: async (onTick: () => void) => {
            await React.act(async () =>
                root.render(React.createElement(Probe, { onTick }))
            );
        },
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

test("ticks at the configured interval while visible", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let calls = 0;
    const harness = await mountHook(() => {
        calls += 1;
    });
    t.after(harness.unmount);

    t.mock.timers.tick(2_000);

    assert.equal(calls, 2);
});

test("does not tick while hidden", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    setVisibility("hidden");
    let calls = 0;
    const harness = await mountHook(() => {
        calls += 1;
    });
    t.after(harness.unmount);

    t.mock.timers.tick(10_000);

    assert.equal(calls, 0);
});

test("fires once on return to visibility and resumes the interval", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let calls = 0;
    const harness = await mountHook(() => {
        calls += 1;
    });
    t.after(harness.unmount);

    await changeVisibility("hidden");
    t.mock.timers.tick(10_000);
    await changeVisibility("visible");
    assert.equal(calls, 1);

    t.mock.timers.tick(1_000);
    assert.equal(calls, 2);
});

test("does not fire a leading call on first mount", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let calls = 0;
    const harness = await mountHook(() => {
        calls += 1;
    });
    t.after(harness.unmount);

    assert.equal(calls, 0);
});

test("does not tick when disabled", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let calls = 0;
    const harness = await mountHook(
        () => {
            calls += 1;
        },
        { enabled: false }
    );
    t.after(harness.unmount);

    t.mock.timers.tick(10_000);

    assert.equal(calls, 0);
});

test("cleans up the interval on unmount", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let calls = 0;
    const harness = await mountHook(() => {
        calls += 1;
    });

    await harness.unmount();
    t.mock.timers.tick(10_000);

    assert.equal(calls, 0);
});

test("uses the latest callback after rerender", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let firstCalls = 0;
    let secondCalls = 0;
    const harness = await mountHook(() => {
        firstCalls += 1;
    });
    t.after(harness.unmount);

    await harness.rerender(() => {
        secondCalls += 1;
    });
    t.mock.timers.tick(1_000);

    assert.equal(firstCalls, 0);
    assert.equal(secondCalls, 1);
});
