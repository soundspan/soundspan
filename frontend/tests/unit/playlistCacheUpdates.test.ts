import assert from "node:assert/strict";
import test from "node:test";
import {
    movePlaylistItemToIndexInCache,
    removePlaylistItemFromCache,
} from "../../app/playlist/[id]/playlistCacheUpdates";

const cache = () => ({
    id: "pl-1",
    name: "My Playlist",
    items: [
        { id: "item-1", trackId: "track-a" },
        { id: "item-2", trackId: "track-b" },
        { id: "item-3", trackId: "track-b" },
        { id: "item-4", trackId: null },
    ],
});

test("removes the item matching by playlist item id", () => {
    const next = removePlaylistItemFromCache(cache(), "item-2");
    assert.deepEqual(
        next?.items.map((i) => i.id),
        ["item-1", "item-3", "item-4"]
    );
});

test("falls back to removing the FIRST item matching by track id (mirrors backend)", () => {
    const next = removePlaylistItemFromCache(cache(), "track-b");
    assert.deepEqual(
        next?.items.map((i) => i.id),
        ["item-1", "item-3", "item-4"]
    );
});

test("prefers an item-id match over a track-id match", () => {
    const data = {
        items: [
            { id: "track-x", trackId: "other" },
            { id: "item-9", trackId: "track-x" },
        ],
    };
    const next = removePlaylistItemFromCache(data, "track-x");
    assert.deepEqual(
        next?.items.map((i) => i.id),
        ["item-9"]
    );
});

test("returns the input unchanged when nothing matches", () => {
    const data = cache();
    const next = removePlaylistItemFromCache(data, "missing-id");
    assert.equal(next, data);
});

test("preserves non-items fields and does not mutate the original", () => {
    const data = cache();
    const next = removePlaylistItemFromCache(data, "item-1");
    assert.equal(next?.name, "My Playlist");
    assert.equal(data.items.length, 4);
    assert.notEqual(next, data);
});

test("tolerates undefined and shapeless cache entries", () => {
    assert.equal(removePlaylistItemFromCache(undefined, "item-1"), undefined);
    const shapeless = { id: "pl-1" } as { id: string; items?: never };
    assert.equal(removePlaylistItemFromCache(shapeless, "item-1"), shapeless);
});

// ---------------------------------------------------------------------------
// movePlaylistItemToIndexInCache (GH #27 reorder)
// ---------------------------------------------------------------------------

test("moves an item up by one position", () => {
    const next = movePlaylistItemToIndexInCache(cache(), "item-3", 1);
    assert.deepEqual(
        next?.items.map((i) => i.id),
        ["item-1", "item-3", "item-2", "item-4"]
    );
});

test("moves an item down by one position", () => {
    const next = movePlaylistItemToIndexInCache(cache(), "item-1", 1);
    assert.deepEqual(
        next?.items.map((i) => i.id),
        ["item-2", "item-1", "item-3", "item-4"]
    );
});

test("moves an item to the top", () => {
    const next = movePlaylistItemToIndexInCache(cache(), "item-4", 0);
    assert.deepEqual(
        next?.items.map((i) => i.id),
        ["item-4", "item-1", "item-2", "item-3"]
    );
});

test("clamps a past-the-end target to the last position", () => {
    const next = movePlaylistItemToIndexInCache(cache(), "item-1", 99);
    assert.deepEqual(
        next?.items.map((i) => i.id),
        ["item-2", "item-3", "item-4", "item-1"]
    );
});

test("returns the same reference when the move is a no-op (same index)", () => {
    const payload = cache();
    assert.equal(movePlaylistItemToIndexInCache(payload, "item-2", 1), payload);
});

test("returns the same reference for an unknown item id", () => {
    const payload = cache();
    assert.equal(movePlaylistItemToIndexInCache(payload, "nope", 0), payload);
});

test("returns the input unchanged when the payload has no items array", () => {
    const payload = { id: "pl-1" } as { id: string; items?: { id: string }[] };
    assert.equal(movePlaylistItemToIndexInCache(payload, "item-1", 0), payload);
    assert.equal(movePlaylistItemToIndexInCache(undefined, "item-1", 0), undefined);
});
