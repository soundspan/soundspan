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

function runGenerator(changelogContent, additionalArgs = []) {
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
            [
                generator,
                "--version",
                "9.9.9",
                "--from",
                "HEAD",
                "--to",
                "HEAD",
                ...additionalArgs,
            ],
            { cwd: fixtureRoot, encoding: "utf8" },
        );
    } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

const minimalChangelog = `# Changelog

## [9.9.9] - 2026-08-13
`;

test("always renders the standing upgrade warning and upgrade path", () => {
    const result = runGenerator(minimalChangelog);

    assert.equal(result.status, 0, result.stderr);
    assert.match(
        result.stdout,
        /\*\*Warning:\*\* If you run a version earlier than 2\.0\.0, do not upgrade directly\nto 9\.9\.9\. Complete the 2\.0\.0 breaking changes first\. See\n\[Upgrading from an earlier version\]\(#upgrading-from-an-earlier-version\)\./,
    );
    assert.match(
        result.stdout,
        /## Upgrading from an earlier version\n\nIf you are upgrading from a version earlier than 2\.0\.0, you must complete the\n2\.0\.0 upgrade before you install 9\.9\.9\. The 2\.0\.0 release contains breaking\nchanges that later releases depend on\. Read the\n\[2\.0\.0 release notes\]\(https:\/\/github\.com\/soundspan\/soundspan\/blob\/2\.0\.0\/docs\/release-notes\/RELEASE_NOTES_2\.0\.0\.md\)\nand complete the\n\[2\.0\.0 upgrade guide\]\(https:\/\/github\.com\/soundspan\/soundspan\/blob\/2\.0\.0\/docs\/UPGRADING_TO_2\.0\.0\.md\)\./,
    );
});

test("renders upgrade notes in argument order under Before you upgrade", () => {
    const result = runGenerator(minimalChangelog, [
        "--upgrade-note",
        "Run the database backup first.",
        "--upgrade-note",
        "Restart the worker after deployment.",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(
        result.stdout,
        /## Before you upgrade[\s\S]*- Run the database backup first\.\n- Restart the worker after deployment\.\n\n## Fixed/,
    );
});

test("renders the default upgrade note when the flag is absent", () => {
    const result = runGenerator(minimalChangelog);

    assert.equal(result.status, 0, result.stderr);
    assert.match(
        result.stdout,
        /## Before you upgrade[\s\S]*- If you already run 2\.0\.x or later, no manual steps are required\.\n\n## Fixed/,
    );
});

test("renders the standing sections in release-note order", () => {
    const result = runGenerator(minimalChangelog);

    assert.equal(result.status, 0, result.stderr);
    assert.match(
        result.stdout,
        /## Release Summary[\s\S]*## Before you upgrade[\s\S]*## Fixed/,
    );
    assert.match(
        result.stdout,
        /## Upgrading from an earlier version[\s\S]*## Full Changelog/,
    );
});

test("generates Accessibility bullets after the Changed section", () => {
    const result = runGenerator(`# Changelog

## [9.9.9] - 2026-08-13

### Accessibility

- Added keyboard navigation to the release controls.
`);

    assert.equal(result.status, 0, result.stderr);
    assert.match(
        result.stdout,
        /## Removed\n\n- Nothing removed in this release\.\n\n## Accessibility\n\n- Added keyboard navigation to the release controls\./,
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

test("generates Removed bullets after the Changed section", () => {
    const result = runGenerator(`# Changelog

## [9.9.9] - 2026-08-13

### Removed

- Retired the legacy release control surface.
`);

    assert.equal(result.status, 0, result.stderr);
    assert.match(
        result.stdout,
        /## Changed\n\n- No behavior changes documented in this release\.\n\n## Removed\n\n- Retired the legacy release control surface\.\n\n## Accessibility/,
    );
});
