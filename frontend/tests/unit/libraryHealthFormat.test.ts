import assert from "node:assert/strict";
import test from "node:test";
import {
    formatBytes,
    formatCoveragePercent,
    formatKbps,
    gapItemLine,
    isAlbumGapItem,
} from "../../features/library-health/format";

test("formatBytes scales units and guards invalid input", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
    assert.equal(formatBytes(120 * 1024 ** 3), "120 GB");
    assert.equal(formatBytes(-1), "—");
    assert.equal(formatBytes(Number.NaN), "—");
});

test("formatKbps rounds and guards missing samples", () => {
    assert.equal(formatKbps(191.6), "192 kbps");
    assert.equal(formatKbps(1411), "1411 kbps");
    assert.equal(formatKbps(null), "—");
    assert.equal(formatKbps(-5), "—");
});

test("formatCoveragePercent clamps and guards empty libraries", () => {
    assert.equal(formatCoveragePercent(50, 200), "25%");
    assert.equal(formatCoveragePercent(200, 200), "100%");
    assert.equal(formatCoveragePercent(250, 200), "100%");
    assert.equal(formatCoveragePercent(-5, 200), "0%");
    assert.equal(formatCoveragePercent(1, 0), "—");
});

// These fixtures mirror the exact row shapes produced by the backend
// read model (listAlbumGap / listTrackGap): album items carry a nested
// artist object, track items carry flat artistName/albumTitle fields.
const ALBUM_GAP_ITEM = {
    id: "album-1",
    title: "Album Title",
    rgMbid: "temp-abc",
    coverUrl: null,
    userCoverUrl: null,
    artist: { id: "artist-1", name: "Album Artist" },
};
const TRACK_GAP_ITEM = {
    id: "track-1",
    title: "Track Title",
    filePath: "/music/a.flac",
    albumTitle: "Track Album",
    artistName: "Track Artist",
};

test("gapItemLine renders album items from the backend album-gap shape", () => {
    assert.equal(isAlbumGapItem(ALBUM_GAP_ITEM), true);
    assert.deepEqual(gapItemLine(ALBUM_GAP_ITEM), {
        primary: "Album Title",
        secondary: "Album Artist",
    });
});

test("gapItemLine renders track items from the backend track-gap shape", () => {
    assert.equal(isAlbumGapItem(TRACK_GAP_ITEM), false);
    assert.deepEqual(gapItemLine(TRACK_GAP_ITEM), {
        primary: "Track Title",
        secondary: "Track Artist — Track Album",
    });
});
