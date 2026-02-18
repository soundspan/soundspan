import fs from "fs";
import path from "path";
import { prisma } from "../src/utils/db";

const FIELD_SPECS = [
    { key: "danceability", label: "danceability" },
    { key: "danceabilityMl", label: "danceabilityMl" },
    { key: "valence", label: "valence" },
    { key: "arousal", label: "arousal" },
    { key: "moodHappy", label: "moodHappy" },
    { key: "moodSad", label: "moodSad" },
    { key: "moodRelaxed", label: "moodRelaxed" },
    { key: "moodAggressive", label: "moodAggressive" },
    { key: "moodParty", label: "moodParty" },
    { key: "moodAcoustic", label: "moodAcoustic" },
    { key: "moodElectronic", label: "moodElectronic" },
] as const;

type FieldKey = (typeof FIELD_SPECS)[number]["key"];

type EnhancedTrackRow = Record<FieldKey, number | null>;

type NumericSummary = {
    nonNullCount: number;
    nullCount: number;
    nullRate: number;
    outOfRangeCount: number;
    outOfRangeRate: number;
    min: number | null;
    max: number | null;
    mean: number | null;
    median: number | null;
    p95: number | null;
};

type DanceabilityDeltaSummary = {
    overlapCount: number;
    overlapRate: number;
    mlOnlyCount: number;
    baseOnlyCount: number;
    medianAbsDelta: number | null;
    p95AbsDelta: number | null;
    maxAbsDelta: number | null;
    meanSignedDelta: number | null;
};

function round(value: number, digits = 4): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
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

