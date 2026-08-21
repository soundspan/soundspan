import assert from "node:assert/strict";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
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
const fixtureTag = "2.3.3";

function sanitizedGitEnvironment() {
    const environment = { ...process.env };

    for (const key of Object.keys(environment)) {
        if (/^GIT_/.test(key)) {
            delete environment[key];
        }
    }

    environment.GIT_CONFIG_GLOBAL = "/dev/null";
    environment.GIT_CONFIG_SYSTEM = "/dev/null";
    return environment;
}

function runGit(fixtureRoot, args) {
    const result = spawnSync("git", args, {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: sanitizedGitEnvironment(),
    });

    assert.equal(result.status, 0, result.stderr || result.error?.message);
}

function initializeGitFixture(fixtureRoot) {
    runGit(fixtureRoot, ["init", "--initial-branch=main"]);
    runGit(fixtureRoot, ["add", "CHANGELOG.md", "docs/maintainers"]);
    runGit(fixtureRoot, [
        "-c",
        "user.name=Soundspan Release Test",
        "-c",
        "user.email=release-test@soundspan.invalid",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-m",
        "Create release notes fixture",
    ]);
    runGit(fixtureRoot, ["-c", "tag.gpgSign=false", "tag", fixtureTag]);
}

function runGenerator(
    changelogContent,
    { version = "9.9.9", additionalArgs = [] } = {},
) {
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
        initializeGitFixture(fixtureRoot);

        const versionArgs = version === null ? [] : ["--version", version];
        return spawnSync(
            process.execPath,
            [
                generator,
                ...versionArgs,
                "--from",
                fixtureTag,
                ...additionalArgs,
            ],
            {
                cwd: fixtureRoot,
                encoding: "utf8",
                env: sanitizedGitEnvironment(),
            },
        );
    } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

const minimalChangelog = `# Changelog

## [9.9.9] - 2026-08-13
`;

test("ignores ambient Git repository environment", () => {
    const decoyRoot = mkdtempSync(path.join(repoRoot, ".release-notes-decoy-"));
    const previousGitDirectory = process.env.GIT_DIR;
    const previousGitWorkTree = process.env.GIT_WORK_TREE;

    try {
        process.env.GIT_DIR = decoyRoot;
        process.env.GIT_WORK_TREE = decoyRoot;

        const result = runGenerator(minimalChangelog);

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(readdirSync(decoyRoot), []);
    } finally {
        if (previousGitDirectory === undefined) {
            delete process.env.GIT_DIR;
        } else {
            process.env.GIT_DIR = previousGitDirectory;
        }
        if (previousGitWorkTree === undefined) {
            delete process.env.GIT_WORK_TREE;
        } else {
            process.env.GIT_WORK_TREE = previousGitWorkTree;
        }
        rmSync(decoyRoot, { recursive: true, force: true });
    }
});

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
    const result = runGenerator(minimalChangelog, {
        additionalArgs: [
            "--upgrade-note",
            "Run the database backup first.",
            "--upgrade-note",
            "Restart the worker after deployment.",
        ],
    });

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

test("uses exact immutable links for a stable release version", () => {
    const result = runGenerator(minimalChangelog);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
        result.stdout.includes(
            "- Compare changes: [2.3.3...9.9.9](https://github.com/soundspan/soundspan/compare/2.3.3...9.9.9)",
        ),
    );
    assert.ok(
        result.stdout.includes(
            "- Full changelog: https://github.com/soundspan/soundspan/blob/9.9.9/CHANGELOG.md",
        ),
    );
});

test("uses exact immutable links for a prerelease version", () => {
    const prereleaseChangelog = `# Changelog

## [9.9.9-rc.1] - 2026-08-13
`;
    const result = runGenerator(prereleaseChangelog, {
        version: "9.9.9-rc.1",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
        result.stdout.includes(
            "- Compare changes: [2.3.3...9.9.9-rc.1](https://github.com/soundspan/soundspan/compare/2.3.3...9.9.9-rc.1)",
        ),
    );
    assert.ok(
        result.stdout.includes(
            "- Full changelog: https://github.com/soundspan/soundspan/blob/9.9.9-rc.1/CHANGELOG.md",
        ),
    );
});

test("uses an explicit --to override only for the comparison", () => {
    const result = runGenerator(minimalChangelog, {
        additionalArgs: ["--to", "HEAD"],
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
        result.stdout.includes(
            "- Compare changes: [2.3.3...HEAD](https://github.com/soundspan/soundspan/compare/2.3.3...HEAD)",
        ),
    );
    assert.ok(
        result.stdout.includes(
            "- Full changelog: https://github.com/soundspan/soundspan/blob/9.9.9/CHANGELOG.md",
        ),
    );
});

test("rejects a v-prefixed release version", () => {
    const result = runGenerator(minimalChangelog, { version: "v9.9.9" });

    assert.equal(result.status, 1, result.stdout);
    assert.equal(
        result.stderr.trim(),
        'Invalid version "v9.9.9". Use semantic versions without a "v" prefix (for example 1.0.1).',
    );
});

test("reports the hard error without a mutable-HEAD fallback warning", () => {
    const result = runGenerator(minimalChangelog, { version: null });

    assert.equal(result.status, 1, result.stdout);
    assert.equal(
        result.stderr.trim(),
        "Release version is required (for example 1.0.1).",
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

test("generates Deprecated bullets after the Changed section", () => {
    const result = runGenerator(`# Changelog

## [9.9.9] - 2026-08-13

### Deprecated

- Deprecated the legacy release control surface.
`);

    assert.equal(result.status, 0, result.stderr);
    assert.match(
        result.stdout,
        /## Changed\n\n- No behavior changes documented in this release\.\n\n## Deprecated\n\n- Deprecated the legacy release control surface\.\n\n## Removed/,
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
        /## Changed\n\n- No behavior changes documented in this release\.\n\n## Deprecated\n\n- None documented in this release\.\n\n## Removed\n\n- Retired the legacy release control surface\.\n\n## Accessibility/,
    );
});
