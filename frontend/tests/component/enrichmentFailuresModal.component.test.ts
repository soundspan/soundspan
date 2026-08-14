import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const retryFailedAudioAnalysis = mock.fn(async () => ({
    message: "reset",
    reset: 7226,
}));
const retryVibeEmbeddings = mock.fn(async () => ({
    message: "reset",
    reset: 1204,
}));

mock.module("@/lib/enrichmentApi", {
    namedExports: {
        enrichmentApi: {
            getFailures: async () => ({ failures: [], total: 0 }),
            getFailureCounts: async () => ({
                artist: 0,
                track: 0,
                audio: 7226,
                vibe: 1204,
                total: 8430,
            }),
            retryFailures: async () => ({ message: "", queued: 0 }),
            skipFailures: async () => ({ message: "", count: 0 }),
            deleteFailure: async () => ({ message: "", count: 0 }),
            clearAllFailures: async () => ({ message: "", count: 0 }),
            retryFailedAudioAnalysis,
            retryVibeEmbeddings,
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
    retryFailedAudioAnalysis.mock.resetCalls();
    retryVibeEmbeddings.mock.resetCalls();
    document.body.replaceChildren();
});

async function mountModal() {
    const { EnrichmentFailuresModal } =
        await import("../../components/EnrichmentFailuresModal");
    const { createRoot } = await import("react-dom/client");
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["enrichment-failure-counts"], {
        artist: 0,
        track: 0,
        audio: 7226,
        vibe: 1204,
        total: 8430,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(EnrichmentFailuresModal, {
                    isOpen: true,
                    onClose: () => undefined,
                }),
            ),
        );
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 10));
    });
    return {
        container,
        unmount: async () => React.act(async () => root.unmount()),
    };
}

function buttonWithText(text: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) =>
            candidate.textContent?.replace(/\s+/g, " ").trim() === text,
    );
    const labels = Array.from(document.querySelectorAll("button")).map(
        (candidate) => candidate.textContent?.replace(/\s+/g, " ").trim(),
    );
    assert.ok(
        button instanceof HTMLButtonElement,
        `Missing ${text} button; found ${labels.join(", ")}`,
    );
    return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
    await React.act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
    });
}

test("retries every audio failure instead of only the visible page", async (t) => {
    const harness = await mountModal();
    t.after(harness.unmount);
    await click(buttonWithText("Audio Analysis (7226)"));
    await click(buttonWithText("Retry all 7226"));
    assert.match(document.body.textContent ?? "", /bounded background queue/i);
    await click(buttonWithText("Retry all"));
    assert.equal(retryFailedAudioAnalysis.mock.callCount(), 1);

    await click(buttonWithText("Vibe Embeddings (1204)"));
    await click(buttonWithText("Retry all 1204"));
    await click(buttonWithText("Retry all"));
    assert.equal(retryVibeEmbeddings.mock.callCount(), 1);
});
