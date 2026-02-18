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

describe("audio analyzer process-pool recovery contract", () => {
    const analyzerPath = path.resolve(
        __dirname,
        "../../../services/audio-analyzer/analyzer.py"
    );

    it("re-queues tracks instead of failing them when worker processes crash", () => {
        const source = fs.readFileSync(analyzerPath, "utf8");
        const processSection = extractSection(
            source,
            "def _process_tracks_parallel",
            "def _save_results"
        );

        expect(processSection).toContain("self._is_pool_crash_error(e)");
        expect(processSection).toContain("self._requeue_tracks_for_retry(");
        expect(processSection).toContain("raise BrokenProcessPool(str(e))");
    });

    it("resets track status back to pending without burning retry counts", () => {
        const source = fs.readFileSync(analyzerPath, "utf8");
        const requeueSection = extractSection(
            source,
            "def _requeue_tracks_for_retry",
            "def _cleanup_stale_processing"
        );

        expect(requeueSection).toContain(`"analysisStatus" = 'pending'`);
        expect(requeueSection).toContain(`"analysisStatus" = 'processing'`);
        expect(requeueSection).toContain("pipe.rpush(");
    });

    it("avoids direct tensorflow import in worker model-loader path", () => {
        const source = fs.readFileSync(analyzerPath, "utf8");
        const loaderSection = extractSection(
            source,
            "def _load_ml_models",
            "def load_audio"
        );

        expect(loaderSection).not.toContain("import tensorflow as tf");
        expect(loaderSection).toContain("TensorflowPredictMusiCNN");
        expect(loaderSection).toContain("TensorflowPredict2D");
    });
});
