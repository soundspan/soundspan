import { extname } from "node:path";
import pLimit from "p-limit";
import { LOCAL_TRACK_WHERE } from "../utils/librarySorting";
import {
    compareAudioEmbeddings,
    DEFAULT_PROVIDER_FIDELITY_SAMPLE,
    evaluateGate,
    MAX_PROVIDER_FIDELITY_SAMPLE,
    textQueryOverlap,
    topKOverlap,
    type ProviderFidelityThresholds,
} from "./providerFidelity";
import {
    assertProviderVector,
    normalizeProviderBaseUrl,
    type ProviderSpace,
    VibeProviderError,
    type VibeProviderClient,
} from "./vibeProvider";

const DEFAULT_OUTPUT_PATH = "provider-fidelity-report.md";
const PROVIDER_CONCURRENCY = 3;
const MAX_EXCLUSION_RATE = 0.05;
const DEFAULT_THRESHOLDS: ProviderFidelityThresholds = {
    medianCosine: 0.98,
    meanTopKOverlap: 0.9,
};

/** One eligible local track reference sent to both providers. */
export interface ProviderFidelityTrack {
    id: string;
    filePath: string;
}

interface TrackQueryPort {
    findMany(
        args: unknown,
    ): Promise<Array<{ id: string; filePath: string | null }>>;
}

interface ProviderFidelityDatabasePort {
    track: TrackQueryPort;
}

/** Fully parsed provider fidelity command options. */
export interface ProviderFidelityCliOptions {
    baselineUrl: string;
    candidateUrl: string;
    sample: number;
    k: number;
    outputPath: string;
}

/** One track excluded because either provider failed its trust boundary. */
export interface ProviderFidelityExclusion {
    trackId: string;
    reason: string;
}

/** Complete machine-readable result without raw embedding vectors. */
export interface ProviderFidelityReport {
    providers: { baseline: ProviderSpace; candidate: ProviderSpace };
    thresholds: ProviderFidelityThresholds;
    sample: { requested: number; selected: number; valid: number };
    k: number;
    durationMs: number;
    exclusionRate: number;
    exclusionPolicyPassed: boolean;
    exclusions: ProviderFidelityExclusion[];
    audio: ReturnType<typeof compareAudioEmbeddings>;
    topK: ReturnType<typeof topKOverlap>;
    textQuery: Awaited<ReturnType<typeof textQueryOverlap>>;
    gate: ReturnType<typeof evaluateGate>;
}

interface ValidationDependencies {
    sampleTracks(limit: number): Promise<ProviderFidelityTrack[]>;
    baseline: VibeProviderClient;
    candidate: VibeProviderClient;
    queries: readonly string[];
    nowMs(): number;
    onProgress(processed: number, total: number): void;
    onExclusion(exclusion: ProviderFidelityExclusion): void;
}

interface ValidationOptions {
    sample: number;
    k: number;
    thresholds?: ProviderFidelityThresholds;
}

interface EmbeddedPair {
    trackId: string;
    a: number[];
    b: number[];
}

type ProviderSpaces = { baseline: ProviderSpace; candidate: ProviderSpace };
type FidelityMeasurements = Pick<
    ProviderFidelityReport,
    "audio" | "topK" | "textQuery"
>;

type EmbeddedTrackResult =
    | { kind: "included"; pair: EmbeddedPair }
    | { kind: "excluded"; exclusion: ProviderFidelityExclusion };

/** Run failure carrying the completed report when exclusions exceed five percent. */
export class ProviderFidelityExclusionError extends Error {
    constructor(public readonly report: ProviderFidelityReport) {
        super("provider fidelity exclusions exceed five percent of the sample");
        this.name = "ProviderFidelityExclusionError";
    }
}

