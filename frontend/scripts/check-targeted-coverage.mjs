import process from "node:process";

const input = await new Promise((resolve) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
        buffer += chunk;
    });
    process.stdin.on("end", () => resolve(buffer));
});

process.stdout.write(input);

if (!input.includes("start of coverage report")) {
    console.error("targeted coverage check failed: raw coverage report was not produced");
    process.exit(1);
}

const failMatch = input.match(/ℹ fail (\d+)/);
if (!failMatch || failMatch[1] !== "0") {
    console.error("targeted coverage check failed: one or more tests failed");
    process.exit(1);
}

const requiredTests = [
    "getActivityPanelBadgeState keeps active badge when admin activity is the only signal",
    "resolveActivityTab uses notifications as the default fallback",
    "hasMyHistoryLink short-circuits when my-history is the first entry",
    "getImpactedHistoryCount returns the past-week count",
    "getImpactedHistoryCount returns the all-time count",
    "getImpactedHistoryCount preserves zero-valued weekly ranges",
];

for (const testName of requiredTests) {
    if (!input.includes(testName)) {
        console.error(`targeted coverage check failed: missing required branch test "${testName}"`);
        process.exit(1);
    }
}

const coverageExpectations = [
    { file: "activityPanelTabs.ts", line: 100, branch: 97.62, funcs: 100 },
    { file: "socialNavigation.ts", line: 100, branch: 93.75, funcs: 100 },
    { file: "playbackHistoryConfig.ts", line: 100, branch: 94.12, funcs: 100 },
];

const coverageRows = input
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.includes("|"));

for (const expectation of coverageExpectations) {
    const row = coverageRows.find((line) => line.includes(expectation.file));
    if (!row) {
        console.error(`targeted coverage check failed: coverage row missing for ${expectation.file}`);
        process.exit(1);
    }

    const [, lineText, branchText, funcsText, uncoveredText = ""] = row
        .split("|")
        .map((segment) => segment.trim());
    const line = Number(lineText);
    const branch = Number(branchText);
    const funcs = Number(funcsText);
    const uncovered = uncoveredText.trim();

    if (line !== expectation.line || funcs !== expectation.funcs) {
        console.error(
            `targeted coverage check failed: ${expectation.file} line/functions coverage drifted (${lineText}/${funcsText})`
        );
        process.exit(1);
    }

    if (branch < expectation.branch) {
        console.error(
            `targeted coverage check failed: ${expectation.file} branch coverage dropped below the tolerated helper-artifact floor (${branchText} < ${expectation.branch.toFixed(2)})`
        );
        process.exit(1);
    }

    if (uncovered.length > 0) {
        console.error(
            `targeted coverage check failed: ${expectation.file} reported uncovered source lines (${uncovered})`
        );
        process.exit(1);
    }
}

console.log(
    "targeted coverage check passed: raw coverage only reported the known Node/tsx helper-branch artifact"
);
