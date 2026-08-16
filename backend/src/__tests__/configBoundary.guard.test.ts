/**
 * Ratchet enforcing the AGENTS.md config-boundary rule: the allowlist may only
 * shrink, and config.ts plus config/** are the sanctioned process.env readers.
 */
import fs from "fs";
import path from "path";

const ALLOWLIST = [
    "index.ts",
    "middleware/auth.ts",
    "middleware/internalAuth.ts",
    "routes/auth/localCredentials.ts",
    "services/segmented-streaming/cacheService.ts",
    "services/segmented-streaming/segmentService.ts",
    "utils/apiKeyHash.ts",
    "utils/configValidator.ts",
    "utils/db.ts",
    "utils/encryption.ts",
    "utils/envWriter.ts",
    "utils/logger.ts",
    "utils/prismaClientFactory.ts",
    "utils/redis.ts",
    "worker.ts",
    "workers/index.ts",
    "workers/organizeSingles.ts",
    "workers/processors/discoverProcessor.ts",
    "workers/trackMappingStaleness.ts",
] as const;

const SOURCE_ROOT = path.resolve(__dirname, "..");
const MAX_ITERATIONS = 100_000;
const MAX_DIRECTORY_ENTRIES = 100_000;

function toPosixRelativePath(filePath: string): string {
    return path.relative(SOURCE_ROOT, filePath).split(path.sep).join("/");
}

function shouldExclude(relativePath: string, isDirectory: boolean): boolean {
    const segments = relativePath.split("/");
    return (
        segments.includes("__tests__") ||
        relativePath === "config.ts" ||
        relativePath === "config" ||
        relativePath.startsWith("config/") ||
        (!isDirectory && relativePath.endsWith(".test.ts"))
    );
}

function findProcessEnvOffenders(): string[] {
    const worklist = [SOURCE_ROOT];
    const offenders: string[] = [];
    let iterations = 0;

    while (worklist.length > 0 && iterations < MAX_ITERATIONS) {
        iterations += 1;
        const directory = worklist.pop();
        expect(directory).toBeDefined();
        if (directory === undefined) continue;

        const entries = fs.readdirSync(directory, { withFileTypes: true });
        expect(entries.length).toBeLessThanOrEqual(MAX_DIRECTORY_ENTRIES);
        for (
            let index = 0;
            index < entries.length && index < MAX_DIRECTORY_ENTRIES;
            index += 1
        ) {
            const entry = entries[index];
            expect(entry).toBeDefined();
            if (entry === undefined) continue;

            const absolutePath = path.join(directory, entry.name);
            const relativePath = toPosixRelativePath(absolutePath);
            if (shouldExclude(relativePath, entry.isDirectory())) continue;
            if (entry.isDirectory()) worklist.push(absolutePath);
            if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;

            const source = fs
                .readFileSync(absolutePath, "utf8")
                .replaceAll("process.env.npm_package_version", "");
            if (source.includes("process.env")) offenders.push(relativePath);
        }
    }

    expect(iterations).toBeLessThan(MAX_ITERATIONS);
    expect(worklist).toHaveLength(0);
    return offenders.sort();
}

describe("backend config boundary", () => {
    test("no new process.env reads outside the config boundary", () => {
        const offenders = findProcessEnvOffenders();
        const allowlist: readonly string[] = [...ALLOWLIST].sort();
        const unexpected = offenders.filter(
            (offender) => !allowlist.includes(offender),
        );

        if (unexpected.length > 0) {
            throw new Error(
                `Unexpected process.env reads:\n${unexpected.join("\n")}\n` +
                    "Route these reads through backend/src/config.ts.",
            );
        }
    });

    test("the config-boundary allowlist has no stale entries", () => {
        const offenders = findProcessEnvOffenders();
        const allowlist: readonly string[] = [...ALLOWLIST].sort();
        const staleEntries = allowlist.filter(
            (entry) => !offenders.includes(entry),
        );

        if (staleEntries.length > 0) {
            throw new Error(
                `Stale config-boundary allowlist entries:\n${staleEntries.join("\n")}\n` +
                    "Remove these entries from ALLOWLIST.",
            );
        }
    });
});
