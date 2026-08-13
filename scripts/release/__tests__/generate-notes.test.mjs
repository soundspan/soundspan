import assert from "node:assert/strict";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const generator = path.join(repoRoot, "scripts/release/generate-notes.mjs");
const template = path.join(
    repoRoot,
    "docs/maintainers/RELEASE_NOTES_TEMPLATE.md",
);

function runGenerator(changelogContent) {
    const fixtureRoot = mkdtempSync(
        path.join(repoRoot, ".release-notes-test-"),
    );
    const fixtureTemplateDirectory = path.join(fixtureRoot, "docs/maintainers");

    try {
        mkdirSync(fixtureTemplateDirectory, { recursive: true });
        writeFileSync(
            path.join(fixtureRoot, "CHANGELOG.md"),
            changelogContent,
            "utf8",
        );
        copyFileSync(
            template,
            path.join(fixtureTemplateDirectory, "RELEASE_NOTES_TEMPLATE.md"),
        );

        return spawnSync(
            process.execPath,
            [generator, "--version", "9.9.9", "--from", "HEAD", "--to", "HEAD"],
            { cwd: fixtureRoot, encoding: "utf8" },
        );
    } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

test("generates Accessibility bullets after the Changed section", () => {
    const result = runGenerator(`# Changelog

## [9.9.9] - 2026-08-13

### Accessibility

- Added keyboard navigation to the release controls.
`);

    assert.equal(result.status, 0, result.stderr);
    assert.match(
        result.stdout,
        /## Changed\n\n- No behavior changes documented in this release\.\n\n## Accessibility\n\n- Added keyboard navigation to the release controls\./,
    );
});

test("rejects a heading that is not supported", () => {
    const result = runGenerator(`# Changelog

## [9.9.9] - 2026-08-13

### Experimental

- Added an undocumented release category.
`);

    assert.equal(result.status, 1, result.stdout);
    assert.equal(
        result.stderr.trim(),
        "CHANGELOG.md section [9.9.9] contains unsupported heading(s) with bullets: experimental.",
    );
});
