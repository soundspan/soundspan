import assert from "node:assert/strict";
import test from "node:test";
import {
    selectRadioMosaicTiles,
    type RadioMosaicCandidate,
} from "../../app/radio/radioStationMosaicSelection";

const candidate = (
    id: string,
    artistKey: string,
    coverArt: string
): RadioMosaicCandidate => ({
    id,
    artistKey,
    coverArt,
});

test("selects six tiles with unique artists and cover art when available", () => {
    const tiles = selectRadioMosaicTiles([
        candidate("t1", "artist-a", "cover-1"),
        candidate("t2", "artist-b", "cover-2"),
        candidate("t3", "artist-c", "cover-3"),
        candidate("t4", "artist-d", "cover-4"),
        candidate("t5", "artist-e", "cover-5"),
        candidate("t6", "artist-f", "cover-6"),
        candidate("t7", "artist-a", "cover-7"),
        candidate("t8", "artist-g", "cover-1"),
    ]);

    assert.equal(tiles.length, 6);
    assert.equal(new Set(tiles.map((tile) => tile.artistKey)).size, 6);
    assert.equal(new Set(tiles.map((tile) => tile.coverArt)).size, 6);
});

test("reuses artists only after unique artist options are exhausted", () => {
    const tiles = selectRadioMosaicTiles([
        candidate("t1", "artist-a", "cover-1"),
        candidate("t2", "artist-a", "cover-2"),
        candidate("t3", "artist-b", "cover-3"),
        candidate("t4", "artist-b", "cover-4"),
        candidate("t5", "artist-c", "cover-5"),
        candidate("t6", "artist-c", "cover-6"),
    ]);

    assert.equal(tiles.length, 6);
    assert.equal(
        new Set(tiles.map((tile) => tile.coverArt)).size,
        6,
        "Should still avoid cover-art reuse when unique covers exist"
    );
});

test("allows tile reuse only when unique artist and cover options are insufficient", () => {
    const tiles = selectRadioMosaicTiles([
        candidate("t1", "artist-a", "cover-1"),
        candidate("t2", "artist-a", "cover-1"),
        candidate("t3", "artist-b", "cover-2"),
    ]);

    assert.equal(tiles.length, 6);
    assert.ok(
        new Set(tiles.map((tile) => tile.coverArt)).size < 6,
        "Expected cover reuse only because unique options are insufficient"
    );
});
