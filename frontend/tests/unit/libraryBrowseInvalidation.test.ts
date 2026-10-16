import assert from "node:assert/strict";
import test from "node:test";
import { invalidateLibraryAfterRemoteLike } from "../../lib/libraryBrowseInvalidation";

function fakeClient() {
    const keys: unknown[][] = [];
    return {
        keys,
        invalidateQueries: (filters: { queryKey: readonly unknown[] }) => {
            keys.push([...filters.queryKey]);
        },
    };
}

test("remote likes refresh the three Library lists", () => {
    const client = fakeClient();
    assert.equal(invalidateLibraryAfterRemoteLike(client, ["tidal:42"]), true);
    assert.deepEqual(client.keys, [
        ["library", "artists"],
        ["library", "albums"],
        ["library", "tracks"],
    ]);
});

test("a batch with any remote id refreshes once", () => {
    const client = fakeClient();
    invalidateLibraryAfterRemoteLike(client, ["local-1", "yt:abc", "tidal:1"]);
    assert.equal(client.keys.length, 3);
});

test("local-only likes leave the Library lists alone", () => {
    const client = fakeClient();
    assert.equal(invalidateLibraryAfterRemoteLike(client, ["local-1"]), false);
    assert.equal(invalidateLibraryAfterRemoteLike(client, []), false);
    assert.deepEqual(client.keys, []);
});
