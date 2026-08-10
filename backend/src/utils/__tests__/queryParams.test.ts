import { parseBoundedInt } from "../queryParams";

describe("parseBoundedInt", () => {
    it("parses a valid in-range string", () => {
        expect(parseBoundedInt("42", 20, 1, 100)).toBe(42);
    });

    it("returns the fallback for undefined", () => {
        expect(parseBoundedInt(undefined, 20, 1, 100)).toBe(20);
    });

    it("returns the fallback for non-string values", () => {
        expect(parseBoundedInt(["12"], 20, 1, 100)).toBe(20);
        expect(parseBoundedInt(12, 20, 1, 100)).toBe(20);
    });

    it("returns the fallback for an empty string", () => {
        expect(parseBoundedInt("", 20, 1, 100)).toBe(20);
    });

    it("returns the fallback for a non-numeric string", () => {
        expect(parseBoundedInt("abc", 20, 1, 100)).toBe(20);
    });

    it("clamps a negative value to the minimum", () => {
        expect(parseBoundedInt("-5", 20, 1, 100)).toBe(1);
    });

    it("clamps zero to the minimum when the minimum is one", () => {
        expect(parseBoundedInt("0", 20, 1, 100)).toBe(1);
    });

    it("clamps a value above the maximum", () => {
        expect(parseBoundedInt("101", 20, 1, 100)).toBe(100);
    });

    it("preserves exact minimum and maximum boundaries", () => {
        expect(parseBoundedInt("1", 20, 1, 100)).toBe(1);
        expect(parseBoundedInt("100", 20, 1, 100)).toBe(100);
    });

    it("uses base-10 parseInt semantics for trailing characters", () => {
        expect(parseBoundedInt("12abc", 20, 1, 100)).toBe(12);
    });
});
