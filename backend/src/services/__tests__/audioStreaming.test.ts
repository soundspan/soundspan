import { parseRangeHeader } from "../../utils/rangeParser";

const FILE_SIZE = 10000;

describe("parseRangeHeader", () => {
    describe("standard ranges", () => {
        it("parses bytes=0-499", () => {
            const result = parseRangeHeader("bytes=0-499", FILE_SIZE);
            expect(result).toEqual({ ok: true, start: 0, end: 499 });
        });

        it("parses bytes=9000-9999", () => {
            const result = parseRangeHeader("bytes=9000-9999", FILE_SIZE);
            expect(result).toEqual({ ok: true, start: 9000, end: 9999 });
        });
    });

    describe("open-ended ranges", () => {
        it("parses bytes=500- as 500 to end", () => {
            const result = parseRangeHeader("bytes=500-", FILE_SIZE);
            expect(result).toEqual({ ok: true, start: 500, end: 9999 });
        });

        it("parses bytes=0- as entire file", () => {
            const result = parseRangeHeader("bytes=0-", FILE_SIZE);
            expect(result).toEqual({ ok: true, start: 0, end: 9999 });
        });
    });

    describe("suffix ranges (Firefox/Safari metadata probing)", () => {
        it("parses bytes=-500 as last 500 bytes", () => {
            const result = parseRangeHeader("bytes=-500", FILE_SIZE);
            expect(result).toEqual({ ok: true, start: 9500, end: 9999 });
        });

        it("clamps suffix larger than file to start=0", () => {
            const result = parseRangeHeader("bytes=-12345", FILE_SIZE);
            expect(result).toEqual({ ok: true, start: 0, end: 9999 });
        });

        it("handles suffix equal to file size", () => {
            const result = parseRangeHeader("bytes=-10000", FILE_SIZE);
            expect(result).toEqual({ ok: true, start: 0, end: 9999 });
        });
    });

    describe("zero suffix rejection", () => {
        it("rejects bytes=-0 with 416", () => {
            const result = parseRangeHeader("bytes=-0", FILE_SIZE);
            expect(result).toEqual({ ok: false, status: 416 });
        });
    });

    describe("RFC 7233 end clamping", () => {
        it("clamps end beyond file size to fileSize-1", () => {
            const result = parseRangeHeader("bytes=0-99999", FILE_SIZE);
            expect(result).toEqual({ ok: true, start: 0, end: 9999 });
        });

        it("clamps end beyond file size with non-zero start", () => {
            const result = parseRangeHeader("bytes=5000-50000", FILE_SIZE);
            expect(result).toEqual({ ok: true, start: 5000, end: 9999 });
        });
    });

    describe("invalid ranges", () => {
        it("rejects start >= fileSize", () => {
            const result = parseRangeHeader("bytes=10000-10500", FILE_SIZE);
            expect(result).toEqual({ ok: false, status: 416 });
        });

        it("rejects start beyond fileSize", () => {
            const result = parseRangeHeader("bytes=20000-", FILE_SIZE);
            expect(result).toEqual({ ok: false, status: 416 });
        });

        it("rejects NaN start", () => {
            const result = parseRangeHeader("bytes=abc-500", FILE_SIZE);
            expect(result).toEqual({ ok: false, status: 416 });
        });

        it("rejects start > end (after clamping)", () => {
            const result = parseRangeHeader("bytes=600-400", FILE_SIZE);
            expect(result).toEqual({ ok: false, status: 416 });
        });
    });

    describe("edge cases", () => {
        it("handles single-byte file", () => {
            const result = parseRangeHeader("bytes=0-0", 1);
            expect(result).toEqual({ ok: true, start: 0, end: 0 });
        });

        it("handles suffix on single-byte file", () => {
            const result = parseRangeHeader("bytes=-1", 1);
            expect(result).toEqual({ ok: true, start: 0, end: 0 });
        });

        it("handles last byte of file", () => {
            const result = parseRangeHeader("bytes=9999-9999", FILE_SIZE);
            expect(result).toEqual({ ok: true, start: 9999, end: 9999 });
        });
    });
});
