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

describe("audio analyzer stale failure resolution contract", () => {
    it("resolves unresolved audio enrichment failures on successful save", () => {
        const analyzerPath = path.resolve(
            __dirname,
            "../../../services/audio-analyzer/analyzer.py"
        );
        const source = fs.readFileSync(analyzerPath, "utf8");
        const resolveFailuresSqlSection = extractSection(
            source,
            "_RESOLVE_AUDIO_FAILURES_SQL = ",
            "def _analysis_result_values"
        );
        const saveResultsSection = extractSection(
            source,
            "def _save_results",
            "def _save_failed"
        );

        expect(resolveFailuresSqlSection).toContain(`UPDATE "EnrichmentFailure"`);
        expect(resolveFailuresSqlSection).toContain(`"entityType" = 'audio'`);
        expect(resolveFailuresSqlSection).toContain(`"entityId" = %s`);
        expect(resolveFailuresSqlSection).toContain("resolved = true");
        expect(resolveFailuresSqlSection).toContain(`resolved = false`);
        expect(saveResultsSection).toContain("_RESOLVE_AUDIO_FAILURES_SQL");
    });
});
