import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

/**
 * `@/lib/api` is mocked once at module scope (node:test's mock.module + a
 * dynamic re-import both only take effect the first time a given specifier is
 * resolved), so each mocked method here is a stable wrapper that delegates to
 * a per-test-mutable `state` object — the same indirection pattern used by
 * the component tests (e.g. playlistRename.component.test.ts) for api calls
 * whose behaviour needs to vary test-to-test. `@/lib/logger` is mocked the
 * same way so partial-save observability (the logged warnings) is assertable.
 */

const state: {
    createImpl: (name: string) => Promise<{ id: string }>;
    addImpl: (playlistId: string, ref: unknown) => Promise<unknown>;
} = {
    createImpl: async () => ({ id: "pl1" }),
    addImpl: async () => ({}),
};

const warnCalls: Array<{ message: string; context: unknown }> = [];

const stubLogger = {
    debug: () => {},
    info: () => {},
    warn: (message: string, context: unknown) => {
        warnCalls.push({ message, context });
    },
    error: () => {},
    child: () => stubLogger,
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

mock.module("@/lib/logger", {
    namedExports: {
        createFrontendLogger: () => stubLogger,
    },
});

beforeEach(() => {
    state.createImpl = async () => ({ id: "pl1" });
    state.addImpl = async () => ({});
    warnCalls.length = 0;
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
    const { saveTracksAsPlaylist } =
        await import("../../components/vibe/savePlaylist");

    const result = await saveTracksAsPlaylist("My Journey", ["t1", "t2", "t3"]);

    assert.deepEqual(calls, [
        "create:My Journey",
        "add:pl-seq:t1",
        "add:pl-seq:t2",
        "add:pl-seq:t3",
    ]);
    assert.deepEqual(result, { id: "pl-seq", added: 3, failedTrackIds: [] });
    assert.equal(warnCalls.length, 0);
});

test("saveTracksAsPlaylist dedupes track ids, preserving first occurrence order", async () => {
    const added: string[] = [];
    state.createImpl = async () => ({ id: "pl-dedupe" });
    state.addImpl = async (_playlistId, ref) => {
        added.push((ref as { trackId: string }).trackId);
        return {};
    };
    const { saveTracksAsPlaylist } =
        await import("../../components/vibe/savePlaylist");

    const result = await saveTracksAsPlaylist("Dupes", [
        "a",
        "b",
        "a",
        "c",
        "b",
    ]);

    assert.deepEqual(added, ["a", "b", "c"]);
    assert.equal(result.added, 3);
    assert.deepEqual(result.failedTrackIds, []);
});

test("a partial save returns the failed ids and logs each failure", async () => {
    state.createImpl = async () => ({ id: "pl-partial" });
    state.addImpl = async (_playlistId, ref) => {
        const trackId = (ref as { trackId: string }).trackId;
        if (trackId === "bad-1" || trackId === "bad-2") {
            throw new Error(`no such track: ${trackId}`);
        }
        return {};
    };
    const { saveTracksAsPlaylist } =
        await import("../../components/vibe/savePlaylist");

    const result = await saveTracksAsPlaylist("Partial", [
        "good1",
        "bad-1",
        "good2",
        "bad-2",
    ]);

    // The failures are in the RESULT — a caller can never mistake this for a
    // full save.
    assert.deepEqual(result, {
        id: "pl-partial",
        added: 2,
        failedTrackIds: ["bad-1", "bad-2"],
    });

    // And they were logged through the shared frontend logger: one warning
    // per failed add plus one partial-save summary.
    assert.equal(warnCalls.length, 3);
    const perTrack = warnCalls.filter(
        (c) => c.message === "Failed to add track to playlist",
    );
    assert.deepEqual(
        perTrack.map((c) => (c.context as { trackId: string }).trackId),
        ["bad-1", "bad-2"],
    );
    const summary = warnCalls.find(
        (c) => c.message === "Playlist saved partially",
    );
    assert.ok(summary);
    assert.deepEqual(summary.context, {
        playlistId: "pl-partial",
        playlistName: "Partial",
        added: 2,
        failed: 2,
    });
});

test("a fully-failed save still resolves, reporting every id as failed", async () => {
    state.createImpl = async () => ({ id: "pl-doomed" });
    state.addImpl = async () => {
        throw new Error("db down");
    };
    const { saveTracksAsPlaylist } =
        await import("../../components/vibe/savePlaylist");

    const result = await saveTracksAsPlaylist("Doomed", ["a", "b"]);

    assert.deepEqual(result, {
        id: "pl-doomed",
        added: 0,
        failedTrackIds: ["a", "b"],
    });
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
    const { saveTracksAsPlaylist } =
        await import("../../components/vibe/savePlaylist");

    const result = await saveTracksAsPlaylist("Empty", []);

    assert.equal(created, true);
    assert.deepEqual(result, { id: "pl-empty", added: 0, failedTrackIds: [] });
});

test("describeSaveResult: a full save reads as success", async () => {
    const { describeSaveResult } =
        await import("../../components/vibe/savePlaylist");
    assert.deepEqual(
        describeSaveResult("Mix", { id: "p", added: 5, failedTrackIds: [] }),
        { tone: "success", message: "Saved 5 tracks to Mix" },
    );
    assert.deepEqual(
        describeSaveResult("Mix", { id: "p", added: 1, failedTrackIds: [] }),
        { tone: "success", message: "Saved 1 track to Mix" },
    );
});

test("describeSaveResult: a partial save is a warning naming the miss count", async () => {
    const { describeSaveResult } =
        await import("../../components/vibe/savePlaylist");
    assert.deepEqual(
        describeSaveResult("Mix", {
            id: "p",
            added: 3,
            failedTrackIds: ["x"],
        }),
        {
            tone: "warning",
            message: "Saved 3 of 4 tracks to Mix — 1 track couldn't be added",
        },
    );
    assert.equal(
        describeSaveResult("Mix", {
            id: "p",
            added: 0,
            failedTrackIds: ["x", "y"],
        }).tone,
        "warning",
    );
});

test("formatPlaylistDate renders 'MMM D' (e.g. Jul 15)", async () => {
    const { formatPlaylistDate } =
        await import("../../components/vibe/savePlaylist");
    // Local-time construction avoids UTC-offset day-boundary flakiness.
    const d = new Date(2026, 6, 15, 12, 0, 0); // July 15 2026, noon local
    assert.equal(formatPlaylistDate(d), "Jul 15");
});

test("formatPlaylistDate does not zero-pad the day", async () => {
    const { formatPlaylistDate } =
        await import("../../components/vibe/savePlaylist");
    const d = new Date(2026, 0, 5, 12, 0, 0); // January 5
    assert.equal(formatPlaylistDate(d), "Jan 5");
});
