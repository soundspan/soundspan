import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

after(async () => {
    await GlobalRegistrator.unregister();
});

const state = {
    createCalls: [] as Array<Record<string, unknown>>,
    getCalls: [] as string[],
    playCalls: 0,
    pushCalls: [] as string[],
};

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            push: (path: string) => state.pushCalls.push(path),
        }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            createRadioPlaylist: async (input: Record<string, unknown>) => {
                state.createCalls.push(input);
                return { playlistId: "generated-1", entries: [] };
            },
            get: async (path: string) => {
                state.getCalls.push(path);
                return {
                    tracks: [
                        {
                            id: "track-1",
                            title: "Track One",
                            artist: { name: "Artist" },
                            album: { title: "Album" },
                            duration: 180,
                        },
                    ],
                };
            },
        },
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: () => {
                state.playCalls += 1;
            },
        }),
    },
});

mock.module("@/components/ui/RadioStationCard", {
    namedExports: {
        RadioStationCard: ({
            station,
            onPlay,
            isLoading,
        }: {
            station: { id: string; name: string };
            onPlay: () => void;
            isLoading: boolean;
        }) =>
            React.createElement(
                "button",
                {
                    type: "button",
                    "data-station-id": station.id,
                    "data-loading": String(isLoading),
                    onClick: onPlay,
                },
                station.name,
            ),
    },
});

mock.module("lucide-react", {
    namedExports: {
        Shuffle: () => React.createElement("svg"),
    },
});

mock.module("sonner", {
    namedExports: {
        toast: {
            error: () => undefined,
            success: () => undefined,
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: () => undefined,
        },
    },
});

mock.module("@/utils/shuffle", {
    namedExports: {
        shuffleArray: <T>(values: T[]) => values,
    },
});

beforeEach(() => {
    state.createCalls.length = 0;
    state.getCalls.length = 0;
    state.playCalls = 0;
    state.pushCalls.length = 0;
});

async function renderStations(
    t: { after: (fn: () => Promise<void> | void) => void },
    stations: Array<Record<string, unknown>>,
) {
    const { createRoot } = await import("react-dom/client");
    const { LibraryRadioStations } =
        await import("../../features/home/components/LibraryRadioStations");
    const container = document.createElement("div");
    const root = createRoot(container);
    t.after(async () => {
        await React.act(async () => root.unmount());
    });
    await React.act(async () => {
        root.render(
            React.createElement(LibraryRadioStations, {
                stations,
                externalLoading: false,
            } as never),
        );
    });
    return container;
}

test("genre tiles generate a playlist and navigate without starting playback", async (t) => {
    const container = await renderStations(t, [
        {
            id: "genre-rock",
            name: "Rock",
            description: "30 tracks",
            color: "from-red-500/50 to-orange-600/40",
            filter: { type: "genre", value: "rock" },
            minTracks: 15,
        },
    ]);
    const tile = container.querySelector("[data-station-id='genre-rock']");
    assert.ok(tile);

    await React.act(async () => {
        tile.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    assert.deepEqual(state.createCalls, [
        { filter: { type: "genre", value: "rock" } },
    ]);
    assert.deepEqual(state.pushCalls, ["/playlist/generated-1"]);
    assert.equal(state.playCalls, 0);
    assert.deepEqual(state.getCalls, []);
});

test("Shuffle All keeps instant-play behavior", async (t) => {
    const container = await renderStations(t, [
        {
            id: "all",
            name: "Shuffle All",
            description: "Your entire library",
            color: "from-brand/60 to-amber-600/40",
            filter: { type: "all" },
            minTracks: 1,
        },
    ]);
    const tile = container.querySelector("[data-station-id='all']");
    assert.ok(tile);

    await React.act(async () => {
        tile.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    assert.equal(state.createCalls.length, 0);
    assert.equal(state.pushCalls.length, 0);
    assert.equal(state.playCalls, 1);
    assert.match(state.getCalls[0] ?? "", /^\/library\/radio\?/);
});
