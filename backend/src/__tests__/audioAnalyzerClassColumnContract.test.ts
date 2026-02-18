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

describe("audio analyzer class-column mapping contract", () => {
    it("uses per-model positive column mapping for MusicNN classification heads", () => {
        const analyzerPath = path.resolve(
            __dirname,
            "../../../services/audio-analyzer/analyzer.py"
        );
        const source = fs.readFileSync(analyzerPath, "utf8");
        const mlSection = extractSection(
            source,
            "def _extract_ml_features",
            "def _apply_standard_estimates"
        );

        expect(mlSection).toContain("positive_col =");
        expect(mlSection).toContain("'mood_aggressive'");
        expect(mlSection).toContain("'mood_happy'");
        expect(mlSection).toContain("'mood_acoustic'");
        expect(mlSection).toContain("'mood_electronic'");
        expect(mlSection).toContain("'danceability'");
        expect(mlSection).toContain("'voice_instrumental'");
        expect(mlSection).toContain("positive_probs = preds[:, positive_col]");
    });
});
