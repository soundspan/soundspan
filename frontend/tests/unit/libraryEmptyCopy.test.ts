import assert from "node:assert/strict";
import test from "node:test";
import {
    formatArtistCountLabel,
    getLibraryEmptyCopy,
} from "../../features/library/libraryEmptyCopy";

test("non-remote origins keep the existing empty-library copy", () => {
    assert.deepEqual(getLibraryEmptyCopy("tracks", "all"), {
        title: "No songs yet",
        description: "Your library is empty. Sync your music to get started.",
    });
    assert.equal(
        getLibraryEmptyCopy("artists", "local").title,
        "No artists yet",
    );
    assert.equal(getLibraryEmptyCopy("albums", "peers").title, "No albums yet");
});

test("the Remote origin explains how streaming songs get there", () => {
    const copy = getLibraryEmptyCopy("tracks", "remote");
    assert.equal(copy.title, "No streaming songs yet");
    assert.match(copy.description, /TIDAL or YouTube Music/);
});

test("artist count keeps the album label and falls back to songs", () => {
    assert.equal(
        formatArtistCountLabel({ albumCount: 3, trackCount: 20 }),
        "3 albums",
    );
    assert.equal(
        formatArtistCountLabel({ albumCount: 0, trackCount: 4 }),
        "4 songs",
    );
    assert.equal(
        formatArtistCountLabel({ albumCount: 0, trackCount: 1 }),
        "1 song",
    );
    assert.equal(formatArtistCountLabel({}), "0 albums");
});
