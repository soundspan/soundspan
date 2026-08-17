import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Prisma } from "@prisma/client";
import { config } from "../src/config";
import vocabulary from "../src/config/vibe-vocabulary.json";
import {
    createEligibleTrackSampler,
    parseProviderFidelityArgs,
    ProviderFidelityExclusionError,
    providerFidelityJsonPath,
    renderProviderFidelityMarkdown,
    runProviderFidelityValidation,
    type ProviderFidelityReport,
} from "../src/services/providerFidelityValidation";
import { createProviderClient } from "../src/services/vibeProvider";
import { prisma } from "../src/utils/db";
import { logger } from "../src/utils/logger";

const log = logger.child("ProviderFidelityValidation");
const usage = `Usage: npx tsx scripts/validateProviderFidelity.ts \\
  --candidate-url <url> [--baseline-url <url>] [--sample <2-2000>] \\
  [--k <neighbors>] [--output <report.md>]`;

const sampleTracks = createEligibleTrackSampler({
    track: {
        findMany: async (args) =>
            (await prisma.track.findMany(
                args as Prisma.TrackFindManyArgs,
            )) as Array<{ id: string; filePath: string | null }>,
    },
});

async function writeReport(
    report: ProviderFidelityReport,
    markdownPath: string,
): Promise<void> {
    const jsonPath = providerFidelityJsonPath(markdownPath);
    await mkdir(dirname(resolve(markdownPath)), { recursive: true });
    await Promise.all([
        writeFile(markdownPath, renderProviderFidelityMarkdown(report), "utf8"),
        writeFile(jsonPath, `${JSON.stringify(report, null, 4)}\n`, "utf8"),
    ]);
    log.info("Wrote provider fidelity reports", { markdownPath, jsonPath });
}

async function validate(): Promise<void> {
    const options = parseProviderFidelityArgs(
        process.argv.slice(2),
        config.vibeProviderUrl,
    );
    const dependencies = {
        sampleTracks,
        baseline: createProviderClient(options.baselineUrl),
        candidate: createProviderClient(options.candidateUrl),
        queries: Object.keys(vocabulary.terms),
        nowMs: Date.now,
        onProgress: (processed: number, total: number) =>
            log.info("Embedded track sample", { processed, total }),
        onExclusion: (exclusion: { trackId: string; reason: string }) =>
            log.warn(
                "Excluded track from provider fidelity statistics",
                exclusion,
            ),
    };
    // Surface an invalid output path before the long embedding pass.
    providerFidelityJsonPath(options.outputPath);
    try {
        const report = await runProviderFidelityValidation(
            options,
            dependencies,
        );
        await writeReport(report, options.outputPath);
    } catch (error) {
        if (error instanceof ProviderFidelityExclusionError) {
            // A failed report write must not replace the validation error.
            await writeReport(error.report, options.outputPath).catch(
                (writeError) =>
                    log.error("Failed to write exclusion report", writeError),
            );
        }
        throw error;
    } finally {
        await prisma.$disconnect();
    }
}

if (process.argv.includes("--help")) {
    console.log(usage);
} else {
    validate().catch((error: unknown) => {
        log.error("Provider fidelity validation failed", { error });
        process.exitCode = 1;
    });
}
