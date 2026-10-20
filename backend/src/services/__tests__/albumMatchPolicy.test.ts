import {
    isAcceptableAlbumMatch,
    pickBestAlbumMatch,
} from "../albumMatchPolicy";

interface MatchFixture {
    name: string;
    request: { artistName: string; albumTitle: string };
    candidate: { artistName: string; albumTitle: string };
    accepted: boolean;
}

const fixtures: MatchFixture[] = [
    {
        name: "accepts an exact artist and title",
        request: { artistName: "Drake", albumTitle: "Take Care" },
        candidate: { artistName: "Drake", albumTitle: "Take Care" },
        accepted: true,
    },
    {
        name: "accepts a candidate edition suffix",
        request: { artistName: "Drake", albumTitle: "Take Care" },
        candidate: {
            artistName: "Drake",
            albumTitle: "Take Care (Deluxe)",
        },
        accepted: true,
    },
    {
        name: "accepts a requested edition suffix",
        request: {
            artistName: "Drake",
            albumTitle: "Take Care (Deluxe)",
        },
        candidate: { artistName: "Drake", albumTitle: "Take Care" },
        accepted: true,
    },
    {
        name: "accepts a multiplication-sign title as a folded x edition",
        request: { artistName: "Ed Sheeran", albumTitle: "×" },
        candidate: {
            artistName: "Ed Sheeran",
            albumTitle: "x (Deluxe Edition)",
        },
        accepted: true,
    },
    {
        name: "accepts a minus-sign title as a folded hyphen edition",
        request: { artistName: "Ed Sheeran", albumTitle: "−" },
        candidate: {
            artistName: "Ed Sheeran",
            albumTitle: "- (Deluxe)",
        },
        accepted: true,
    },
    {
        name: "accepts a minus-sign title as a folded hyphen",
        request: { artistName: "Ed Sheeran", albumTitle: "−" },
        candidate: { artistName: "Ed Sheeran", albumTitle: "-" },
        accepted: true,
    },
    {
        name: "accepts an exact punctuation-only parenthesized title",
        request: { artistName: "Sigur Rós", albumTitle: "( )" },
        candidate: { artistName: "Sigur Rós", albumTitle: "( )" },
        accepted: true,
    },
    {
        name: "accepts an edition of a punctuation-only parenthesized title",
        request: { artistName: "Sigur Rós", albumTitle: "( )" },
        candidate: {
            artistName: "Sigur Rós",
            albumTitle: "( ) [2022 Remaster]",
        },
        accepted: true,
    },
    {
        name: "accepts an edition of a question-mark title",
        request: { artistName: "XXXTENTACION", albumTitle: "?" },
        candidate: {
            artistName: "XXXTENTACION",
            albumTitle: "? (Deluxe)",
        },
        accepted: true,
    },
    {
        name: "accepts an exact punctuation-only artist",
        request: { artistName: "!!!", albumTitle: "Myth Takes" },
        candidate: { artistName: "!!!", albumTitle: "Myth Takes" },
        accepted: true,
    },
    {
        name: "accepts a collaboration containing the requested artist",
        request: { artistName: "Drake", albumTitle: "Her Loss" },
        candidate: {
            artistName: "Drake & 21 Savage",
            albumTitle: "Her Loss",
        },
        accepted: true,
    },
    {
        name: "accepts a requested artist at the end of a collaboration",
        request: { artistName: "21 Savage", albumTitle: "Her Loss" },
        candidate: {
            artistName: "Drake & 21 Savage",
            albumTitle: "Her Loss",
        },
        accepted: true,
    },
    {
        name: "accepts a requested artist as a whole token",
        request: { artistName: "Artist", albumTitle: "Album" },
        candidate: {
            artistName: "Different Artist",
            albumTitle: "Album",
        },
        accepted: true,
    },
    {
        name: "accepts collaboration diacritic and conjunction variants",
        request: { artistName: "Beyoncé", albumTitle: "Everything Is Love" },
        candidate: {
            artistName: "Beyonce & Jay-Z",
            albumTitle: "Everything Is Love",
        },
        accepted: true,
    },
    {
        name: "accepts a requested leading article omitted by the candidate",
        request: { artistName: "The Beatles", albumTitle: "Abbey Road" },
        candidate: { artistName: "Beatles", albumTitle: "Abbey Road" },
        accepted: true,
    },
    {
        name: "accepts a candidate leading article omitted by the request",
        request: { artistName: "Beatles", albumTitle: "Abbey Road" },
        candidate: { artistName: "The Beatles", albumTitle: "Abbey Road" },
        accepted: true,
    },
    {
        name: "keeps a repeated leading article in an exact artist name",
        request: { artistName: "The The", albumTitle: "Soul Mining" },
        candidate: { artistName: "The The", albumTitle: "Soul Mining" },
        accepted: true,
    },
    {
        name: "does not collapse a repeated leading article to a bare article",
        request: { artistName: "The The", albumTitle: "Soul Mining" },
        candidate: { artistName: "The", albumTitle: "Soul Mining" },
        accepted: false,
    },
    {
        name: "does not collapse a repeated leading article to an empty artist",
        request: { artistName: "The The", albumTitle: "Soul Mining" },
        candidate: { artistName: "", albumTitle: "Soul Mining" },
        accepted: false,
    },
    {
        name: "applies the containment length guard after removing an article",
        request: { artistName: "The X", albumTitle: "Townie" },
        candidate: { artistName: "X Ambassadors", albumTitle: "Townie" },
        accepted: false,
    },
    {
        name: "accepts comma-adjacent requested artist tokens",
        request: { artistName: "Drake", albumTitle: "Her Loss" },
        candidate: {
            artistName: "Drake,21 Savage",
            albumTitle: "Her Loss",
        },
        accepted: true,
    },
    {
        name: "accepts comma-adjacent trailing artist tokens",
        request: { artistName: "21 Savage", albumTitle: "Her Loss" },
        candidate: {
            artistName: "Drake,21 Savage",
            albumTitle: "Her Loss",
        },
        accepted: true,
    },
    {
        name: "accepts slash-adjacent requested artist tokens",
        request: { artistName: "Drake", albumTitle: "Her Loss" },
        candidate: {
            artistName: "Drake/21 Savage",
            albumTitle: "Her Loss",
        },
        accepted: true,
    },
    {
        name: "accepts slash-adjacent trailing artist tokens",
        request: { artistName: "21 Savage", albumTitle: "Her Loss" },
        candidate: {
            artistName: "Drake/21 Savage",
            albumTitle: "Her Loss",
        },
        accepted: true,
    },
    {
        name: "rejects DJ Khaled for Drake",
        request: { artistName: "Drake", albumTitle: "Take Care" },
        candidate: { artistName: "DJ Khaled", albumTitle: "Take Care" },
        accepted: false,
    },
    {
        name: "rejects a partial-token artist match",
        request: { artistName: "Drake", albumTitle: "Take Care" },
        candidate: {
            artistName: "Drakeo the Ruler",
            albumTitle: "Take Care",
        },
        accepted: false,
    },
    {
        name: "rejects Young Money for Drake",
        request: { artistName: "Drake", albumTitle: "Trophies" },
        candidate: { artistName: "Young Money", albumTitle: "Trophies" },
        accepted: false,
    },
    {
        name: "rejects Kendrick Lamar for Drake",
        request: { artistName: "Drake", albumTitle: "6 God" },
        candidate: { artistName: "Kendrick Lamar", albumTitle: "6 God" },
        accepted: false,
    },
    {
        name: "rejects containment for a short requested artist",
        request: { artistName: "X", albumTitle: "Townie" },
        candidate: { artistName: "X Ambassadors", albumTitle: "Townie" },
        accepted: false,
    },
    {
        name: "rejects a title mismatch for the same artist",
        request: { artistName: "Drake", albumTitle: "Take Care" },
        candidate: { artistName: "Drake", albumTitle: "Nothing Was the Same" },
        accepted: false,
    },
    {
        name: "rejects a plus title for a minus-sign request",
        request: { artistName: "Ed Sheeran", albumTitle: "−" },
        candidate: { artistName: "Ed Sheeran", albumTitle: "+" },
        accepted: false,
    },
    {
        name: "rejects a tour collection for a minus-sign request",
        request: { artistName: "Ed Sheeran", albumTitle: "−" },
        candidate: {
            artistName: "Ed Sheeran",
            albumTitle: "+-=÷× (Tour Collection)",
        },
        accepted: false,
    },
    {
        name: "rejects a divide title for a multiplication-sign request",
        request: { artistName: "Ed Sheeran", albumTitle: "×" },
        candidate: {
            artistName: "Ed Sheeran",
            albumTitle: "÷ (Deluxe)",
        },
        accepted: false,
    },
    {
        name: "rejects a folded title from another artist",
        request: { artistName: "Ed Sheeran", albumTitle: "×" },
        candidate: { artistName: "Different Artist", albumTitle: "x" },
        accepted: false,
    },
    {
        name: "rejects different punctuation-only title keys",
        request: { artistName: "Artist", albumTitle: "---" },
        candidate: { artistName: "Artist", albumTitle: "-" },
        accepted: false,
    },
    {
        name: "rejects an empty requested artist",
        request: { artistName: " ", albumTitle: "Take Care" },
        candidate: { artistName: "Drake", albumTitle: "Take Care" },
        accepted: false,
    },
    {
        name: "rejects an empty requested title",
        request: { artistName: "Drake", albumTitle: "" },
        candidate: { artistName: "Drake", albumTitle: "Take Care" },
        accepted: false,
    },
    {
        name: "rejects a whitespace-only requested title",
        request: { artistName: "Drake", albumTitle: " \t " },
        candidate: { artistName: "Drake", albumTitle: "Take Care" },
        accepted: false,
    },
    {
        name: "rejects an empty candidate artist",
        request: { artistName: "Drake", albumTitle: "Take Care" },
        candidate: { artistName: "", albumTitle: "Take Care" },
        accepted: false,
    },
    {
        name: "rejects an empty candidate title",
        request: { artistName: "Drake", albumTitle: "Take Care" },
        candidate: { artistName: "Drake", albumTitle: "\t" },
        accepted: false,
    },
];