function requireSampleBounds(sample: number): void {
    if (
        !Number.isInteger(sample) ||
        sample < 2 ||
        sample > MAX_PROVIDER_FIDELITY_SAMPLE
    ) {
        throw new RangeError(
            `--sample must be between 2 and ${MAX_PROVIDER_FIDELITY_SAMPLE}`,
        );
    }
}

function requireKBounds(k: number, sample: number): void {
    if (!Number.isInteger(k) || k < 1) {
        throw new RangeError("--k must be a positive integer");
    }
    if (k >= sample) throw new RangeError("--k must be less than --sample");
}

function parseIntegerFlag(value: string | undefined, flag: string): number {
    if (!value || !/^[1-9]\d*$/.test(value)) {
        throw new TypeError(`${flag} must be a positive integer`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new TypeError(`${flag} must be a positive integer`);
    }
    return parsed;
}

function parseFlagPairs(argv: readonly string[]): Map<string, string> {
    if (argv.length > 10) throw new RangeError("too many arguments");
    const flags = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
            throw new TypeError(`missing value for ${flag ?? "argument"}`);
        }
        if (flags.has(flag)) throw new TypeError(`duplicate option ${flag}`);
        flags.set(flag, value);
    }
    return flags;
}

/** Parse the bounded CLI surface without reading process globals. */
export function parseProviderFidelityArgs(
    argv: readonly string[],
    configuredBaselineUrl: string | undefined,
): ProviderFidelityCliOptions {
    const flags = parseFlagPairs(argv);
    const allowed = new Set([
        "--baseline-url",
        "--candidate-url",
        "--sample",
        "--k",
        "--output",
    ]);
    const unknown = [...flags.keys()].find((flag) => !allowed.has(flag));
    if (unknown) throw new TypeError(`unknown option ${unknown}`);
    const candidate = flags.get("--candidate-url");
    if (!candidate) throw new TypeError("--candidate-url is required");
    const baseline = flags.get("--baseline-url") ?? configuredBaselineUrl;
    if (!baseline) {
        throw new TypeError("--baseline-url or VIBE_PROVIDER_URL is required");
    }
    const sample = flags.has("--sample")
        ? parseIntegerFlag(flags.get("--sample"), "--sample")
        : DEFAULT_PROVIDER_FIDELITY_SAMPLE;
    const k = flags.has("--k") ? parseIntegerFlag(flags.get("--k"), "--k") : 10;
    requireSampleBounds(sample);
    requireKBounds(k, sample);
    return {
        baselineUrl: normalizeProviderBaseUrl(baseline),
        candidateUrl: normalizeProviderBaseUrl(candidate),
        sample,
        k,
        outputPath: flags.get("--output") ?? DEFAULT_OUTPUT_PATH,
    };
}

function requireTrackRows(
    rows: Array<{ id: string; filePath: string | null }>,
): ProviderFidelityTrack[] {
    return rows.map((row) => {
        if (!row.id || !row.filePath)
            throw new TypeError("invalid eligible track row");
        return { id: row.id, filePath: row.filePath };
    });
}

/** Create bounded random-pivot sampling over the indexed `Track.random` key. */
export function createEligibleTrackSampler(
    database: ProviderFidelityDatabasePort,
    random: () => number = Math.random,
): (limit: number) => Promise<ProviderFidelityTrack[]> {
    return async (limit) => {
        requireSampleBounds(limit);
        const pivot = random();
        if (!Number.isFinite(pivot) || pivot < 0 || pivot >= 1) {
            throw new RangeError("random pivot must be in [0, 1)");
        }
        const where = {
            ...LOCAL_TRACK_WHERE,
            removedAt: null,
            filePath: { not: null },
        };
        const first = await database.track.findMany({
            where: { ...where, random: { gte: pivot } },
            orderBy: { random: "asc" },
            take: limit,
            select: { id: true, filePath: true },
        });
        const remaining = limit - first.length;
        if (remaining === 0) return requireTrackRows(first);
        const second = await database.track.findMany({
            where: { ...where, random: { lt: pivot } },
            orderBy: { random: "asc" },
            take: remaining,
            select: { id: true, filePath: true },
        });
        return requireTrackRows([...first, ...second]);
    };
}

