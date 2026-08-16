import { blendEmbeddings, lerpEmbedding, parseEmbedding } from "../embedding";

describe("lerpEmbedding", () => {
    it("returns the endpoints at t=0 and t=1", () => {
        const start = [1, 2, 3];
        const end = [4, 6, 8];

        expect(lerpEmbedding(start, end, 0)).toEqual(start);
        expect(lerpEmbedding(start, end, 1)).toEqual(end);
    });

    it("interpolates the midpoint", () => {
        expect(lerpEmbedding([0, 2, 4], [2, 4, 8], 0.5)).toEqual([1, 3, 6]);
    });

    it("preserves the first embedding dimension", () => {
        expect(lerpEmbedding([0, 2], [2, 4, 8], 0.5)).toHaveLength(2);
    });
});

describe("blendEmbeddings", () => {
    it("computes a weighted blend", () => {
        expect(
            blendEmbeddings(
                [
                    [1, 3],
                    [5, 7],
                ],
                [1, 3],
            ),
        ).toEqual([4, 6]);
    });

    it("preserves the first embedding dimension", () => {
        expect(
            blendEmbeddings(
                [
                    [1, 2, 3],
                    [5, 6, 7],
                ],
                [1, 1],
            ),
        ).toHaveLength(3);
    });

    it("preserves NaN results when the total weight is zero", () => {
        expect(blendEmbeddings([[1, 2]], [0])).toEqual([NaN, NaN]);
    });
});

describe("parseEmbedding", () => {
    it("parses valid embedding strings across numeric formats", () => {
        expect(parseEmbedding("[0.1,0.2,0.3]")).toEqual([0.1, 0.2, 0.3]);
        expect(parseEmbedding("[-1,2.5,3e-4]")).toEqual([-1, 2.5, 0.0003]);
        expect(parseEmbedding("[1,2,3]")).toEqual([1, 2, 3]);
    });

    it("throws for empty, null, and undefined input", () => {
        expect(() => parseEmbedding("")).toThrow(
            "Invalid embedding: expected non-empty string",
        );
        expect(() => parseEmbedding("   ")).toThrow(
            "Invalid embedding: expected non-empty string",
        );
        expect(() => parseEmbedding(null as unknown as string)).toThrow(
            "Invalid embedding: expected non-empty string",
        );
        expect(() => parseEmbedding(undefined as unknown as string)).toThrow(
            "Invalid embedding: expected non-empty string",
        );
    });

    it("throws for non-string input", () => {
        expect(() => parseEmbedding(123 as unknown as string)).toThrow(
            "Invalid embedding: expected non-empty string",
        );
        expect(() => parseEmbedding([1, 2, 3] as unknown as string)).toThrow(
            "Invalid embedding: expected non-empty string",
        );
        expect(() =>
            parseEmbedding({ value: "[1,2,3]" } as unknown as string),
        ).toThrow("Invalid embedding: expected non-empty string");
    });

    it("throws for malformed embeddings with non-numeric values", () => {
        expect(() => parseEmbedding("[1,two,3]")).toThrow(
            "Invalid embedding: contains non-numeric values",
        );
        expect(() => parseEmbedding("[1,,3]")).toThrow(
            "Invalid embedding: contains non-numeric values",
        );
        expect(() => parseEmbedding("[1,NaN,3]")).toThrow(
            "Invalid embedding: contains non-numeric values",
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
