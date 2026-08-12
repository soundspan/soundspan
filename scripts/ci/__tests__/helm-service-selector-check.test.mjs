import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const checker = path.join(
    repoRoot,
    "scripts/ci/helm-service-selector-check.mjs",
);

function deployment(podInstance) {
    return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: soundspan-audio-analyzer
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: soundspan
      app.kubernetes.io/instance: soundspan
      app.kubernetes.io/component: audio-analyzer
  template:
    metadata:
      labels:
        app.kubernetes.io/name: soundspan
        app.kubernetes.io/instance: ${podInstance}
        app.kubernetes.io/component: audio-analyzer
`;
}

function runChecker(t, manifest) {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "soundspan-helm-selector-test-"),
    );
    t.after(() => fs.rmSync(directory, { recursive: true }));
    const manifestPath = path.join(directory, "manifest.yaml");
    fs.writeFileSync(manifestPath, manifest);
    return spawnSync(process.execPath, [checker, manifestPath], {
        encoding: "utf8",
    });
}

test("accepts a workload whose selector matches its pod labels", (t) => {
    const result = runChecker(t, deployment("soundspan"));

    assert.equal(result.status, 0, result.stderr);
});

test("rejects a workload whose selector does not match its pod labels", (t) => {
    const result = runChecker(t, deployment("user-instance"));

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Deployment soundspan-audio-analyzer selector/);
});