function providerFailureReason(label: string, error: unknown): string {
    const code = error instanceof VibeProviderError ? ` (${error.code})` : "";
    return `${label} embedding request failed${code}`;
}

function excluded(trackId: string, reason: string): EmbeddedTrackResult {
    return { kind: "excluded", exclusion: { trackId, reason } };
}

async function embedTrackPair(
    track: ProviderFidelityTrack,
    spaces: ProviderSpaces,
    dependencies: Pick<ValidationDependencies, "baseline" | "candidate">,
    limit: ReturnType<typeof pLimit>,
): Promise<EmbeddedTrackResult> {
    const [baseline, candidate] = await Promise.allSettled([
        limit(() => dependencies.baseline.embedAudio(track.filePath)),
        limit(() => dependencies.candidate.embedAudio(track.filePath)),
    ]);
    if (baseline.status === "rejected") {
        return excluded(
            track.id,
            providerFailureReason("baseline", baseline.reason),
        );
    }
    if (candidate.status === "rejected") {
        return excluded(
            track.id,
            providerFailureReason("candidate", candidate.reason),
        );
    }
    try {
        assertProviderVector(baseline.value, spaces.baseline.dim);
    } catch {
        return excluded(track.id, "baseline embedding vector is invalid");
    }
    try {
        assertProviderVector(candidate.value, spaces.candidate.dim);
    } catch {
        return excluded(track.id, "candidate embedding vector is invalid");
    }
    return {
        kind: "included",
        pair: { trackId: track.id, a: baseline.value, b: candidate.value },
    };
}

async function embedTracks(
    tracks: readonly ProviderFidelityTrack[],
    spaces: ProviderSpaces,
    dependencies: ValidationDependencies,
): Promise<{ pairs: EmbeddedPair[]; exclusions: ProviderFidelityExclusion[] }> {
    const limit = pLimit(PROVIDER_CONCURRENCY);
    let processed = 0;
    const tasks = tracks.map(async (track) => {
        const result = await embedTrackPair(track, spaces, dependencies, limit);
        processed += 1;
        if (processed % 50 === 0)
            dependencies.onProgress(processed, tracks.length);
        if (result.kind === "excluded")
            dependencies.onExclusion(result.exclusion);
        return result;
    });
    const results = await Promise.all(tasks);
    return {
        pairs: results.flatMap((result) =>
            result.kind === "included" ? [result.pair] : [],
        ),
        exclusions: results.flatMap((result) =>
            result.kind === "excluded" ? [result.exclusion] : [],
        ),
    };
}

function validatedTextEmbedder(
    client: VibeProviderClient,
    space: ProviderSpace,
): (query: string) => Promise<readonly number[]> {
    return async (query) => {
        const vector = await client.embedText(query);
        assertProviderVector(vector, space.dim);
        return vector;
    };
}

function requireMeasurementSize(
    valid: number,
    k: number,
    excluded: number,
): void {
    const context = `${valid} valid tracks after ${excluded} exclusions`;
    if (valid < 2)
        throw new RangeError(
            `at least two valid tracks are required (${context})`,
        );
    if (k >= valid)
        throw new RangeError(
            `k must be less than the valid track count (${context})`,
        );
}

async function loadProviderSpaces(
    dependencies: ValidationDependencies,
): Promise<ProviderSpaces> {
    const [baseline, candidate] = await Promise.all([
        dependencies.baseline.fetchSpace(),
        dependencies.candidate.fetchSpace(),
    ]);
    if (!baseline.textTower || !candidate.textTower) {
        throw new TypeError("both providers must declare a text tower");
    }
    if (baseline.dim !== candidate.dim) {
        // Differing dimensions answer the gate trivially; fail before the
        // long embedding pass instead of crashing inside the math.
        throw new TypeError(
            `provider dimensions differ (baseline ${baseline.dim}, candidate ` +
                `${candidate.dim}); the candidate requires a distinct space`,
        );
    }
    return { baseline, candidate };
}

