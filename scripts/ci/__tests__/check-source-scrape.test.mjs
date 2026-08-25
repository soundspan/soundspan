import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
    analyzeSourceScrapes,
    collectSourceScrapes,
    countSourceScrapeAssertions,
    formatSourceScrapeReport,
} from "../check-source-scrape.mjs";

function writeFixture(root, relativePath, source) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
}

test("counts toContain assertions only when a test reads source", () => {
    const readCall = ["fs.read", "FileSync"].join("");
    const containCall = [".to", "Contain"].join("");
    const sourceScrape = `
        const source = ${readCall}(sourcePath, "utf8");
        expect(source)${containCall}("worker");
        expect(source).not${containCall}("legacy");
    `;
    const mockedRead = `
        const mockReadFileSync = jest.fn();
        expect(rendered).toContain("ready");
    `;

    assert.equal(countSourceScrapeAssertions(sourceScrape), 2);
    assert.equal(countSourceScrapeAssertions(mockedRead), 0);
    assert.equal(countSourceScrapeAssertions(`${readCall}(path, "utf8");`), 0);
});

test("rejects new source scrapes and growth above a per-file baseline", () => {
    assert.deepEqual(
        analyzeSourceScrapes(
            { "existing.test.ts": 3, "new.test.ts": 1 },
            { "existing.test.ts": 2, "removed.test.ts": 4 },
        ),
        {
            offenders: [
                { assertions: 3, baseline: 2, file: "existing.test.ts" },
                { assertions: 1, baseline: 0, file: "new.test.ts" },
            ],
            ok: false,
            tightenable: [
                { assertions: 0, baseline: 4, file: "removed.test.ts" },
            ],
            violations: [
                { assertions: 3, baseline: 2, file: "existing.test.ts" },
                { assertions: 1, baseline: 0, file: "new.test.ts" },
            ],
        },
    );
});

test("scans test files while excluding dependencies and non-tests", () => {
    const fixtureRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "source-scrape-roots-"),
    );
    const readCall = ["read", "FileSync"].join("");
    const containCall = [".to", "Contain"].join("");
    const scrape = `const source = ${readCall}(sourcePath, "utf8");
        expect(source)${containCall}("bounded");`;

    try {
        writeFixture(
            fixtureRoot,
            "backend/src/__tests__/guard.test.ts",
            scrape,
        );
        writeFixture(fixtureRoot, "backend/src/ordinary.ts", scrape);
        writeFixture(
            fixtureRoot,
            "node_modules/package/ignored.test.js",
            scrape,
        );
        writeFixture(
            fixtureRoot,
            "backend/src/__tests__/behavior.test.ts",
            'expect(result).toContain("bounded");',
        );

        assert.deepEqual(collectSourceScrapes(fixtureRoot), {
            assertionCounts: {
                "backend/src/__tests__/guard.test.ts": 1,
            },
            scannedCount: 2,
        });
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

test("reports every offender and the files that can tighten", () => {
    const report = formatSourceScrapeReport(
        {
            offenders: [{ assertions: 2, baseline: 2, file: "legacy.test.ts" }],
            ok: true,
            tightenable: [
                { assertions: 1, baseline: 3, file: "smaller.test.ts" },
            ],
            violations: [],
        },
        20,
        2,
        5,
    );

    assert.match(
        report.stdout.join("\n"),
        /passed \(20 test files, 1 offender file, 2 assertions; baseline 2 files, 5 assertions\)/,
    );
    assert.match(
        report.stdout.join("\n"),
        /legacy\.test\.ts: 2 toContain assertions \(baseline 2\)/,
    );
    assert.match(
        report.stdout.join("\n"),
        /smaller\.test\.ts: 1 assertions is below baseline 3/,
    );
});
