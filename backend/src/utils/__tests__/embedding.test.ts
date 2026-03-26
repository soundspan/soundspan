import { parseEmbedding } from "../embedding";

describe("parseEmbedding", () => {
    it("parses valid embedding strings across numeric formats", () => {
        expect(parseEmbedding("[0.1,0.2,0.3]")).toEqual([0.1, 0.2, 0.3]);
        expect(parseEmbedding("[-1,2.5,3e-4]")).toEqual([-1, 2.5, 0.0003]);
        expect(parseEmbedding("[1,2,3]")).toEqual([1, 2, 3]);
    });

    it("throws for empty, null, and undefined input", () => {
        expect(() => parseEmbedding("")).toThrow(
            "Invalid embedding: expected non-empty string"
        );
        expect(() => parseEmbedding("   ")).toThrow(
            "Invalid embedding: expected non-empty string"
        );
        expect(() => parseEmbedding(null as unknown as string)).toThrow(
            "Invalid embedding: expected non-empty string"
        );
        expect(() => parseEmbedding(undefined as unknown as string)).toThrow(
            "Invalid embedding: expected non-empty string"
        );
    });

    it("throws for non-string input", () => {
        expect(() => parseEmbedding(123 as unknown as string)).toThrow(
            "Invalid embedding: expected non-empty string"
        );
        expect(() => parseEmbedding([1, 2, 3] as unknown as string)).toThrow(
            "Invalid embedding: expected non-empty string"
        );
        expect(() => parseEmbedding({ value: "[1,2,3]" } as unknown as string)).toThrow(
            "Invalid embedding: expected non-empty string"
        );
    });

    it("throws for malformed embeddings with non-numeric values", () => {
        expect(() => parseEmbedding("[1,two,3]")).toThrow(
            "Invalid embedding: contains non-numeric values"
        );
        expect(() => parseEmbedding("[1,,3]")).toThrow(
            "Invalid embedding: contains non-numeric values"
        );
        expect(() => parseEmbedding("[1,NaN,3]")).toThrow(
            "Invalid embedding: contains non-numeric values"
        );
    });

    it("trims surrounding and per-value whitespace", () => {
        expect(parseEmbedding(" [ 0.1,  2.5 , -3 ] ")).toEqual([0.1, 2.5, -3]);
    });

    it("parses single-value embeddings", () => {
        expect(parseEmbedding("[42]")).toEqual([42]);
    });

    it("parses large embeddings", () => {
        const values = Array.from({ length: 512 }, (_, index) => index / 10);
        const text = `[${values.join(",")}]`;

        expect(parseEmbedding(text)).toEqual(values);
    });
});
