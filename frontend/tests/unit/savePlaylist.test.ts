import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

/**
 * `@/lib/api` is mocked once at module scope (node:test's mock.module + a
 * dynamic re-import both only take effect the first time a given specifier is
 * resolved), so each mocked method here is a stable wrapper that delegates to
 * a per-test-mutable `state` object — the same indirection pattern used by
 * the component tests (e.g. playlistRename.component.test.ts) for api calls
 * whose behaviour needs to vary test-to-test.
 */

const state: {
    createImpl: (name: string) => Promise<{ id: string }>;
    addImpl: (playlistId: string, ref: unknown) => Promise<unknown>;
} = {
    createImpl: async () => ({ id: "pl1" }),
    addImpl: async () => ({}),
};

mock.module("@/lib/api", {
    namedExports: {
        api: {
            createPlaylist: (name: string) => state.createImpl(name),
            addTrackToPlaylist: (playlistId: string, ref: unknown) =>
                state.addImpl(playlistId, ref),
        },
    },
});

beforeEach(() => {
    state.createImpl = async () => ({ id: "pl1" });
    state.addImpl = async () => ({});
});

test("saveTracksAsPlaylist creates the playlist then adds tracks sequentially, in order", async () => {
    const calls: string[] = [];
    state.createImpl = async (name) => {
        calls.push(`create:${name}`);
        return { id: "pl-seq" };
    };
    state.addImpl = async (playlistId, ref) => {
        calls.push(`add:${playlistId}:${(ref as { trackId: string }).trackId}`);
        return {};
    };
    const { saveTracksAsPlaylist } = await import(
        "../../components/vibe/savePlaylist"
    );

    const result = await saveTracksAsPlaylist("My Journey", ["t1", "t2", "t3"]);

    assert.deepEqual(calls, [
        "create:My Journey",
        "add:pl-seq:t1",
        "add:pl-seq:t2",
        "add:pl-seq:t3",
    ]);
    assert.deepEqual(result, { id: "pl-seq", added: 3 });
});

test("saveTracksAsPlaylist dedupes track ids, preserving first occurrence order", async () => {
    const added: string[] = [];
    state.createImpl = async () => ({ id: "pl-dedupe" });
    state.addImpl = async (_playlistId, ref) => {
        added.push((ref as { trackId: string }).trackId);
        return {};
    };
    const { saveTracksAsPlaylist } = await import(
        "../../components/vibe/savePlaylist"
    );

    const result = await saveTracksAsPlaylist("Dupes", ["a", "b", "a", "c", "b"]);

    assert.deepEqual(added, ["a", "b", "c"]);
    assert.equal(result.added, 3);
});

test("saveTracksAsPlaylist tolerates individual add failures and counts only successes", async () => {
    state.createImpl = async () => ({ id: "pl-partial" });
    state.addImpl = async (_playlistId, ref) => {
        if ((ref as { trackId: string }).trackId === "bad") {
            throw new Error("boom");
        }
        return {};
    };
    const { saveTracksAsPlaylist } = await import(
        "../../components/vibe/savePlaylist"
    );

    const result = await saveTracksAsPlaylist("Partial", [
        "good1",
        "bad",
        "good2",
    ]);

    assert.deepEqual(result, { id: "pl-partial", added: 2 });
});

test("saveTracksAsPlaylist with an empty track list still creates the playlist with 0 added", async () => {
    let created = false;
    state.createImpl = async () => {
        created = true;
        return { id: "pl-empty" };
    };
    state.addImpl = async () => {
        throw new Error("should not be called");
    };
    const { saveTracksAsPlaylist } = await import(
        "../../components/vibe/savePlaylist"
    );

    const result = await saveTracksAsPlaylist("Empty", []);

    assert.equal(created, true);
    assert.deepEqual(result, { id: "pl-empty", added: 0 });
});

test("formatPlaylistDate renders 'MMM D' (e.g. Jul 15)", async () => {
    const { formatPlaylistDate } = await import(
        "../../components/vibe/savePlaylist"
    );
    // Local-time construction avoids UTC-offset day-boundary flakiness.
    const d = new Date(2026, 6, 15, 12, 0, 0); // July 15 2026, noon local
    assert.equal(formatPlaylistDate(d), "Jul 15");
});

test("formatPlaylistDate does not zero-pad the day", async () => {
    const { formatPlaylistDate } = await import(
        "../../components/vibe/savePlaylist"
    );
    const d = new Date(2026, 0, 5, 12, 0, 0); // January 5
    assert.equal(formatPlaylistDate(d), "Jan 5");
});
