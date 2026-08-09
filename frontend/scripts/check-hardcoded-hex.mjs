import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const BASELINE = 130;
export const HEX_UTILITY_REGEX = /(bg|text|border|ring|ring-offset|from|via|to|shadow|fill|stroke|divide|outline|accent|caret|decoration|placeholder)-\[#[0-9a-fA-F]{3,6}\]/g;

const SOURCE_DIRECTORIES = ["app", "components", "features"];
const EXCLUDED_FILE = "components/player/AudioPlaybackOrchestrator.tsx";

/** Counts arbitrary-value hex color utilities in source text. */
export function countArbitraryHexClasses(source) {
    if (typeof source !== "string") {
        throw new TypeError("source must be a string");
    }

    return source.match(HEX_UTILITY_REGEX)?.length ?? 0;
}

function collectSourceFiles(rootDir) {
    const directories = SOURCE_DIRECTORIES.map((directory) =>
        path.join(rootDir, directory)
    );
    const files = [];

    while (directories.length > 0) {
        const directory = directories.pop();
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (entry.name === "node_modules" || entry.name === ".next") {
                continue;
            }

            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                directories.push(entryPath);
            } else if (/\.(ts|tsx)$/.test(entry.name)) {
                files.push(entryPath);
            }
        }
    }

    return files;
}

/** Counts arbitrary-value hex color utilities in frontend source directories. */
export function scanRepo(rootDir) {
    if (typeof rootDir !== "string" || rootDir.trim() === "") {
        throw new TypeError("rootDir must be a non-empty string");
    }
    if (!statSync(rootDir).isDirectory()) {
        throw new TypeError("rootDir must identify a directory");
    }

    return collectSourceFiles(rootDir).reduce((total, filePath) => {
        if (path.relative(rootDir, filePath) === EXCLUDED_FILE) {
            return total;
        }
        return total + countArbitraryHexClasses(readFileSync(filePath, "utf8"));
    }, 0);
}

function main() {
    const count = scanRepo(process.cwd());
    console.log(`hardcoded arbitrary hex utilities: ${count} (baseline ${BASELINE})`);

    if (count > BASELINE) {
        console.error(
            "hardcoded arbitrary hex utility baseline exceeded; use a token from app/globals.css @theme instead of a new arbitrary hex"
        );
        process.exit(1);
    }

    process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
