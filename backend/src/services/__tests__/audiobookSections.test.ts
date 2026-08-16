import { buildSections, buildSectionsWhenPresent } from "../audiobookSections";

describe("buildSections", () => {
    it("distinguishes omitted section fields from present empty fields", () => {
        expect(
            buildSectionsWhenPresent({
                durationSeconds: 1000,
                chapters: undefined,
                audioFiles: undefined,
            }),
        ).toBeNull();
        expect(
            buildSectionsWhenPresent({
                durationSeconds: 1000,
                chapters: [],
                audioFiles: [],
            }),
        ).toEqual({ kind: "none", sections: [] });
    });

    it("adopts well-formed chapters that span at least 85% of the book", () => {
        expect(
            buildSections({
                durationSeconds: 1000,
                chapters: [
                    { title: "Opening", start: 0, end: 450 },
                    { title: "Closing", start: 450, end: 900 },
                ],
                audioFiles: [{ filename: "book.m4b", duration: 1000 }],
            }),
        ).toEqual({
            kind: "chapters",
            sections: [
                { index: 0, title: "Opening", startSeconds: 0 },
                { index: 1, title: "Closing", startSeconds: 450 },
            ],
        });
    });

    it("rejects sparse chapters and derives cumulative parts from multiple files", () => {
        expect(
            buildSections({
                durationSeconds: 6 * 60 * 60,
                chapters: [
                    { title: "Marker 1", start: 0, end: 600 },
                    { title: "Marker 2", start: 600, end: 1200 },
                ],
                audioFiles: [
                    {
                        duration: 3600,
                        metadata: { filename: "01 - Part One.m4b" },
                    },
                    { duration: 7200, filename: "02_Part Two.mp3" },
                    { duration: 10_800, filename: "003. Finale.flac" },
                ],
            }),
        ).toEqual({
            kind: "parts",
            sections: [
                { index: 0, title: "Part One", startSeconds: 0 },
                { index: 1, title: "Part Two", startSeconds: 3600 },
                { index: 2, title: "Finale", startSeconds: 10_800 },
            ],
        });
    });

    it.each([
        {
            name: "non-monotonic starts",
            chapters: [
                { title: "First", start: 20, end: 500 },
                { title: "Second", start: 10, end: 900 },
            ],
        },
        {
            name: "negative timestamps",
            chapters: [
                { title: "First", start: -1, end: 500 },
                { title: "Second", start: 500, end: 900 },
            ],
        },
        {
            name: "ends beyond the duration tolerance",
            chapters: [
                { title: "First", start: 0, end: 500 },
                { title: "Second", start: 500, end: 1003 },
            ],
        },
        {
            name: "non-finite timestamps",
            chapters: [
                { title: "First", start: 0, end: 500 },
                { title: "Second", start: Number.NaN, end: 900 },
            ],
        },
    ])("rejects malformed chapters with $name", ({ chapters }) => {
        expect(
            buildSections({
                durationSeconds: 1000,
                chapters,
                audioFiles: [{ filename: "single.m4b", duration: 1000 }],
            }),
        ).toEqual({ kind: "none", sections: [] });
    });

    it("does not derive parts for a single-file book", () => {
        expect(
            buildSections({
                durationSeconds: 1000,
                chapters: [],
                audioFiles: [
                    { filename: "01 - Complete Book.m4b", duration: 1000 },
                ],
            }),
        ).toEqual({ kind: "none", sections: [] });
    });

    it("returns none when sparse chapters have no multi-file fallback", () => {
        expect(
            buildSections({
                durationSeconds: 6 * 60 * 60,
                chapters: [
                    { title: "Marker 1", start: 0, end: 600 },
                    { title: "Marker 2", start: 600, end: 1200 },
                ],
                audioFiles: [],
            }),
        ).toEqual({ kind: "none", sections: [] });
    });

    it("does not derive parts unless every file has a usable duration", () => {
        expect(
            buildSections({
                durationSeconds: 1000,
                chapters: [],
                audioFiles: [
                    { filename: "01 - First.m4b", duration: 500 },
                    { filename: "02 - Second.m4b", duration: 0 },
                ],
            }),
        ).toEqual({ kind: "none", sections: [] });
    });

    it("returns honest-empty sections for empty or malformed inputs", () => {
        expect(
            buildSections({
                durationSeconds: 1000,
                chapters: [],
                audioFiles: [],
            }),
        ).toEqual({ kind: "none", sections: [] });
        expect(
            buildSections({
                durationSeconds: "unknown",
                chapters: null,
                audioFiles: {},
            }),
        ).toEqual({ kind: "none", sections: [] });
    });
});
