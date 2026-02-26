/**
 * Usage:
 *   npx tsx scripts/measure-segmented-startup-baseline.ts --input <path> [--output <path>] [--label <name>]
 *   npx tsx scripts/measure-segmented-startup-baseline.ts --input <baseline-path> --compare-input <wave-path> [--label <baseline-name>] [--compare-label <wave-name>] [--output <path>]
 *   npx tsx scripts/measure-segmented-startup-baseline.ts --help
 *
 * Reads NDJSON startup telemetry and emits a markdown reliability summary to stdout.
 */

import fs from "fs";
import path from "path";

type CliOptions = {
    inputPath: string;
    outputPath?: string;
    label: string;
    compareInputPath?: string;
    compareLabel: string;
};

type ParseStats = {
    parsedLineCount: number;
    invalidJsonLineCount: number;
    nonObjectLineCount: number;
};

type Metrics = {
    totalStartupTimelineSamples: number;
    latencyValuesMs: number[];
    startupTimeoutCount: number;
    retryExhaustionCount: number;
    parseStats: ParseStats;
};

type ReliabilitySummary = {
    totalStartupTimelineSamples: number;
    latencySampleCount: number;
    p50Ms: number | null;
    p95Ms: number | null;
    startupTimeoutRate: number;
    retryExhaustionRate: number;
};

type Delta = {
    absolute: number;
    relativePercent: number | null;
};

const HELP_TEXT = [
    "Segmented Startup Baseline Measurement",
    "",
    "Single-input mode:",
    "  npx tsx scripts/measure-segmented-startup-baseline.ts --input <path> [--label <name>] [--output <path>]",
    "",
    "Comparison mode:",
    "  npx tsx scripts/measure-segmented-startup-baseline.ts --input <baseline-path> --compare-input <wave-path> [--label <baseline-name>] [--compare-label <wave-name>] [--output <path>]",
    "",
    "Flags:",
    "  --input <path>   Required NDJSON input file path.",
    "  --output <path>  Optional markdown output file path.",
    "  --label <name>   Optional report label. Default: unlabeled.",
    "  --compare-input <path>  Optional second NDJSON input path for baseline-vs-wave deltas.",
    "  --compare-label <name>  Optional second report label. Default: comparison.",
    "  --help           Show this help text.",
].join("\n");

const EVENT_RETRY_EXHAUSTED = "session.startup_retry_exhausted";
const STARTUP_TIMELINE_EVENTS = new Set([
    "player.startup_timeline",
    "session.startup_timeline",
]);

const EVENT_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
    ["event"],
    ["eventName"],
    ["type"],
    ["event", "name"],
    ["event", "eventName"],
    ["fields", "event"],
    ["fields", "eventName"],
    ["fields", "type"],
    ["data", "event"],
    ["data", "eventName"],
    ["data", "type"],
    ["payload", "event"],
    ["payload", "eventName"],
    ["payload", "type"],
    ["attributes", "event"],
    ["attributes", "eventName"],
    ["properties", "event"],
    ["properties", "eventName"],
];

const OUTCOME_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
    ["outcome"],
    ["status"],
    ["startupOutcome"],
    ["fields", "outcome"],
    ["fields", "status"],
    ["data", "outcome"],
    ["data", "status"],
    ["payload", "outcome"],
    ["payload", "status"],
    ["startup", "outcome"],
    ["timeline", "outcome"],
];

const LATENCY_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
    ["totalToAudibleMs"],
    ["total_to_audible_ms"],
    ["timings", "totalToAudibleMs"],
    ["timings", "total_to_audible_ms"],
    ["metrics", "totalToAudibleMs"],
    ["metrics", "total_to_audible_ms"],
    ["fields", "totalToAudibleMs"],
    ["fields", "total_to_audible_ms"],
    ["fields", "metrics", "totalToAudibleMs"],
    ["fields", "timings", "totalToAudibleMs"],
    ["data", "totalToAudibleMs"],
    ["data", "metrics", "totalToAudibleMs"],
    ["data", "timings", "totalToAudibleMs"],
    ["payload", "totalToAudibleMs"],
    ["payload", "metrics", "totalToAudibleMs"],
    ["payload", "timings", "totalToAudibleMs"],
];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeToken(value: string): string {
    return value.trim().toLowerCase();
}

