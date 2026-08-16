import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeOverrides } from "../check-override-staleness.mjs";

function lockWith(entries) {
    return {
        lockfileVersion: 3,
        packages: Object.fromEntries(
            entries.map(([name, version]) => [
                `node_modules/${name}`,
                { version },
            ]),
        ),
    };
}

test("reports an override whose package is absent from the lock graph", () => {
    const result = analyzeOverrides(
        { "missing-package@<2.0.0": "2.0.0" },
        lockWith([["present-package", "1.0.0"]]),
    );

    assert.deepEqual(result.dangling, [
        {
            name: "missing-package",
            selector: "missing-package@<2.0.0",
        },
    ]);
    assert.deepEqual(result.candidates, []);
});

test("accepts a scoped override that has a matching lock entry", () => {
    const result = analyzeOverrides(
        { "@scope/package@<=1.2.2": "1.2.3" },
        lockWith([["@scope/package", "1.2.3"]]),
    );

    assert.deepEqual(result, { dangling: [], candidates: [] });
});

test("warns when the resolved release exceeds the override safe floor", () => {
    const result = analyzeOverrides(
        { "dependency@<1.2.3": "1.2.3" },
        lockWith([["dependency", "1.2.4"]]),
    );

    assert.deepEqual(result.dangling, []);
    assert.deepEqual(result.candidates, [
        {
            name: "dependency",
            pinnedVersion: "1.2.3",
            resolvedVersions: ["1.2.4"],
            selector: "dependency@<1.2.3",
        },
    ]);
});

test("does not compare unrelated resolved major lines", () => {
    const result = analyzeOverrides(
        { "dependency@<1.2.3": "1.2.3" },
        lockWith([
            ["dependency", "1.2.3"],
            ["dependency", "4.0.0"],
        ]),
    );

    assert.deepEqual(result, { dangling: [], candidates: [] });
});
