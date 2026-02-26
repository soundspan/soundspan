import assert from "node:assert/strict";
import test from "node:test";
import { separateArtists } from "../../lib/separate-artists.ts";

type QueueItem = {
    id: string;
    artist: string;
};

function hasAdjacentSameArtist(items: QueueItem[]): boolean {
    for (let i = 1; i < items.length; i += 1) {
        if (items[i - 1].artist === items[i].artist) {
            return true;
        }
    }
    return false;
}

test("returns the same array for empty and single-item inputs", () => {
    const empty: QueueItem[] = [];
    const single: QueueItem[] = [{ id: "a-1", artist: "a" }];

    assert.equal(separateArtists(empty, (item) => item.artist), empty);
    assert.equal(separateArtists(single, (item) => item.artist), single);
});

test("avoids adjacent same-artist pairs when distribution allows", () => {
    const input: QueueItem[] = [
        { id: "a-1", artist: "a" },
        { id: "a-2", artist: "a" },
        { id: "b-1", artist: "b" },
        { id: "c-1", artist: "c" },
    ];

    const output = separateArtists(input, (item) => item.artist);

    assert.equal(output.length, input.length);
    assert.equal(hasAdjacentSameArtist(output), false);
    assert.deepEqual(
        output.map((item) => item.id).sort(),
        input.map((item) => item.id).sort(),
    );
});

test("preserves intra-artist ordering while interleaving buckets", () => {
    const input: QueueItem[] = [
        { id: "a-1", artist: "a" },
        { id: "a-2", artist: "a" },
        { id: "a-3", artist: "a" },
        { id: "b-1", artist: "b" },
        { id: "b-2", artist: "b" },
    ];

    const output = separateArtists(input, (item) => item.artist);

    assert.deepEqual(
        output.filter((item) => item.artist === "a").map((item) => item.id),
        ["a-1", "a-2", "a-3"],
    );
    assert.deepEqual(
        output.filter((item) => item.artist === "b").map((item) => item.id),
        ["b-1", "b-2"],
    );
});

test("retains all tracks even when perfect separation is impossible", () => {
    const input: QueueItem[] = [
        { id: "a-1", artist: "a" },
        { id: "a-2", artist: "a" },
        { id: "a-3", artist: "a" },
        { id: "b-1", artist: "b" },
    ];

    const output = separateArtists(input, (item) => item.artist);

    assert.equal(output.length, input.length);
    assert.deepEqual(
        output.map((item) => item.id).sort(),
        input.map((item) => item.id).sort(),
    );
});
