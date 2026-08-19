import assert from "node:assert/strict";
import test from "node:test";
import {
    formatBytes,
    formatCoveragePercent,
    formatKbps,
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
