import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const prepareScript = path.join(
    repoRoot,
    "scripts/release/prepare-helm-chart-release.mjs",
);
const versionSyncScript = path.join(
    repoRoot,
    "scripts/release/version-sync.mjs",
);
const releaseVersion = "9.9.9";
function chartValues(version) {
    return `aio:
  image:
    tag: ${version}
backend:
  image:
    tag: ${version}
backendWorker:
  image:
    tag: ${version}
frontend:
  image:
    tag: ${version}
tidalSidecar:
  image:
    tag: ${version}
ytmusicStreamer:
  image:
    tag: ${version}
audioAnalyzer:
  image:
    tag: ${version}
vibeProviderDclap:
  image:
    repository: example/vibeProviderDclap
    tag: ${version}
`;
}

function writePackageFixture(fixtureRoot, name) {
    const packageDirectory = path.join(fixtureRoot, name.split("-").at(-1));
    const packageManifest = { name, version: releaseVersion };
    const lockManifest = {
        name,
        version: releaseVersion,
        lockfileVersion: 3,
        packages: { "": packageManifest },
    };

    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
        path.join(packageDirectory, "package.json"),
        JSON.stringify(packageManifest),
    );
    writeFileSync(
        path.join(packageDirectory, "package-lock.json"),
        JSON.stringify(lockManifest),
    );
}

function createFixture() {
    const fixtureRoot = mkdtempSync(path.join(repoRoot, ".helm-release-test-"));
    const chartDirectory = path.join(fixtureRoot, "charts/soundspan");

    mkdirSync(chartDirectory, { recursive: true });
    writeFileSync(
        path.join(chartDirectory, "Chart.yaml"),
        `version: ${releaseVersion}\nappVersion: "${releaseVersion}"\n`,
    );
    writeFileSync(
        path.join(chartDirectory, "values.yaml"),
        chartValues(releaseVersion),
    );
    writeFileSync(
        path.join(fixtureRoot, "CHANGELOG.md"),
        `# Changelog\n\n## [Unreleased]\n\n### Added\n\n### Changed\n\n### Fixed\n\n## [${releaseVersion}]\n\n### Added\n\n### Changed\n\n### Fixed\n`,
    );
    writePackageFixture(fixtureRoot, "soundspan-backend");
    writePackageFixture(fixtureRoot, "soundspan-frontend");
    return { fixtureRoot, chartDirectory };
}

test("prepare updates the DCLAP provider release image tag", () => {
    const { fixtureRoot, chartDirectory } = createFixture();

    try {
        const result = spawnSync(
            process.execPath,
            [
                prepareScript,
                "--chart-dir",
                chartDirectory,
                "--release-tag",
                "9.9.10",
            ],
            { cwd: fixtureRoot, encoding: "utf8" },
        );

        assert.equal(result.status, 0, result.stderr);
        const values = readFileSync(
            path.join(chartDirectory, "values.yaml"),
            "utf8",
        );
        assert.match(
            values,
            /vibeProviderDclap:\n  image:\n    repository: example\/vibeProviderDclap\n    tag: 9\.9\.10/,
        );
    } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

test("version check accepts DCLAP as the release image section", () => {
    const { fixtureRoot } = createFixture();

    try {
        const result = spawnSync(
            process.execPath,
            [versionSyncScript, "--check", "--version", releaseVersion],
            { cwd: fixtureRoot, encoding: "utf8" },
        );

        assert.equal(result.status, 0, result.stderr);
    } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});
