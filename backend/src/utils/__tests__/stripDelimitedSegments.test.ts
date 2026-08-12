import { stripDelimitedSegments } from "../stripDelimitedSegments";

const TRACK_DESCRIPTOR_PATTERN =
    /(?:live|remaster|remix|version|edit|demo|acoustic|radio|single|extended|instrumental|feat\.|ft\.|featuring)/i;

const EQUIVALENCE_CORPUS = [
    "",
    "plain title",
    "()",
    "[]",
    "(live)",
    "[remaster]",
    "before (live) after",
    "before [radio edit] after",
    "(first)(second)",
    "[first][second]",
    "before ) after",
    "before ] after",
    "before ( after",
    "before [ after",
    "(((((",
    "[[[[[",
    "((nested) tail)",
    "[[nested] tail]",
    "a(b(c)d)e",
    "a[b[c]d]e",
    "mix (live) [deluxe] end",
    "unicode (演奏版) café 🎵",
    "unicode [ライブ版] naïve 🚀",
    "descriptor (Live at 東京) [Original Mix]",
];

const DELIMITER_CASES = [
    {
        label: "parentheses",
        openDelimiter: "(",
        closeDelimiter: ")",
        stripOracle: (input: string) => input.replace(/\([^)]*\)/g, ""),
        filterOracle: (input: string) =>
            input.replace(/\(([^)]*)\)/g, (match, segment) =>
                TRACK_DESCRIPTOR_PATTERN.test(segment) ? " " : match,
            ),
    },
    {
        label: "brackets",
        openDelimiter: "[",
        closeDelimiter: "]",
        stripOracle: (input: string) => input.replace(/\[[^\]]*\]/g, ""),
        filterOracle: (input: string) =>
            input.replace(/\[([^\]]*)\]/g, (match, segment) =>
                TRACK_DESCRIPTOR_PATTERN.test(segment) ? " " : match,
            ),
    },
];

describe.each(DELIMITER_CASES)(
    "stripDelimitedSegments with $label",
    ({ openDelimiter, closeDelimiter, stripOracle, filterOracle }) => {
        it.each(EQUIVALENCE_CORPUS)(
            "matches unconditional regex semantics for corpus entry %#",
            (input) => {
                expect(
                    stripDelimitedSegments(
                        input,
                        openDelimiter,
                        closeDelimiter,
                    ),
                ).toBe(stripOracle(input));
            },
        );

        it.each(EQUIVALENCE_CORPUS)(
            "matches predicate-filtered regex semantics for corpus entry %#",
            (input) => {
                expect(
                    stripDelimitedSegments(
                        input,
                        openDelimiter,
                        closeDelimiter,
                        (segment) => TRACK_DESCRIPTOR_PATTERN.test(segment),
                        " ",
                    ),
                ).toBe(filterOracle(input));
            },
        );
    },
);

it("scans 50,000 unmatched opening delimiters within the regression bound", () => {
    const input = "(".repeat(50_000);
    const startedAt = performance.now();

    const result = stripDelimitedSegments(input, "(", ")");

    expect(result).toBe(input);
    expect(performance.now() - startedAt).toBeLessThan(200);
});

it.each([
    ["", ")"],
    ["(", ""],
    ["((", ")"],
    ["(", "))"],
    ["(", "("],
])("rejects invalid delimiter pairs %#", (openDelimiter, closeDelimiter) => {
    expect(() =>
        stripDelimitedSegments("value", openDelimiter, closeDelimiter),
    ).toThrow(RangeError);
});
