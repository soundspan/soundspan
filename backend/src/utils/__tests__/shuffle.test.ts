import { shuffleArray } from "../shuffle";

describe("shuffleArray", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("returns an empty array when given an empty array", () => {
        expect(shuffleArray([])).toEqual([]);
    });

    it("returns a single-item array unchanged", () => {
        expect(shuffleArray(["only"])).toEqual(["only"]);
    });

    it("returns a new array without mutating the original input", () => {
        const original = [1, 2, 3];
        const randomSpy = jest
            .spyOn(Math, "random")
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0);

        const result = shuffleArray(original);

        expect(result).not.toBe(original);
        expect(original).toEqual([1, 2, 3]);
        expect(randomSpy).toHaveBeenCalledTimes(2);
    });

    it("applies deterministic swaps for a mocked Math.random sequence", () => {
        const randomSpy = jest
            .spyOn(Math, "random")
            .mockReturnValueOnce(0.1)
            .mockReturnValueOnce(0.9)
            .mockReturnValueOnce(0.4);

        const result = shuffleArray([1, 2, 3, 4]);

        expect(result).toEqual([2, 4, 3, 1]);
        expect(randomSpy).toHaveBeenCalledTimes(3);
    });

    it("preserves the same multiset of elements", () => {
        const original = [1, 2, 2, 3, 3, 3];
        const result = shuffleArray(original);

        const sortedOriginal = [...original].sort((a, b) => a - b);
        const sortedResult = [...result].sort((a, b) => a - b);

        expect(sortedResult).toEqual(sortedOriginal);
    });
});
