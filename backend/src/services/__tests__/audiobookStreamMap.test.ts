import {
    buildAudiobookStreamMap,
    resolveAudiobookRange,
} from "../audiobookStreamMap";

describe("audiobook stream map", () => {
    const map = buildAudiobookStreamMap([
        { index: 0, byteLength: 5 },
        { index: 1, byteLength: 10 },
        { index: 2, byteLength: 15 },
    ]);

    it("maps the full three-file byte range", () => {
        expect(map.totalBytes()).toBe(30);
        expect(map.resolveRange(0, 29)).toEqual([
            { fileIndex: 0, fileStartByte: 0, fileEndByte: 4 },
            { fileIndex: 1, fileStartByte: 0, fileEndByte: 9 },
            { fileIndex: 2, fileStartByte: 0, fileEndByte: 14 },
        ]);
    });

    it("maps a range entirely inside the second file", () => {
        expect(map.resolveRange(7, 11)).toEqual([
            { fileIndex: 1, fileStartByte: 2, fileEndByte: 6 },
        ]);
    });

    it("maps a range spanning the first through third files", () => {
        expect(map.resolveRange(3, 20)).toEqual([
            { fileIndex: 0, fileStartByte: 3, fileEndByte: 4 },
            { fileIndex: 1, fileStartByte: 0, fileEndByte: 9 },
            { fileIndex: 2, fileStartByte: 0, fileEndByte: 5 },
        ]);
    });

    it("resolves a suffix range", () => {
        expect(resolveAudiobookRange("bytes=-6", map)).toEqual({
            kind: "partial",
            startByte: 24,
            endByte: 29,
            slices: [{ fileIndex: 2, fileStartByte: 9, fileEndByte: 14 }],
        });
    });

    it("resolves an open-ended range", () => {
        expect(resolveAudiobookRange("bytes=12-", map)).toEqual({
            kind: "partial",
            startByte: 12,
            endByte: 29,
            slices: [
                { fileIndex: 1, fileStartByte: 7, fileEndByte: 9 },
                { fileIndex: 2, fileStartByte: 0, fileEndByte: 14 },
            ],
        });
    });

    it("rejects an out-of-range request", () => {
        expect(resolveAudiobookRange("bytes=30-", map)).toEqual({
            kind: "unsatisfiable",
            totalBytes: 30,
        });
    });

    it("preserves the single-file degenerate case", () => {
        const singleFileMap = buildAudiobookStreamMap([
            { index: 7, byteLength: 10 },
        ]);

        expect(singleFileMap.totalBytes()).toBe(10);
        expect(singleFileMap.resolveRange(2, 5)).toEqual([
            { fileIndex: 7, fileStartByte: 2, fileEndByte: 5 },
        ]);
    });

    it("skips zero-length files without shifting later file indexes", () => {
        const zeroLengthMap = buildAudiobookStreamMap([
            { index: 0, byteLength: 5 },
            { index: 1, byteLength: 0 },
            { index: 2, byteLength: 5 },
        ]);

        expect(zeroLengthMap.totalBytes()).toBe(10);
        expect(zeroLengthMap.resolveRange(3, 7)).toEqual([
            { fileIndex: 0, fileStartByte: 3, fileEndByte: 4 },
            { fileIndex: 2, fileStartByte: 0, fileEndByte: 2 },
        ]);
    });
});