function getValueAtPath(root: unknown, pathSegments: ReadonlyArray<string>): unknown {
    let current: unknown = root;
    for (const segment of pathSegments) {
        if (!isRecord(current)) return undefined;
        current = current[segment];
    }
    return current;
}

function coerceString(value: unknown): string | undefined {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    return undefined;
}

function coerceNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const numeric = Number(value.trim());
        if (Number.isFinite(numeric)) return numeric;
    }
    return undefined;
}

function findFirstByKeys(
    root: unknown,
    acceptedKeys: ReadonlySet<string>,
    coerce: (value: unknown) => string | number | undefined,
): string | number | undefined {
    const stack: unknown[] = [root];
    let guard = 0;

    while (stack.length > 0 && guard < 5000) {
        guard += 1;
        const current = stack.pop();
        if (!current) continue;

        if (Array.isArray(current)) {
            for (let i = current.length - 1; i >= 0; i -= 1) {
                stack.push(current[i]);
            }
            continue;
        }

        if (!isRecord(current)) continue;

        for (const [key, value] of Object.entries(current)) {
            if (acceptedKeys.has(normalizeKey(key))) {
                const coerced = coerce(value);
                if (coerced !== undefined) return coerced;
            }
        }

        for (const value of Object.values(current)) {
            if (value !== null && (Array.isArray(value) || isRecord(value))) {
                stack.push(value);
            }
        }
    }

    return undefined;
}

function pickString(root: unknown, paths: ReadonlyArray<ReadonlyArray<string>>, fallbackKeys: string[]): string | undefined {
    for (const pathSegments of paths) {
        const candidate = coerceString(getValueAtPath(root, pathSegments));
        if (candidate !== undefined) return candidate;
    }

    return findFirstByKeys(
        root,
        new Set(fallbackKeys.map((key) => normalizeKey(key))),
        (value) => coerceString(value),
    ) as string | undefined;
}

function pickNumber(root: unknown, paths: ReadonlyArray<ReadonlyArray<string>>, fallbackKeys: string[]): number | undefined {
    for (const pathSegments of paths) {
        const candidate = coerceNumber(getValueAtPath(root, pathSegments));
        if (candidate !== undefined) return candidate;
    }

    return findFirstByKeys(
        root,
        new Set(fallbackKeys.map((key) => normalizeKey(key))),
        (value) => coerceNumber(value),
    ) as number | undefined;
}

function parseArgs(argv: string[]): CliOptions {
    let inputPath: string | undefined;
    let outputPath: string | undefined;
    let label = "unlabeled";
    let compareInputPath: string | undefined;
    let compareLabel = "comparison";
    let compareLabelProvided = false;

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === "--help" || token === "-h") {
            console.log(HELP_TEXT);
            process.exit(0);
        }

        if (token === "--input") {
            const value = argv[index + 1];
            if (!value || value.startsWith("--")) {
                throw new Error("Missing value for --input");
            }
            inputPath = value;
            index += 1;
            continue;
        }

        if (token === "--output") {
            const value = argv[index + 1];
            if (!value || value.startsWith("--")) {
                throw new Error("Missing value for --output");
            }
            outputPath = value;
            index += 1;
            continue;
        }

        if (token === "--label") {
            const value = argv[index + 1];
            if (!value || value.startsWith("--")) {
                throw new Error("Missing value for --label");
            }
            label = value;
            index += 1;
            continue;
        }

        if (token === "--compare-input") {
            const value = argv[index + 1];
            if (!value || value.startsWith("--")) {
                throw new Error("Missing value for --compare-input");
            }
            compareInputPath = value;
            index += 1;
            continue;
        }

        if (token === "--compare-label") {
            const value = argv[index + 1];
            if (!value || value.startsWith("--")) {
                throw new Error("Missing value for --compare-label");
            }
            compareLabel = value;
            compareLabelProvided = true;
            index += 1;
            continue;
        }

        throw new Error(`Unknown flag: ${token}`);
    }

    if (!inputPath) {
        throw new Error("Missing required --input <path>");
    }

    if (compareLabelProvided && !compareInputPath) {
        throw new Error("--compare-label requires --compare-input");
    }

    return {
        inputPath,
        outputPath,
        label,
        compareInputPath,
        compareLabel,
    };
}

