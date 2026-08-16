/**
 * Guard enforcing the blessed-sites rule in services/trackEmbeddings.ts: raw
 * `track_embeddings` SQL lives in the service layer, never in route modules.
 * Test files are excluded, matching configBoundary.guard.test.ts.
 */
import fs from "fs";
import path from "path";

const ROUTES_ROOT = path.resolve(__dirname, "../routes");
const MAX_DIRECTORIES = 1_000;
const MAX_DIRECTORY_ENTRIES = 10_000;

function isExcluded(absolutePath: string): boolean {
    const relativePath = path
        .relative(ROUTES_ROOT, absolutePath)
        .split(path.sep)
        .join("/");
    return (
        relativePath.split("/").includes("__tests__") ||
        relativePath.endsWith(".test.ts")
    );
}

function scanDirectory(
    directory: string,
    pendingDirectories: string[],
    offenders: string[],
): void {
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
        if (isExcluded(absolutePath)) continue;
        if (entry.isDirectory()) pendingDirectories.push(absolutePath);
        if (
            entry.isFile() &&
            entry.name.endsWith(".ts") &&
            fs.readFileSync(absolutePath, "utf8").includes("track_embeddings")
        ) {
            offenders.push(path.relative(ROUTES_ROOT, absolutePath));
        }
    }
}

function findRawTrackEmbeddingSql(): string[] {
    const pendingDirectories = [ROUTES_ROOT];
    const offenders: string[] = [];
    let scannedDirectories = 0;

    while (
        pendingDirectories.length > 0 &&
        scannedDirectories < MAX_DIRECTORIES
    ) {
        const directory = pendingDirectories.pop();
        expect(directory).toBeDefined();
        if (directory === undefined) continue;
        scannedDirectories += 1;
        scanDirectory(directory, pendingDirectories, offenders);
    }

    expect(scannedDirectories).toBeLessThan(MAX_DIRECTORIES);
    expect(pendingDirectories).toHaveLength(0);
    return offenders.sort();
}

describe("track embedding SQL boundary", () => {
    it("keeps track_embeddings references out of route modules", () => {
        expect(findRawTrackEmbeddingSql()).toEqual([]);
    });
});
