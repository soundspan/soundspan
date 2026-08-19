import { jest } from "@jest/globals";

const mockFit = jest.fn<(embeddings: number[][]) => number[][]>();
const mockUmap = jest.fn(() => ({ fit: mockFit }));

jest.mock("worker_threads", () => ({
    isMainThread: true,
    parentPort: null,
    workerData: undefined,
}));
jest.mock("umap-js", () => ({ UMAP: mockUmap }));

describe("UMAP worker materialization", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("produces the same projection from embedding text as the previous parsed-array path", () => {
        const expected = [
            [0.11, 0.22],
            [0.33, 0.44],
            [0.55, 0.66],
        ];
        mockFit.mockReturnValue(expected);
        const { projectEmbeddingTexts } =
            require("../umapWorker") as typeof import("../umapWorker");

        const actual = projectEmbeddingTexts(
            ["[1,2,3]", "[4,5,6]", "[7,8,9]"],
            2,
        );

        expect(mockUmap).toHaveBeenCalledWith({
            nComponents: 2,
            nNeighbors: 2,
            minDist: 0.1,
            spread: 1.0,
        });
        expect(mockFit).toHaveBeenCalledWith([
            [1, 2, 3],
            [4, 5, 6],
            [7, 8, 9],
        ]);
        expect(actual).toBe(expected);
    });
});
