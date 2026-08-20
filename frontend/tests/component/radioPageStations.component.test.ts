import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module("@tanstack/react-query", {
    namedExports: {
        useQuery: () => ({ data: undefined, isLoading: true }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: { get: async () => ({}) },
    },
});

async function loadBuilders() {
    const mod = await import("../../lib/radio/radioPageStations");
    const named =
        mod as unknown as typeof import("../../lib/radio/radioPageStations");
    const cjsDefault = (
        mod as {
            default?: typeof import("../../lib/radio/radioPageStations");
        }
    ).default;
    const buildGenreStations =
        named.buildGenreStations ?? cjsDefault?.buildGenreStations;
    const buildDecadeStations =
        named.buildDecadeStations ?? cjsDefault?.buildDecadeStations;
    assert.ok(buildGenreStations, "buildGenreStations export is available");
    assert.ok(buildDecadeStations, "buildDecadeStations export is available");
    return { buildGenreStations, buildDecadeStations };
}

test("genre stations skip sparse genres and carry playlist filters", async () => {
    const { buildGenreStations } = await loadBuilders();
    const stations = buildGenreStations([
        { genre: "Rock", count: 30 },
        { genre: "Ambient", count: 4 },
    ]);

    assert.deepEqual(
        stations.map((s) => ({ id: s.id, filter: s.filter })),
        [{ id: "genre-Rock", filter: { type: "genre", value: "Rock" } }],
    );
});

test("decade stations drop values the generated-playlist API rejects", async () => {
    const { buildDecadeStations } = await loadBuilders();
    const stations = buildDecadeStations([
        { decade: 1990, count: 40 },
        { decade: 2100, count: 16 },
        { decade: 990, count: 12 },
        { decade: 1995, count: 9 },
    ]);

    assert.deepEqual(
        stations.map((s) => ({ id: s.id, filter: s.filter })),
        [{ id: "decade-1990", filter: { type: "decade", value: "1990" } }],
    );
});
