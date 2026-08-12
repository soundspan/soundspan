import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const validator = path.join(
    repoRoot,
    "scripts/release/validate-release-version.sh",
);
const acceptedVersions = [
    "0.0.0",
    "1.2.3",
    "1.2.3-rc.1",
    "10.20.30-alpha-beta.7",
];
const rejectedVersions = [
    "",
    "v1.2.3",
    "1.2",
    "1.2.3+build.1",
    "1.2.3-rc.1+build.1",
    " 1.2.3",
    "1.2.3 ",
    "1.2.3/release",
];

function runValidator(version) {
    return spawnSync(validator, [version], { encoding: "utf8" });
}

test("accepts the image workflow release version forms", () => {
    assert.equal(acceptedVersions.length, 4);
    for (let index = 0; index < 4; index += 1) {
        const version = acceptedVersions[index];
        const result = runValidator(version);
        assert.equal(result.status, 0, `${version}: ${result.stderr}`);
    }
});

test("rejects versions the image release workflow rejects", () => {
    assert.equal(rejectedVersions.length, 8);
    for (let index = 0; index < 8; index += 1) {
        const version = rejectedVersions[index];
        const result = runValidator(version);
        assert.notEqual(result.status, 0, `${version} was accepted`);
    }
});
