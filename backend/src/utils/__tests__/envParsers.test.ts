import {
    isEnvFlagEnabled,
    parseEnvBool,
    parseEnvCsv,
    parseEnvInt,
} from "../envParsers";

describe("envParsers", () => {
    describe("parseEnvInt", () => {
        it("parses explicit env values using base-10 integers", () => {
            expect(parseEnvInt("42", 7)).toBe(42);
            expect(parseEnvInt("007", 1)).toBe(7);
        });

        it("uses fallback when value is undefined or empty", () => {
            expect(parseEnvInt(undefined, 3006)).toBe(3006);
            expect(parseEnvInt("", 3006)).toBe(3006);
            expect(parseEnvInt("   ", 3006)).toBe(3006);
        });

        it("uses fallback for malformed numeric inputs", () => {
            expect(parseEnvInt("not-a-number", 9)).toBe(9);
            expect(parseEnvInt("15px", 9)).toBe(9);
            expect(parseEnvInt("12.4", 9)).toBe(9);
            expect(parseEnvInt("1e3", 9)).toBe(9);
        });
    });

    describe("isEnvFlagEnabled", () => {
        it("returns true only for literal lowercase true", () => {
            expect(isEnvFlagEnabled("true")).toBe(true);
            expect(isEnvFlagEnabled("TRUE")).toBe(false);
            expect(isEnvFlagEnabled("1")).toBe(false);
            expect(isEnvFlagEnabled(undefined)).toBe(false);
        });
    });

    describe("parseEnvBool", () => {
        it("parses literal true/false strings", () => {
            expect(parseEnvBool("true", false)).toBe(true);
            expect(parseEnvBool("false", true)).toBe(false);
        });

        it("uses the default when value is undefined or empty", () => {
            expect(parseEnvBool(undefined, true)).toBe(true);
            expect(parseEnvBool(undefined, false)).toBe(false);
            expect(parseEnvBool("", true)).toBe(true);
            expect(parseEnvBool("   ", false)).toBe(false);
        });

        it("uses the default for unrecognized values", () => {
            expect(parseEnvBool("1", false)).toBe(false);
            expect(parseEnvBool("yes", false)).toBe(false);
            expect(parseEnvBool("TRUE-ish", true)).toBe(true);
        });

        it("accepts case-insensitive and padded true/false", () => {
            expect(parseEnvBool("TRUE", false)).toBe(true);
            expect(parseEnvBool(" False ", true)).toBe(false);
        });
    });

    describe("parseEnvCsv", () => {
        it("returns undefined for undefined input", () => {
            expect(parseEnvCsv(undefined)).toBeUndefined();
        });

        it("splits comma-delimited entries and trims whitespace", () => {
            expect(
                parseEnvCsv(" https://app.example.com, http://localhost:3030 ")
            ).toEqual(["https://app.example.com", "http://localhost:3030"]);
        });

        it("keeps empty tokens from blank entries", () => {
            expect(parseEnvCsv("a,, b, ")).toEqual(["a", "", "b", ""]);
            expect(parseEnvCsv("")).toEqual([""]);
        });
    });
});

describe("parseEnvFloat", () => {
    const { parseEnvFloat } = jest.requireActual("../envParsers");

    it("parses decimal values and falls back on junk", () => {
        expect(parseEnvFloat("0.5", 1)).toBe(0.5);
        expect(parseEnvFloat(" 0.25 ", 1)).toBe(0.25);
        expect(parseEnvFloat("2", 1)).toBe(2);
        expect(parseEnvFloat("-0.5", 1)).toBe(-0.5);
        expect(parseEnvFloat("abc", 1)).toBe(1);
        expect(parseEnvFloat("", 1)).toBe(1);
        expect(parseEnvFloat(undefined, 0.3)).toBe(0.3);
        expect(parseEnvFloat("NaN", 0.3)).toBe(0.3);
        expect(parseEnvFloat("Infinity", 0.3)).toBe(0.3);
    });
});
