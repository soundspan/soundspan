import {
    buildScanReconcileCandidateQuery,
    buildScanReconcilePatterns,
    chunkScanReconcilePatterns,
    SCAN_RECONCILE_CANDIDATE_FETCH_LIMIT,
    SCAN_RECONCILE_PATTERN_CHUNK_SIZE,
} from "../scanReconcileQuery";

describe("scan reconciliation query construction", () => {
    it("escapes LIKE metacharacters and preserves contains matching", () => {
        expect(buildScanReconcilePatterns(["100%_\\ Mix", "plain"])).toEqual([
            "%100\\%\\_\\\\ Mix%",
            "%plain%",
        ]);
    });

    it("chunks patterns at the bounded query size", () => {
        const patterns = Array.from(
            { length: SCAN_RECONCILE_PATTERN_CHUNK_SIZE * 2 + 5 },
            (_unused, index) => `%artist-${index}%`,
        );

        expect(
            chunkScanReconcilePatterns(patterns).map((chunk) => chunk.length),
        ).toEqual([
            SCAN_RECONCILE_PATTERN_CHUNK_SIZE,
            SCAN_RECONCILE_PATTERN_CHUNK_SIZE,
            5,
        ]);
    });

    it("binds one pattern array and the candidate sentinel limit", () => {
        const patterns = ["%first%", "%second%"];
        const query = buildScanReconcileCandidateQuery(patterns);

        expect(query.text).toContain("ar.name ILIKE ANY($1::text[])");
        expect(query.text).toContain('ORDER BY al."updatedAt" DESC, al.id ASC');
        expect(query.text).toContain("LIMIT $2");
        expect(query.text).not.toContain(" OR ");
        expect(query.values).toEqual([
            patterns,
            SCAN_RECONCILE_CANDIDATE_FETCH_LIMIT,
        ]);
    });

    it("rejects empty and oversized pattern chunks", () => {
        expect(() => buildScanReconcileCandidateQuery([])).toThrow(RangeError);
        expect(() =>
            buildScanReconcileCandidateQuery(
                Array.from(
                    { length: SCAN_RECONCILE_PATTERN_CHUNK_SIZE + 1 },
                    () => "%artist%",
                ),
            ),
        ).toThrow(RangeError);
    });
});
