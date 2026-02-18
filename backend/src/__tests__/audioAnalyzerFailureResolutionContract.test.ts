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
        const saveResultsSection = extractSection(
            source,
            "def _save_results",
            "def _save_failed"
        );

        expect(saveResultsSection).toContain(`UPDATE "EnrichmentFailure"`);
        expect(saveResultsSection).toContain(`"entityType" = 'audio'`);
        expect(saveResultsSection).toContain(`"entityId" = %s`);
        expect(saveResultsSection).toContain("resolved = true");
        expect(saveResultsSection).toContain(`resolved = false`);
    });
});
