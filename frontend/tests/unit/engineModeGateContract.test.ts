import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * Source contract: engine-mode comparisons outside the engine-mode module.
 *
 * Regression net for the GH #42 no-audio incident: three orchestrator
 * gates tested `resolveStreamingEngineMode() !== "howler"` — written
 * when videojs was the only non-howler mode — so a new mode value
 * silently changed behavior and fed the native element
 * engine a manifest it cannot play. Feature detection by mode
 * INEQUALITY breaks every time a new mode is added; gates must use the
 * semantic helpers (isHowlerModeEnabled) or
 * explicit equality against the mode they mean.
 */

const FRONTEND_ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = ["app", "components", "features", "hooks", "lib"];
const ALLOWED_FILES = new Set([
    // The semantic helpers themselves live here.
    "lib/audio-engine/engineMode.ts",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

const BANNED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    {
        pattern: /resolveStreamingEngineMode\(\)\s*!==?=?\s*["']howler["']/,
        reason: 'mode inequality against "howler" — use isHowlerModeEnabled() (or the helper matching the mode you mean)',
    },
    {
        pattern: /!==\s*["']howler["']/,
        reason: 'inequality against the "howler" mode literal — new modes silently satisfy this; use a semantic engine-mode helper',
    },
];

const listSourceFiles = (dir: string): string[] => {
    const entries = readdirSync(dir);
    const files: string[] = [];
    for (const entry of entries) {
        if (entry === "node_modules" || entry.startsWith(".")) {
            continue;
        }
        const fullPath = join(dir, entry);
        if (statSync(fullPath).isDirectory()) {
            files.push(...listSourceFiles(fullPath));
            continue;
        }
        const dotIndex = entry.lastIndexOf(".");
        if (dotIndex >= 0 && SOURCE_EXTENSIONS.has(entry.slice(dotIndex))) {
            files.push(fullPath);
        }
    }
    return files;
};

test("no engine-mode inequality gates outside lib/audio-engine/engineMode.ts", () => {
    const violations: string[] = [];
    for (const scanDir of SCAN_DIRS) {
        for (const filePath of listSourceFiles(join(FRONTEND_ROOT, scanDir))) {
            const relativePath = relative(FRONTEND_ROOT, filePath);
            if (ALLOWED_FILES.has(relativePath)) {
                continue;
            }
            const content = readFileSync(filePath, "utf8");
            for (const { pattern, reason } of BANNED_PATTERNS) {
                const match = content.match(pattern);
                if (match) {
                    violations.push(
                        `${relativePath}: "${match[0]}" (${reason})`,
                    );
                }
            }
        }
    }
    assert.deepEqual(
        violations,
        [],
        `Engine-mode inequality gates found:\n${violations.join("\n")}`,
    );
});