function quantile(values: number[], q: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 1) return sorted[0];

    const position = (sorted.length - 1) * q;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];

    const weight = position - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function round(value: number, digits = 2): number {
    const factor = 10 ** digits;
    const rounded = Math.round(value * factor) / factor;
    return Object.is(rounded, -0) ? 0 : rounded;
}

function formatPercent(rate: number): string {
    return `${round(rate * 100, 2)}%`;
}

function formatMs(value: number | null): string {
    if (value === null) return "n/a";
    return `${round(value, 2)} ms`;
}

function formatSigned(value: number, digits = 2): string {
    const rounded = round(value, digits);
    const prefix = rounded > 0 ? "+" : "";
    return `${prefix}${rounded}`;
}

function formatRelativePercent(value: number | null): string {
    if (value === null) return "n/a (baseline is 0)";
    return `${formatSigned(value, 2)}%`;
}

function computeDelta(baseline: number, wave: number): Delta {
    const absolute = wave - baseline;
    return {
        absolute,
        relativePercent: baseline === 0 ? null : (absolute / baseline) * 100,
    };
}

function formatLatencyDelta(baseline: number | null, wave: number | null): string {
    if (baseline === null || wave === null) {
        return "n/a (missing latency samples)";
    }
    const delta = computeDelta(baseline, wave);
    return `${formatSigned(delta.absolute, 2)} ms (${formatRelativePercent(delta.relativePercent)})`;
}

function formatRateDelta(baselineRate: number, waveRate: number): string {
    const delta = computeDelta(baselineRate, waveRate);
    return `${formatSigned(delta.absolute * 100, 2)} pp (${formatRelativePercent(delta.relativePercent)})`;
}

function describeConfidence(totalStartupTimelineSamples: number): string {
    if (totalStartupTimelineSamples < 200) {
        return `low confidence (<200 startup timeline samples; observed ${totalStartupTimelineSamples})`;
    }
    return `baseline confidence (>=200 startup timeline samples; observed ${totalStartupTimelineSamples})`;
}

function summarizeMetrics(metrics: Metrics): ReliabilitySummary {
    const total = metrics.totalStartupTimelineSamples;
    return {
        totalStartupTimelineSamples: total,
        latencySampleCount: metrics.latencyValuesMs.length,
        p50Ms: quantile(metrics.latencyValuesMs, 0.5),
        p95Ms: quantile(metrics.latencyValuesMs, 0.95),
        startupTimeoutRate: total > 0 ? metrics.startupTimeoutCount / total : 0,
        retryExhaustionRate: total > 0 ? metrics.retryExhaustionCount / total : 0,
    };
}

function appendReliabilitySummaryLines(lines: string[], metrics: Metrics, summary: ReliabilitySummary): void {
    const total = summary.totalStartupTimelineSamples;
    lines.push(`- Total startup timeline samples: ${total}`);
    lines.push(
        `- First-audible latency p50 (\`totalToAudibleMs\`): ${formatMs(summary.p50Ms)} (from ${summary.latencySampleCount} samples)`,
    );
    lines.push(
        `- First-audible latency p95 (\`totalToAudibleMs\`): ${formatMs(summary.p95Ms)} (from ${summary.latencySampleCount} samples)`,
    );
    lines.push(
        `- Startup-timeout rate: ${metrics.startupTimeoutCount}/${total} (${formatPercent(summary.startupTimeoutRate)})`,
    );
    lines.push(
        `- Retry-exhaustion events (\`${EVENT_RETRY_EXHAUSTED}\`): ${metrics.retryExhaustionCount}/${total} (${formatPercent(summary.retryExhaustionRate)})`,
    );
}

