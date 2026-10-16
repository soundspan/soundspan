import assert from "node:assert/strict";
import test from "node:test";
import { isLibraryVisibleArtistAlbum } from "../../features/artist/artistAlbumVisibility";

test("owned albums and liked remote albums sit in the library section", () => {
    assert.equal(isLibraryVisibleArtistAlbum({ owned: true }), true);
    assert.equal(
        isLibraryVisibleArtistAlbum({ owned: false, source: "remote" }),
        true,
    );
});

test("albums you neither own nor liked stay in the available section", () => {
    assert.equal(isLibraryVisibleArtistAlbum({ owned: false }), false);
    assert.equal(isLibraryVisibleArtistAlbum({}), false);
    assert.equal(
        isLibraryVisibleArtistAlbum({ owned: false, source: "database" }),
        false,
    );
});
