import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ALLOWLIST: readonly string[] = [];
const FRONTEND_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE_ROOTS = ["app", "components", "features"] as const;
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const DIRECT_FETCH_PATTERN = /\bfetch\s*\(/;
const MAX_ITERATIONS = 100_000;
const MAX_DIRECTORY_ENTRIES = 100_000;

function findDirectFetchOffenders(): string[] {
    const worklist = SOURCE_ROOTS.map((root) => path.join(FRONTEND_ROOT, root));
    const offenders: string[] = [];
    let iterations = 0;

    while (worklist.length > 0 && iterations < MAX_ITERATIONS) {
        iterations += 1;
        const directory = worklist.pop();
        assert.ok(directory);

        const entries = fs.readdirSync(directory, { withFileTypes: true });
        assert.ok(entries.length <= MAX_DIRECTORY_ENTRIES);
        for (
            let index = 0;
            index < entries.length && index < MAX_DIRECTORY_ENTRIES;
            index += 1
        ) {
            const entry = entries[index];
            assert.ok(entry);
            const absolutePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                worklist.push(absolutePath);
                continue;
            }
            if (
                !entry.isFile() ||
                !SOURCE_EXTENSIONS.has(path.extname(entry.name))
            ) {
                continue;
            }

            const source = fs.readFileSync(absolutePath, "utf8");
            if (DIRECT_FETCH_PATTERN.test(source)) {
                offenders.push(
                    path
                        .relative(FRONTEND_ROOT, absolutePath)
                        .split(path.sep)
                        .join("/"),
                );
            }
        }
    }

    assert.ok(iterations < MAX_ITERATIONS);
    assert.equal(worklist.length, 0);
    return offenders.sort();
}

test("frontend components route network calls through the API boundary", () => {
    const offenders = findDirectFetchOffenders();
    const unexpected = offenders.filter(
        (offender) => !ALLOWLIST.includes(offender),
    );

    assert.deepEqual(
        unexpected,
        [],
        `Unexpected direct fetch calls:\n${unexpected.join("\n")}\n` +
            "Route these calls through frontend/lib/api.ts.",
    );
});

test("the frontend fetch-boundary allowlist has no stale entries", () => {
    const offenders: readonly string[] = findDirectFetchOffenders();
    const staleEntries = ALLOWLIST.filter(
        (entry) => !offenders.includes(entry),
    );

    assert.deepEqual(
        staleEntries,
        [],
        `Stale fetch-boundary allowlist entries:\n${staleEntries.join("\n")}\n` +
            "Remove these entries from ALLOWLIST.",
    );
});