function collectMetrics(contents: string): Metrics {
    const lines = contents.split(/\r?\n/);

    let parsedLineCount = 0;
    let invalidJsonLineCount = 0;
    let nonObjectLineCount = 0;

    let totalStartupTimelineSamples = 0;
    let startupTimeoutCount = 0;
    let retryExhaustionCount = 0;
    const latencyValuesMs: number[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            invalidJsonLineCount += 1;
            continue;
        }

        parsedLineCount += 1;
        if (!isRecord(parsed)) {
            nonObjectLineCount += 1;
            continue;
        }

        const eventName = normalizeToken(
            pickString(parsed, EVENT_PATHS, ["event", "eventName", "type"]) ?? "",
        );
        const outcome = normalizeToken(
            pickString(parsed, OUTCOME_PATHS, ["outcome", "status", "startupOutcome"]) ?? "",
        );
        const totalToAudibleMs = pickNumber(parsed, LATENCY_PATHS, ["totalToAudibleMs", "total_to_audible_ms"]);

        if (eventName === EVENT_RETRY_EXHAUSTED) {
            retryExhaustionCount += 1;
        }

        const isStartupTimelineSample =
            totalToAudibleMs !== undefined ||
            outcome.length > 0 ||
            STARTUP_TIMELINE_EVENTS.has(eventName);

        if (!isStartupTimelineSample) continue;

        totalStartupTimelineSamples += 1;
        if (totalToAudibleMs !== undefined) {
            latencyValuesMs.push(totalToAudibleMs);
        }
        if (outcome === "startup_timeout") {
            startupTimeoutCount += 1;
        }
    }

    return {
        totalStartupTimelineSamples,
        latencyValuesMs,
        startupTimeoutCount,
        retryExhaustionCount,
        parseStats: {
            parsedLineCount,
            invalidJsonLineCount,
            nonObjectLineCount,
        },
    };
}

function buildReport(params: {
    label: string;
    inputPath: string;
    metrics: Metrics;
}): string {
    const { label, inputPath, metrics } = params;
    const summary = summarizeMetrics(metrics);

    const lines: string[] = [];
    lines.push("# Segmented Streaming Startup Baseline Report");
    lines.push("");
    lines.push(`- Label: ${label}`);
    lines.push(`- Generated at: ${new Date().toISOString()}`);
    lines.push(`- Input: \`${inputPath}\``);
    lines.push(`- Parsed NDJSON entries: ${metrics.parseStats.parsedLineCount}`);
    lines.push(`- Invalid JSON lines skipped: ${metrics.parseStats.invalidJsonLineCount}`);
    lines.push(`- Non-object lines skipped: ${metrics.parseStats.nonObjectLineCount}`);
    lines.push("");
    lines.push("## Reliability Summary");
    lines.push("");
    appendReliabilitySummaryLines(lines, metrics, summary);
    lines.push("");
    lines.push("## Confidence Caveat");
    lines.push("");
    lines.push("- Confidence rule: <200 samples = low confidence; >=200 samples = baseline confidence.");
    lines.push(`- ${label}: ${describeConfidence(summary.totalStartupTimelineSamples)}.`);

    return `${lines.join("\n")}\n`;
}

