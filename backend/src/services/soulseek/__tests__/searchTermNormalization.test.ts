import { performance } from "node:perf_hooks";
import { normalizeSoulseekSearchTerm } from "../searchTermNormalization";

describe("normalizeSoulseekSearchTerm", () => {
    it("normalizes ampersands to one and token", () => {
        expect(normalizeSoulseekSearchTerm("Simon & Garfunkel", "artist")).toBe(
            "simon and garfunkel",
        );
    });

    it.each(["A&B", "A  &   B"])(
        "normalizes ampersand spacing in %j",
        (term) => {
            expect(normalizeSoulseekSearchTerm(term, "artist")).toBe("a and b");
        },
    );

    it("strips a leading the from artists only", () => {
        expect(normalizeSoulseekSearchTerm("The Beatles", "artist")).toBe(
            "beatles",
        );
        expect(normalizeSoulseekSearchTerm("The Beatles", "title")).toBe(
            "the beatles",
        );
    });

    it("strips a leading track number from titles only", () => {
        expect(normalizeSoulseekSearchTerm("03 - Song Title", "title")).toBe(
            "song title",
        );
        expect(normalizeSoulseekSearchTerm("03 - Song Title", "artist")).toBe(
            "03 song title",
        );
    });

    it("removes punctuation", () => {
        expect(normalizeSoulseekSearchTerm("Don't Stop!", "title")).toBe(
            "dont stop",
        );
    });

    it.each([
        ["without an ampersand", " ".repeat(50_000), ""],
        ["with a trailing ampersand", `${" ".repeat(50_000)}&`, "and"],
    ])(
        "normalizes a long whitespace run %s in bounded time",
        (_, term, expected) => {
            const start = performance.now();

            const normalized = normalizeSoulseekSearchTerm(term, "artist");
            const elapsedMs = performance.now() - start;

            expect(normalized).toBe(expected);
            expect(elapsedMs).toBeLessThan(250);
        },
    );
});
