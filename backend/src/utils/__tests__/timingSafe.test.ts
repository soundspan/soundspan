import { timingSafeCompare } from "../timingSafe";

describe("timingSafeCompare", () => {
    it("returns true for identical strings", () => {
        expect(timingSafeCompare("secret123", "secret123")).toBe(true);
    });

    it("returns false for different strings of equal length", () => {
        expect(timingSafeCompare("secret123", "secret456")).toBe(false);
    });

    it("returns false when strings differ in length", () => {
        expect(timingSafeCompare("short", "longer-string")).toBe(false);
    });

    it("returns true for empty strings", () => {
        expect(timingSafeCompare("", "")).toBe(true);
    });

    it("returns false for empty vs non-empty", () => {
        expect(timingSafeCompare("", "notempty")).toBe(false);
    });

    it("handles case-sensitive comparison correctly", () => {
        expect(timingSafeCompare("ABC", "abc")).toBe(false);
        expect(timingSafeCompare("abc", "abc")).toBe(true);
    });

    it("handles unicode strings", () => {
        expect(timingSafeCompare("héllo", "héllo")).toBe(true);
        expect(timingSafeCompare("héllo", "hello")).toBe(false);
    });

    it("handles hex digest strings (MD5 tokens)", () => {
        const tokenA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
        const tokenB = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
        const tokenC = "ffffffffffffffffffffffffffffffff";
        expect(timingSafeCompare(tokenA, tokenB)).toBe(true);
        expect(timingSafeCompare(tokenA, tokenC)).toBe(false);
    });
});
