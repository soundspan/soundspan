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

describe("clap text embed runtime recovery contract", () => {
    const analyzerPath = path.resolve(
        __dirname,
        "../../../services/audio-analyzer-clap/analyzer.py"
    );

    it("self-heals missing Redis stream groups after runtime resets", () => {
        const source = fs.readFileSync(analyzerPath, "utf8");
        const startSection = extractSection(
            source,
            "def start(self):",
            "def _ensure_consumer_group"
        );

        expect(source).toContain("def _is_no_group_error");
        expect(startSection).toContain("if self._is_no_group_error(e):");
        expect(startSection).toContain("self._ensure_consumer_group()");
    });

    it("handles NOGROUP during stale-claim and ack publishing paths", () => {
        const source = fs.readFileSync(analyzerPath, "utf8");
        const claimSection = extractSection(
            source,
            "def _claim_stale_messages",
            "def _publish_response_and_ack"
        );
        const publishSection = extractSection(
            source,
            "def _publish_response_and_ack",
            "def _handle_message"
        );

        expect(claimSection).toContain("if self._is_no_group_error(e):");
        expect(claimSection).toContain("self._ensure_consumer_group()");
        expect(publishSection).toContain("if not self._is_no_group_error(e):");
        expect(publishSection).toContain("publishing response without ack");
    });
});
