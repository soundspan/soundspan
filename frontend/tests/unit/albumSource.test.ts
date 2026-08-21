import assert from "node:assert/strict";
import test from "node:test";
import { resolveAlbumSource } from "../../features/album/types";

test("resolveAlbumSource preserves the remote library state independently of ownership", () => {
    assert.equal(
        resolveAlbumSource({ owned: false, source: "remote" }),
        "remote",
    );
    assert.equal(
        resolveAlbumSource({ owned: true, source: "local" }),
        "library",
    );
    assert.equal(
        resolveAlbumSource({ owned: false, source: "local" }),
        "discovery",
    );
});
