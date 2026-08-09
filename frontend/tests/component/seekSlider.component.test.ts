import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

mock.module("@/utils/formatTime", {
    namedExports: {
        formatTime: (seconds: number) => {
            const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
            const minutes = Math.floor(safeSeconds / 60);
            const remainder = Math.floor(safeSeconds % 60);
            return `${minutes}:${remainder.toString().padStart(2, "0")}`;
        },
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // best-effort teardown
    }
});

async function mountSeekSlider(overrides: Record<string, unknown> = {}) {
    const { createRoot } = await import("react-dom/client");
    const { SeekSlider } = await import("../../components/player/SeekSlider");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const props = {
        progress: 15,
        duration: 200,
        currentTime: 30,
        onSeek: () => undefined,
        canSeek: true,
        hasMedia: true,
        ...overrides,
    };
    await React.act(async () => {
        root.render(React.createElement(SeekSlider, props));
    });
    return { container, root };
}

async function unmount(mounted: Awaited<ReturnType<typeof mountSeekSlider>>) {
    await React.act(async () => {
        mounted.root.unmount();
    });
    mounted.container.remove();
}

test("renders slider semantics and current value when seeking is enabled", async () => {
    const mounted = await mountSeekSlider();
    const slider = mounted.container.querySelector('[role="slider"]');

    assert.ok(slider, "expected an element with slider semantics");
    assert.equal(slider.getAttribute("aria-valuemin"), "0");
    assert.equal(slider.getAttribute("aria-valuemax"), "200");
    assert.equal(slider.getAttribute("aria-valuenow"), "30");
    assert.equal(slider.getAttribute("aria-label"), "Seek");
    assert.equal((slider as HTMLElement).tabIndex, 0);

    await unmount(mounted);
});

test("slider keyboard commands seek relative to the current time", async () => {
    const seekCalls: number[] = [];
    const mounted = await mountSeekSlider({
        onSeek: (time: number) => seekCalls.push(time),
    });
    const slider = mounted.container.querySelector('[role="slider"]') as HTMLElement | null;
    assert.ok(slider, "expected an element with slider semantics");

    slider.focus();
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
        await React.act(async () => {
            slider.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        });
    }

    assert.deepEqual(seekCalls, [35, 25, 0, 200]);
    await unmount(mounted);
});

test("disabled slider is removed from tab order and ignores seek keys", async () => {
    const seekCalls: number[] = [];
    const mounted = await mountSeekSlider({
        canSeek: false,
        onSeek: (time: number) => seekCalls.push(time),
    });
    const slider = mounted.container.querySelector('[role="slider"]') as HTMLElement | null;
    assert.ok(slider, "expected an element with slider semantics");
    assert.equal(slider.tabIndex, -1);

    await React.act(async () => {
        slider.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        );
    });

    assert.deepEqual(seekCalls, []);
    await unmount(mounted);
});