describe("isAcceptableAlbumMatch", () => {
    it.each(fixtures)("$name", ({ request, candidate, accepted }) => {
        expect(isAcceptableAlbumMatch(request, candidate)).toBe(accepted);
    });
});

describe("pickBestAlbumMatch", () => {
    it("prefers an exact title over an earlier edition-stripped title", () => {
        const candidates = [
            {
                id: "EDITION",
                artistName: "Drake",
                albumTitle: "Take Care (Deluxe)",
            },
            {
                id: "EXACT",
                artistName: "Drake",
                albumTitle: "Take Care",
            },
        ];

        expect(
            pickBestAlbumMatch(
                { artistName: "Drake", albumTitle: "Take Care" },
                candidates,
                (candidate) => candidate,
            ),
        ).toBe(candidates[1]);
    });

    it("prefers an exact title over an earlier folded title", () => {
        const candidates = [
            {
                id: "FOLDED",
                artistName: "Ed Sheeran",
                albumTitle: "x (Deluxe Edition)",
            },
            {
                id: "EXACT",
                artistName: "Ed Sheeran",
                albumTitle: "×",
            },
        ];

        expect(
            pickBestAlbumMatch(
                { artistName: "Ed Sheeran", albumTitle: "×" },
                candidates,
                (candidate) => candidate,
            ),
        ).toBe(candidates[1]);
    });

    it("prefers an edition title over an earlier folded title", () => {
        const candidates = [
            {
                id: "FOLDED",
                artistName: "Ed Sheeran",
                albumTitle: "x (Deluxe Edition)",
            },
            {
                id: "EDITION",
                artistName: "Ed Sheeran",
                albumTitle: "× (Deluxe Edition)",
            },
        ];

        expect(
            pickBestAlbumMatch(
                { artistName: "Ed Sheeran", albumTitle: "×" },
                candidates,
                (candidate) => candidate,
            ),
        ).toBe(candidates[1]);
    });

    it("keeps provider order within the same title tier", () => {
        const candidates = [
            {
                id: "FIRST",
                artistName: "Drake & 21 Savage",
                albumTitle: "Her Loss",
            },
            {
                id: "SECOND",
                artistName: "Drake",
                albumTitle: "Her Loss",
            },
        ];

        expect(
            pickBestAlbumMatch(
                { artistName: "Drake", albumTitle: "Her Loss" },
                candidates,
                (candidate) => candidate,
            ),
        ).toBe(candidates[0]);
    });

    it("returns null when no candidate passes both artist and title", () => {
        expect(
            pickBestAlbumMatch(
                { artistName: "Drake", albumTitle: "6 God" },
                [
                    {
                        artistName: "Kendrick Lamar",
                        albumTitle: "GNX",
                    },
                ],
                (candidate) => candidate,
            ),
        ).toBeNull();
    });
});
