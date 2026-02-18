import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const SRC_ROOT = join(__dirname, "..");
const FILE_EXTENSIONS = new Set([".ts", ".tsx"]);
const DISALLOWED_IMPORT = /\bfrom\s+["'][^"']*\/data\/[^"']*["']/g;
const DISALLOWED_REQUIRE = /\brequire\(\s*["'][^"']*\/data\/[^"']*["']\s*\)/g;
const DISALLOWED_JOIN_PATH = /\bjoin\(\s*__dirname\s*,\s*["'][^"']*\/data\/[^"']*["']/g;

interface Violation {
    filePath: string;
    line: number;
    snippet: string;
}

function collectFiles(dirPath: string): string[] {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const absolutePath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectFiles(absolutePath));
            continue;
        }

        const extension = entry.name.slice(entry.name.lastIndexOf("."));
        if (FILE_EXTENSIONS.has(extension)) {
            files.push(absolutePath);
        }
    }

    return files;
}

function findLine(content: string, index: number): number {
    return content.slice(0, index).split(/\r?\n/).length;
}

function scanFile(filePath: string): Violation[] {
    const content = readFileSync(filePath, "utf8");
    const violations: Violation[] = [];
    const patterns = [DISALLOWED_IMPORT, DISALLOWED_REQUIRE, DISALLOWED_JOIN_PATH];

    for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match = pattern.exec(content);
        while (match) {
            violations.push({
                filePath: relative(process.cwd(), filePath),
                line: findLine(content, match.index),
                snippet: match[0],
            });
            match = pattern.exec(content);
        }
    }

    return violations;
}

function main() {
    if (!statSync(SRC_ROOT).isDirectory()) {
        throw new Error(`Source root not found: ${SRC_ROOT}`);
    }

    const files = collectFiles(SRC_ROOT);
    const violations = files.flatMap(scanFile);

    if (violations.length === 0) {
        console.log("verifyNoIgnoredDataPaths: no disallowed /data/ source references found.");
        return;
    }

    console.error("verifyNoIgnoredDataPaths: disallowed ignored-path references found:");
    for (const violation of violations) {
        console.error(`- ${violation.filePath}:${violation.line} -> ${violation.snippet}`);
    }
    process.exitCode = 1;
}

main();
