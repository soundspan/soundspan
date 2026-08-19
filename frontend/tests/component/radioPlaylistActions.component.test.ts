import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

after(async () => {
    await GlobalRegistrator.unregister();
});

mock.module("lucide-react", {
    namedExports: {
        ListPlus: () => React.createElement("svg"),
        RefreshCw: () => React.createElement("svg"),
        Loader2: () => React.createElement("svg"),
    },
});

const calls: string[] = [];

mock.module("@/lib/api", {
    namedExports: {
        api: {
            appendRadioPlaylist: async (playlistId: string) => {
                calls.push(`append:${playlistId}`);
                return { playlistId, entries: [{ id: "track-1" }] };
            },
            regenerateRadioPlaylist: async (playlistId: string) => {
                calls.push(`regenerate:${playlistId}`);
                return { playlistId, entries: [{ id: "track-2" }] };
            },
        },
    },
});

mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                error: () => undefined,
                info: () => undefined,
                success: () => undefined,
            },
        }),
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: { error: () => undefined },
    },
});

test("generated playlist buttons dispatch append and regenerate API calls", async (t) => {
    const { createRoot } = await import("react-dom/client");
    const { RadioPlaylistActions } =
        await import("../../app/playlist/[id]/RadioPlaylistActions");
    calls.length = 0;
    const container = document.createElement("div");
    const root = createRoot(container);
    const queryClient = new QueryClient();
    t.after(async () => {
        await React.act(async () => root.unmount());
    });

    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(RadioPlaylistActions, {
                    enabled: true,
                    playlistId: "playlist-1",
                }),
            ),
        );
    });

    const addMore = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Add more tracks"),
    );
    const regenerate = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Regenerate"),
    );
    assert.ok(addMore);
    assert.ok(regenerate);

    await React.act(async () => {
        addMore.dispatchEvent(
            new window.MouseEvent("click", { bubbles: true }),
        );
        regenerate.dispatchEvent(
            new window.MouseEvent("click", { bubbles: true }),
        );
    });

    assert.deepEqual(calls, ["append:playlist-1", "regenerate:playlist-1"]);
});
