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
    openCalls: [] as Array<{ id: string; filter: Record<string, unknown> }>,
};

// The station open flow is covered by the openRadioStation suite and the
// station builders by the radioPageStations suite; this file pins the /radio
// PAGE wiring: every card's onPlay routes through the shared helper with the
// station's filter intact.
mock.module("@/lib/radio/openRadioStation", {
    namedExports: {
        openRadioStation: async (station: {
            id: string;
            filter: Record<string, unknown>;
        }) => {
            state.openCalls.push({ id: station.id, filter: station.filter });
        },
    },
});

mock.module("@/lib/radio/radioPageStations", {
    namedExports: {
        useRadioPageStations: () => ({
            genreStations: [
                {
                    id: "genre-Rock",
                    name: "Rock",
                    description: "30 tracks",
                    color: "from-red-500/30 to-orange-600/30",
                    filter: { type: "genre", value: "Rock" },
                    minTracks: 15,
                },
            ],
            decadeStations: [
                {
                    id: "decade-1990",
                    name: "90s",
                    description: "1990-1999 • 40 tracks",
                    color: "from-purple-500/30 to-violet-600/30",
                    filter: { type: "decade", value: "1990" },
                    minTracks: 15,
                },
            ],
            isLoading: false,
        }),
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: () => undefined,
        }),
    },
});

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            push: () => undefined,
        }),
    },
});

mock.module("@/components/ui/RadioStationCard", {
    namedExports: {
        RadioStationCard: ({
            station,
            onPlay,
        }: {
            station: { id: string; name: string };
            onPlay: () => void;
        }) =>
            React.createElement(
                "button",
                {
                    type: "button",
                    "data-station-id": station.id,
                    onClick: onPlay,
                },
                station.name,
            ),
    },
});

mock.module("@/components/layout/PageHeader", {
    namedExports: {
        PageHeader: ({ title }: { title: string }) =>
            React.createElement("div", null, title),
    },
});

mock.module("lucide-react", {
    namedExports: {
        AudioLines: () => React.createElement("svg"),
    },
});

beforeEach(() => {
    state.openCalls.length = 0;
});

async function renderRadioPage(t: {
    after: (fn: () => Promise<void> | void) => void;
}) {
    const { createRoot } = await import("react-dom/client");
    const RadioPage = (await import("../../app/radio/page")).default;
    const container = document.createElement("div");
    const root = createRoot(container);
    t.after(async () => {
        await React.act(async () => root.unmount());
    });
    await React.act(async () => {
        root.render(React.createElement(RadioPage));
    });
    return container;
}

async function clickStation(container: Element, stationId: string) {
    const tile = container.querySelector(`[data-station-id='${stationId}']`);
    assert.ok(tile, `station tile ${stationId} is rendered`);
    await React.act(async () => {
        tile.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
}

test("static and dynamic cards route through the shared open helper", async (t) => {
    const container = await renderRadioPage(t);

    await clickStation(container, "workout");
    await clickStation(container, "genre-Rock");
    await clickStation(container, "decade-1990");
    await clickStation(container, "all");

    assert.deepEqual(state.openCalls, [
        { id: "workout", filter: { type: "workout" } },
        { id: "genre-Rock", filter: { type: "genre", value: "Rock" } },
        { id: "decade-1990", filter: { type: "decade", value: "1990" } },
        { id: "all", filter: { type: "all" } },
    ]);
});
