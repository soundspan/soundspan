import {
    normalizeFullwidth,
    normalizeQuotes,
} from "../stringNormalization";

describe("stringNormalization", () => {
    describe("normalizeQuotes", () => {
        it("normalizes typographic single quotes and apostrophes", () => {
            expect(normalizeQuotes("Don\u2019t Stop")).toBe("Don't Stop");
            expect(normalizeQuotes("\u02BBOhana")).toBe("'Ohana");
        });

        it("normalizes typographic double quotes", () => {
            expect(normalizeQuotes("\u201CHello\u201D")).toBe('"Hello"');
        });
    });

    describe("normalizeFullwidth", () => {
        it("normalizes fullwidth latin text", () => {
            expect(normalizeFullwidth("ＧＨＯＳＴ")).toBe("GHOST");
        });

        it("normalizes fullwidth punctuation and spaces", () => {
            expect(normalizeFullwidth("Ａ　Ｂ！")).toBe("A B!");
        });
    });
});
