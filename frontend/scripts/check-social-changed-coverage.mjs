#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const BASE_REF = process.env.SOCIAL_COVERAGE_BASE || "f44b3a0";
const TARGET_FILES = [
    "components/layout/ActivityPanel.tsx",
    "components/layout/Sidebar.tsx",
    "components/layout/MobileSidebar.tsx",
    "features/settings/components/sections/PlaybackHistorySection.tsx",
];

function run(command, args, cwd) {
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.error) {
        throw result.error;
    }

    const output = `${result.stdout || ""}${result.stderr || ""}`;
    if (result.status !== 0) {
        const error = new Error(
            `Command failed: ${command} ${args.join(" ")} (status ${result.status})`
        );
        error.output = output;
        throw error;
    }

    return output;
}

function parseUncoveredRanges(uncoveredSpec) {
    if (!uncoveredSpec || uncoveredSpec.trim() === "") {
        return [];
    }

    return uncoveredSpec
        .trim()
        .split(/\s+/)
        .map((token) => {
            if (token.includes("-")) {
                const [startText, endText] = token.split("-");
                const start = Number.parseInt(startText, 10);
                const end = Number.parseInt(endText, 10);
                return Number.isNaN(start) || Number.isNaN(end) ?
                        null
                    :   { start, end };
            }

            const line = Number.parseInt(token, 10);
            return Number.isNaN(line) ? null : { start: line, end: line };
        })
        .filter(Boolean);
}

function extractChangedLines(diffText) {
    const changedLines = new Set();
    const hunkRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
    let match = hunkRegex.exec(diffText);

    while (match) {
        const start = Number.parseInt(match[1], 10);
        const count =
            match[2] === undefined ? 1 : Number.parseInt(match[2], 10);

        if (!Number.isNaN(start) && !Number.isNaN(count) && count > 0) {
            for (let line = start; line < start + count; line += 1) {
                changedLines.add(line);
            }
        }

        match = hunkRegex.exec(diffText);
    }

    return changedLines;
}

function parseCoverageRows(coverageOutput) {
    const rows = new Map();

    for (const line of coverageOutput.split(/\r?\n/)) {
        const cleanLine = line.replace(/\u001B\[[0-9;]*m/g, "");
        const match = cleanLine.match(
            /^\s*(?:ℹ)?\s+(.+?)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s*(.*)$/
        );
        if (!match) {
            continue;
        }

        const fileName = match[1].trim();
        const uncovered = match[5] || "";
        rows.set(fileName, parseUncoveredRanges(uncovered));
    }

    return rows;
}

function intersectsUncovered(line, uncoveredRanges) {
    return uncoveredRanges.some((range) => line >= range.start && line <= range.end);
}

const frontendRoot = process.cwd();

async function readStdin() {
    const chunks = [];

    for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }

    return Buffer.concat(chunks).toString("utf8");
}

const coverageOutput = await readStdin();
if (!coverageOutput.trim()) {
    process.stderr.write(
        "No coverage input received. Pipe `npm run test:component:coverage` into this script.\n"
    );
    process.exit(1);
}

process.stdout.write(coverageOutput);

const uncoveredByFileName = parseCoverageRows(coverageOutput);

let failed = false;
for (const targetFile of TARGET_FILES) {
    const fileName = path.basename(targetFile);
    const uncoveredRanges = uncoveredByFileName.get(fileName);

    if (!uncoveredRanges) {
        process.stderr.write(
            `Missing coverage row for ${targetFile}; unable to verify changed-line coverage.\n`
        );
        failed = true;
        continue;
    }

    const committedDiff = run(
        "git",
        ["diff", "--unified=0", `${BASE_REF}..HEAD`, "--", targetFile],
        frontendRoot
    );
    const workingTreeDiff = run(
        "git",
        ["diff", "--unified=0", "HEAD", "--", targetFile],
        frontendRoot
    );

    const changedLines = extractChangedLines(`${committedDiff}\n${workingTreeDiff}`);
    if (changedLines.size === 0) {
        process.stdout.write(`[coverage] ${targetFile}: no changed lines\n`);
        continue;
    }

    const uncoveredChangedLines = [...changedLines]
        .filter((line) => intersectsUncovered(line, uncoveredRanges))
        .sort((left, right) => left - right);

    if (uncoveredChangedLines.length > 0) {
        failed = true;
        process.stderr.write(
            `[coverage] ${targetFile}: changed lines not covered -> ${uncoveredChangedLines.join(", ")}\n`
        );
    } else {
        process.stdout.write(
            `[coverage] ${targetFile}: ${changedLines.size} changed lines covered\n`
        );
    }
}

if (failed) {
    process.exit(1);
}