function mean(values: number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatPercent(rate: number): string {
    return `${round(rate * 100, 2)}%`;
}

function formatNumber(value: number | null, digits = 4): string {
    if (value === null) return "-";
    return String(round(value, digits));
}

function summarizeField(rows: EnhancedTrackRow[], key: FieldKey): NumericSummary {
    const values: number[] = [];
    let nullCount = 0;
    let outOfRangeCount = 0;

    for (const row of rows) {
        const value = row[key];
        if (value === null || value === undefined) {
            nullCount += 1;
            continue;
        }

        values.push(value);
        if (value < 0 || value > 1) {
            outOfRangeCount += 1;
        }
    }

    const total = rows.length;
    const nonNullCount = values.length;

    return {
        nonNullCount,
        nullCount,
        nullRate: total > 0 ? nullCount / total : 0,
        outOfRangeCount,
        outOfRangeRate: nonNullCount > 0 ? outOfRangeCount / nonNullCount : 0,
        min: values.length > 0 ? Math.min(...values) : null,
        max: values.length > 0 ? Math.max(...values) : null,
        mean: mean(values),
        median: quantile(values, 0.5),
        p95: quantile(values, 0.95),
    };
}

function summarizeDanceabilityDelta(rows: EnhancedTrackRow[]): DanceabilityDeltaSummary {
    const absDeltas: number[] = [];
    const signedDeltas: number[] = [];
    let overlapCount = 0;
    let mlOnlyCount = 0;
    let baseOnlyCount = 0;

    for (const row of rows) {
        const base = row.danceability;
        const ml = row.danceabilityMl;

        if (base !== null && ml !== null) {
            overlapCount += 1;
            const signed = ml - base;
            signedDeltas.push(signed);
            absDeltas.push(Math.abs(signed));
            continue;
        }

        if (base === null && ml !== null) {
            mlOnlyCount += 1;
            continue;
        }

        if (base !== null && ml === null) {
            baseOnlyCount += 1;
        }
    }

    const total = rows.length;

    return {
        overlapCount,
        overlapRate: total > 0 ? overlapCount / total : 0,
        mlOnlyCount,
        baseOnlyCount,
        medianAbsDelta: quantile(absDeltas, 0.5),
        p95AbsDelta: quantile(absDeltas, 0.95),
        maxAbsDelta: absDeltas.length > 0 ? Math.max(...absDeltas) : null,
        meanSignedDelta: mean(signedDeltas),
    };
}

function buildReport(params: {
    generatedAt: string;
    totalTracks: number;
    statusCounts: Map<string, number>;
    completedModeCounts: Map<string, number>;
    enhancedRows: EnhancedTrackRow[];
    fieldSummaries: Map<FieldKey, NumericSummary>;
    danceabilityDelta: DanceabilityDeltaSummary;
}): string {
    const {
        generatedAt,
        totalTracks,
        statusCounts,
        completedModeCounts,
        enhancedRows,
        fieldSummaries,
        danceabilityDelta,
    } = params;

    const lines: string[] = [];
    lines.push("# Analyzer Enhanced-Mode Baseline Report");
    lines.push("");
    lines.push(`- Generated at: ${generatedAt}`);
    lines.push("- Runner: `backend/scripts/measure-analyzer-enhanced-baseline.ts`");
    lines.push("");
    lines.push("## Scope");
    lines.push("");
    lines.push(
        "- Baseline evidence for enhanced-mode output fields: `danceability`, `danceabilityMl`, `mood*`, `valence`, `arousal`.",
    );
    lines.push(
        "- Snapshot uses current database state and focuses on tracks with `analysisStatus='completed'` and `analysisMode='enhanced'`.",
    );
    lines.push("");
    lines.push("## Status Snapshot");
    lines.push("");
    lines.push(`- Total tracks: ${totalTracks}`);
    lines.push(`- Completed tracks: ${statusCounts.get("completed") ?? 0}`);
    lines.push(`- Processing tracks: ${statusCounts.get("processing") ?? 0}`);
    lines.push(`- Pending tracks: ${statusCounts.get("pending") ?? 0}`);
    lines.push(`- Failed tracks: ${statusCounts.get("failed") ?? 0}`);
    lines.push("");
    lines.push("## Completed Mode Breakdown");
    lines.push("");
    lines.push("| analysisMode | Count | Share of completed |");
    lines.push("|---|---:|---:|");

    const completedTotal = statusCounts.get("completed") ?? 0;
    for (const [modeKey, count] of completedModeCounts.entries()) {
        const modeLabel = modeKey === "null" ? "(null)" : modeKey;
        const share = completedTotal > 0 ? count / completedTotal : 0;
        lines.push(`| ${modeLabel} | ${count} | ${formatPercent(share)} |`);
    }

    lines.push("");
    lines.push("## Enhanced Field Summary");
    lines.push("");
    lines.push(`- Enhanced completed tracks sampled: ${enhancedRows.length}`);
    lines.push("");
    lines.push(
        "| Field | Non-null | Null | Null rate | Out-of-range (<0 or >1) | Min | Max | Mean | Median | P95 |",
    );
    lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");

    for (const spec of FIELD_SPECS) {
        const summary = fieldSummaries.get(spec.key);
        if (!summary) continue;

        lines.push(
            `| ${spec.label} | ${summary.nonNullCount} | ${summary.nullCount} | ${formatPercent(summary.nullRate)} | ${summary.outOfRangeCount} (${formatPercent(summary.outOfRangeRate)}) | ${formatNumber(summary.min)} | ${formatNumber(summary.max)} | ${formatNumber(summary.mean)} | ${formatNumber(summary.median)} | ${formatNumber(summary.p95)} |`,
        );
    }

    lines.push("");
    lines.push("## Danceability Alignment (Enhanced)");
    lines.push("");
    lines.push(
        "- `danceability` and `danceabilityMl` overlap indicates how much of enhanced output currently has both values available.",
    );
    lines.push(
        `- Overlap: ${danceabilityDelta.overlapCount} (${formatPercent(danceabilityDelta.overlapRate)})`,
    );
    lines.push(`- ML-only rows: ${danceabilityDelta.mlOnlyCount}`);
    lines.push(`- Base-only rows: ${danceabilityDelta.baseOnlyCount}`);
    lines.push(`- Median abs delta (` + "`|danceabilityMl - danceability|`" + `): ${formatNumber(danceabilityDelta.medianAbsDelta)}`);
    lines.push(`- P95 abs delta: ${formatNumber(danceabilityDelta.p95AbsDelta)}`);
    lines.push(`- Max abs delta: ${formatNumber(danceabilityDelta.maxAbsDelta)}`);
    lines.push(`- Mean signed delta (` + "`danceabilityMl - danceability`" + `): ${formatNumber(danceabilityDelta.meanSignedDelta)}`);

    lines.push("");
    lines.push("## Baseline Notes");
    lines.push("");
    lines.push(
        "- This report is intended to satisfy Task 0.2 baseline capture before analyzer Phase 4 changes.",
    );
    lines.push(
        "- Use this file as the pre-change comparator when evaluating Task 4.1 and later analyzer deltas.",
    );

    return lines.join("\n");
}

async function runMeasurement(): Promise<void> {
    const generatedAt = new Date().toISOString();

    const statusGroups = await prisma.track.groupBy({
        by: ["analysisStatus"],
        _count: { _all: true },
    });
    const statusCounts = new Map<string, number>(
        statusGroups.map((row) => [row.analysisStatus, row._count._all]),
    );

    const totalTracks = await prisma.track.count();

    const completedModeGroups = await prisma.track.groupBy({
        by: ["analysisMode"],
        where: { analysisStatus: "completed" },
        _count: { _all: true },
    });
    const completedModeCounts = new Map<string, number>(
        completedModeGroups.map((row) => [row.analysisMode ?? "null", row._count._all]),
    );

    const enhancedRows = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            analysisMode: "enhanced",
        },
        select: {
            danceability: true,
            danceabilityMl: true,
            valence: true,
            arousal: true,
            moodHappy: true,
            moodSad: true,
            moodRelaxed: true,
            moodAggressive: true,
            moodParty: true,
            moodAcoustic: true,
            moodElectronic: true,
        },
    });

    const fieldSummaries = new Map<FieldKey, NumericSummary>();
    for (const spec of FIELD_SPECS) {
        fieldSummaries.set(spec.key, summarizeField(enhancedRows, spec.key));
    }

    const danceabilityDelta = summarizeDanceabilityDelta(enhancedRows);

    const report = buildReport({
        generatedAt,
        totalTracks,
        statusCounts,
        completedModeCounts,
        enhancedRows,
        fieldSummaries,
        danceabilityDelta,
    });

    const reportPath = path.resolve(
        process.cwd(),
        "..",
        "plans",
        "current",
        "fjordnode-feature-port",
        "ANALYZER_ENHANCED_BASELINE_REPORT.md",
    );

    fs.writeFileSync(reportPath, report, "utf8");
    console.log(`Analyzer baseline report written: ${reportPath}`);
}

runMeasurement()
    .catch((error) => {
        console.error("Analyzer baseline measurement failed:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
