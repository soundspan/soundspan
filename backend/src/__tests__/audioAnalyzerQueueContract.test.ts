import fs from "fs";
import path from "path";

function extractSection(source: string, startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    if (start === -1) {
        throw new Error(`Missing start marker: ${startMarker}`);
    }
    const end = source.indexOf(endMarker, start);
    if (end === -1) {
        throw new Error(`Missing end marker: ${endMarker}`);
    }
    return source.slice(start, end);
}

describe("audio analyzer queue contract", () => {
    it("accepts both pending and pre-claimed processing tracks in batch guard", () => {
        const analyzerPath = path.resolve(
            __dirname,
            "../../../services/audio-analyzer/analyzer.py"
        );
        const analyzerSource = fs.readFileSync(analyzerPath, "utf8");

        const processBatchSection = extractSection(
            analyzerSource,
            "def _process_tracks_parallel",
            "def _save_results"
        );

        expect(processBatchSection).toContain(
            `AND "analysisStatus" IN ('pending', 'processing')`
        );
        expect(processBatchSection).not.toContain(
            `AND "analysisStatus" = 'pending'`
        );
    });

    it("keeps producer/consumer queue-state contract aligned", () => {
        const analyzerPath = path.resolve(
            __dirname,
            "../../../services/audio-analyzer/analyzer.py"
        );
        const enrichmentWorkerPath = path.resolve(
            __dirname,
            "../workers/unifiedEnrichment.ts"
        );

        const analyzerSource = fs.readFileSync(analyzerPath, "utf8");
        const enrichmentSource = fs.readFileSync(enrichmentWorkerPath, "utf8");

        const reconciliationSection = extractSection(
            analyzerSource,
            "def _run_db_reconciliation",
            "def start"
        );
        const queueAudioSection = extractSection(
            enrichmentSource,
            "async function queueAudioAnalysis",
            "async function queueVibeEmbeddings"
        );
        const processBatchSection = extractSection(
            analyzerSource,
            "def _process_tracks_parallel",
            "def _save_results"
        );

        const producersPreclaimProcessing =
            reconciliationSection.includes(`SET "analysisStatus" = 'processing'`) ||
            queueAudioSection.includes(`analysisStatus: "processing"`);
        const consumerAcceptsProcessing = processBatchSection.includes(
            `AND "analysisStatus" IN ('pending', 'processing')`
        );

        expect(producersPreclaimProcessing).toBe(true);
        expect(consumerAcceptsProcessing).toBe(true);
    });
});