async function measurePairs(
    pairs: readonly EmbeddedPair[],
    spaces: ProviderSpaces,
    dependencies: ValidationDependencies,
    k: number,
): Promise<FidelityMeasurements> {
    const vectorsA = pairs.map(({ trackId, a }) => ({ trackId, vector: a }));
    const vectorsB = pairs.map(({ trackId, b }) => ({ trackId, vector: b }));
    const audio = compareAudioEmbeddings(pairs);
    const topK = topKOverlap(vectorsA, vectorsB, k);
    const textQuery = await textQueryOverlap(
        dependencies.queries,
        validatedTextEmbedder(dependencies.baseline, spaces.baseline),
        validatedTextEmbedder(dependencies.candidate, spaces.candidate),
        vectorsA,
        k,
    );
    return { audio, topK, textQuery };
}

function buildReport(
    options: ValidationOptions,
    spaces: ProviderSpaces,
    selected: number,
    embedded: {
        pairs: EmbeddedPair[];
        exclusions: ProviderFidelityExclusion[];
    },
    measurements: FidelityMeasurements,
    durationMs: number,
): ProviderFidelityReport {
    const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
    const summaries = {
        audio: measurements.audio.summary,
        topK: measurements.topK.summary,
        textQuery: measurements.textQuery.summary,
    };
    const exclusionRate =
        selected === 0 ? 0 : embedded.exclusions.length / selected;
    return {
        providers: spaces,
        thresholds,
        sample: {
            requested: options.sample,
            selected,
            valid: embedded.pairs.length,
        },
        k: options.k,
        durationMs: Math.max(0, durationMs),
        exclusionRate,
        exclusionPolicyPassed: exclusionRate <= MAX_EXCLUSION_RATE,
        exclusions: embedded.exclusions,
        ...measurements,
        gate: evaluateGate(summaries, thresholds),
    };
}

/** Measure both providers without registering spaces or mutating library data. */
export async function runProviderFidelityValidation(
    options: ValidationOptions,
    dependencies: ValidationDependencies,
): Promise<ProviderFidelityReport> {
    requireSampleBounds(options.sample);
    requireKBounds(options.k, options.sample);
    const startedAt = dependencies.nowMs();
    const tracks = await dependencies.sampleTracks(options.sample);
    if (tracks.length > options.sample)
        throw new RangeError("sampler exceeded requested size");
    const spaces = await loadProviderSpaces(dependencies);
    const embedded = await embedTracks(tracks, spaces, dependencies);
    requireMeasurementSize(
        embedded.pairs.length,
        options.k,
        embedded.exclusions.length,
    );
    const measurements = await measurePairs(
        embedded.pairs,
        spaces,
        dependencies,
        options.k,
    );
    const report = buildReport(
        options,
        spaces,
        tracks.length,
        embedded,
        measurements,
        dependencies.nowMs() - startedAt,
    );
    if (report.exclusionRate > MAX_EXCLUSION_RATE)
        throw new ProviderFidelityExclusionError(report);
    return report;
}

function formatMetric(value: number): string {
    if (!Number.isFinite(value))
        throw new TypeError("report metric must be finite");
    return value.toFixed(6);
}