function buildComparisonReport(params: {
    baseline: {
        label: string;
        inputPath: string;
        metrics: Metrics;
    };
    wave: {
        label: string;
        inputPath: string;
        metrics: Metrics;
    };
}): string {
    const baselineSummary = summarizeMetrics(params.baseline.metrics);
    const waveSummary = summarizeMetrics(params.wave.metrics);

    const lines: string[] = [];
    lines.push("# Segmented Streaming Startup Baseline vs Wave Report");
    lines.push("");
    lines.push(`- Generated at: ${new Date().toISOString()}`);
    lines.push(`- Baseline label: ${params.baseline.label}`);
    lines.push(`- Baseline input: \`${params.baseline.inputPath}\``);
    lines.push(`- Wave label: ${params.wave.label}`);
    lines.push(`- Wave input: \`${params.wave.inputPath}\``);
    lines.push("");
    lines.push("## Parse Stats");
    lines.push("");
    lines.push(
        `- ${params.baseline.label}: parsed=${params.baseline.metrics.parseStats.parsedLineCount}, invalid-json=${params.baseline.metrics.parseStats.invalidJsonLineCount}, non-object=${params.baseline.metrics.parseStats.nonObjectLineCount}`,
    );
    lines.push(
        `- ${params.wave.label}: parsed=${params.wave.metrics.parseStats.parsedLineCount}, invalid-json=${params.wave.metrics.parseStats.invalidJsonLineCount}, non-object=${params.wave.metrics.parseStats.nonObjectLineCount}`,
    );
    lines.push("");
    lines.push(`## Reliability Summary (${params.baseline.label})`);
    lines.push("");
    appendReliabilitySummaryLines(lines, params.baseline.metrics, baselineSummary);
    lines.push("");
    lines.push(`## Reliability Summary (${params.wave.label})`);
    lines.push("");
    appendReliabilitySummaryLines(lines, params.wave.metrics, waveSummary);
    lines.push("");
    lines.push(`## Delta Summary (${params.wave.label} - ${params.baseline.label})`);
    lines.push("");
    lines.push(
        `- First-audible latency p50 (\`totalToAudibleMs\`): ${formatLatencyDelta(baselineSummary.p50Ms, waveSummary.p50Ms)}`,
    );
    lines.push(
        `- First-audible latency p95 (\`totalToAudibleMs\`): ${formatLatencyDelta(baselineSummary.p95Ms, waveSummary.p95Ms)}`,
    );
    lines.push(
        `- Startup-timeout rate: ${formatRateDelta(baselineSummary.startupTimeoutRate, waveSummary.startupTimeoutRate)}`,
    );
    lines.push(
        `- Retry-exhaustion rate: ${formatRateDelta(baselineSummary.retryExhaustionRate, waveSummary.retryExhaustionRate)}`,
    );
    lines.push("");
    lines.push("## Confidence Caveat");
    lines.push("");
    lines.push("- Confidence rule: <200 samples = low confidence; >=200 samples = baseline confidence.");
    lines.push(`- ${params.baseline.label}: ${describeConfidence(baselineSummary.totalStartupTimelineSamples)}.`);
    lines.push(`- ${params.wave.label}: ${describeConfidence(waveSummary.totalStartupTimelineSamples)}.`);
    if (
        baselineSummary.totalStartupTimelineSamples < 200 ||
        waveSummary.totalStartupTimelineSamples < 200
    ) {
        lines.push("- Treat deltas as directional until both captures reach at least 200 samples.");
    }

    return `${lines.join("\n")}\n`;
}

function main(): void {
    const options = parseArgs(process.argv.slice(2));
    const absoluteInputPath = path.resolve(process.cwd(), options.inputPath);
    const inputContents = fs.readFileSync(absoluteInputPath, "utf8");
    const baselineMetrics = collectMetrics(inputContents);
    const absoluteCompareInputPath = options.compareInputPath
        ? path.resolve(process.cwd(), options.compareInputPath)
        : undefined;

    const report = absoluteCompareInputPath
        ? buildComparisonReport({
              baseline: {
                  label: options.label,
                  inputPath: absoluteInputPath,
                  metrics: baselineMetrics,
              },
              wave: {
                  label: options.compareLabel,
                  inputPath: absoluteCompareInputPath,
                  metrics: collectMetrics(fs.readFileSync(absoluteCompareInputPath, "utf8")),
              },
          })
        : buildReport({
              label: options.label,
              inputPath: absoluteInputPath,
              metrics: baselineMetrics,
          });

    process.stdout.write(report);

    if (options.outputPath) {
        const absoluteOutputPath = path.resolve(process.cwd(), options.outputPath);
        fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
        fs.writeFileSync(absoluteOutputPath, report, "utf8");
    }
}

try {
    main();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`measure-segmented-startup-baseline failed: ${message}`);
    console.error("");
    console.error(HELP_TEXT);
    process.exitCode = 1;
}