function escapeCell(value: string): string {
    return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function providerRow(label: string, space: ProviderSpace): string {
    const identity = `${space.family} / ${space.checkpointHash} / ${space.dim}`;
    const preprocessing = JSON.stringify(space.preprocessing);
    return `| ${label} | ${escapeCell(identity)} | ${space.sampleRateHz} | ${escapeCell(preprocessing)} | ${escapeCell(space.revision)} | ${space.textTower} |`;
}

interface MetricTableSummary {
    mean: number;
    median: number;
    p05: number;
    min?: number;
}

function metricTable(summary: MetricTableSummary): string {
    const values: Array<[string, number]> = [
        ["mean", summary.mean],
        ["median", summary.median],
        ["p05", summary.p05],
    ];
    if (summary.min !== undefined) values.push(["min", summary.min]);
    return values
        .map(([metric, value]) => `| ${metric} | ${formatMetric(value)} |`)
        .join("\n");
}

function renderOverview(report: ProviderFidelityReport): string {
    return `# Provider fidelity validation

- Verdict: \`${report.gate.verdict}\`
- Exclusion policy: ${report.exclusionPolicyPassed ? "pass" : "fail"}
- Sample: ${report.sample.valid} valid of ${report.sample.selected} selected (${report.sample.requested} requested)
- k: ${report.k}
- Duration: ${report.durationMs} ms
- Exclusions: ${report.exclusions.length} (${formatMetric(report.exclusionRate)})`;
}

function renderProviders(report: ProviderFidelityReport): string {
    return `## Provider identities

| Provider | Identity tuple (family / checkpoint / dim) | Sample rate | Preprocessing | Revision | Text tower |
| --- | --- | ---: | --- | --- | --- |
${providerRow("Baseline", report.providers.baseline)}
${providerRow("Candidate", report.providers.candidate)}`;
}

function renderThresholds(report: ProviderFidelityReport): string {
    return `## Thresholds

| Metric | Inclusive threshold | Observed |
| --- | ---: | ---: |
| Median cosine | >= ${formatMetric(report.thresholds.medianCosine)} | ${formatMetric(report.audio.summary.median)} |
| Mean top-${report.k} overlap | >= ${formatMetric(report.thresholds.meanTopKOverlap)} | ${formatMetric(report.topK.summary.mean)} |`;
}

function renderMeasurement(
    heading: string,
    summary: MetricTableSummary,
): string {
    return `## ${heading}

| Metric | Value |
| --- | ---: |
${metricTable(summary)}`;
}

function renderReasons(report: ProviderFidelityReport): string {
    const reasons =
        report.gate.reasons.length === 0
            ? "All adoption thresholds passed."
            : report.gate.reasons
                  .map((reason) => `- ${escapeCell(reason)}`)
                  .join("\n");
    return `## Reasons

${reasons}`;
}

function renderExclusions(report: ProviderFidelityReport): string {
    if (report.exclusions.length === 0) return "## Exclusions\n\nNone.";
    const rows = report.exclusions.map(
        (item) =>
            `| ${escapeCell(item.trackId)} | ${escapeCell(item.reason)} |`,
    );
    return `## Exclusions

| Track ID | Reason |
| --- | --- |
${rows.join("\n")}`;
}

/** Render the operator-facing Markdown report and its three metric tables. */
export function renderProviderFidelityMarkdown(
    report: ProviderFidelityReport,
): string {
    return (
        [
            renderOverview(report),
            renderProviders(report),
            renderThresholds(report),
            renderMeasurement("Per-track cosine", report.audio.summary),
            renderMeasurement("Top-k neighbor overlap", report.topK.summary),
            renderMeasurement(
                "Text-query result overlap",
                report.textQuery.summary,
            ),
            renderReasons(report),
            renderExclusions(report),
        ].join("\n\n") + "\n"
    );
}

/** Derive the JSON report path adjacent to the requested Markdown output. */
export function providerFidelityJsonPath(markdownPath: string): string {
    if (!markdownPath) throw new TypeError("output path must not be empty");
    const extension = extname(markdownPath);
    if (extension.toLowerCase() === ".json") {
        throw new TypeError(
            "output path must not end in .json; the JSON report is written beside the Markdown report",
        );
    }
    return extension
        ? `${markdownPath.slice(0, -extension.length)}.json`
        : `${markdownPath}.json`;
}
