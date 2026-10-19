import { pickRemoteAlbumMbidMatch } from "../remoteAlbumMbidMatch";

const MBID_A = "11111111-1111-4111-8111-111111111111";
const MBID_B = "22222222-2222-4222-8222-222222222222";
const MBID_C = "33333333-3333-4333-8333-333333333333";

function candidate(
    overrides: Partial<{
        rgMbid: string;
        title: string;
        primaryType: string;
        artistMatches: boolean;
        score: number;
    }> = {},
) {
    return {
        rgMbid: MBID_A,
        title: "Album",
        primaryType: "Album",
        artistMatches: true,
        ...overrides,
    };
}

describe("pickRemoteAlbumMbidMatch", () => {
    const disallowSingle = { allowSingle: false };

    it.each([
        ["Album (Deluxe Edition)", "Album"],
        ["Album [2011 Remaster]", "Album"],
        ["Album - Deluxe Version", "Album"],
        ["Album (Super Deluxe)", "Album"],
        ["Album (10th Anniversary Edition)", "Album"],
        ["Album (Deluxe Edition) [2011 Remaster]", "Album"],
        ["Album - Deluxe Version - 2011 Remaster", "Album"],
    ])("classifies %s versus %s as an edition match", (left, right) => {
        expect(
            pickRemoteAlbumMbidMatch(
                left,
                [candidate({ title: right })],
                disallowSingle,
            ),
        ).toEqual({
            rgMbid: MBID_A,
            tier: "edition",
            primaryType: "Album",
        });
    });

    it.each([
        ["OK Computer", "OK Computer (Live)"],
        ["Kid A (Remixes)", "Kid A"],
        ["Song (feat. Gus)", "Song"],
        ["Album (Acoustic)", "Album"],
        ["Album - Soundtrack", "Album"],
    ])(
        "does not strip a meaningful suffix from %s versus %s",
        (left, right) => {
            expect(
                pickRemoteAlbumMbidMatch(
                    left,
                    [candidate({ title: right, primaryType: "Album" })],
                    disallowSingle,
                ),
            ).toBeNull();
        },
    );

    it.each([
        ["Live (1985)", "Live"],
        ["Greatest Hits (2004)", "Greatest Hits"],
        ["Album (10th)", "Album"],
    ])(
        "does not treat a numeric-only group in %s as an edition",
        (left, right) => {
            expect(
                pickRemoteAlbumMbidMatch(
                    left,
                    [candidate({ title: right })],
                    disallowSingle,
                ),
            ).toBeNull();
        },
    );

    it("does not run edition stripping for titles longer than 500 characters", () => {
        const baseTitle = "A".repeat(501);

        expect(
            pickRemoteAlbumMbidMatch(
                `${baseTitle} (Deluxe Edition)`,
                [candidate({ title: baseTitle })],
                disallowSingle,
            ),
        ).toBeNull();
    });

    it("does not fall back to an edition candidate when an exact candidate is filtered", () => {
        expect(
            pickRemoteAlbumMbidMatch(
                "Album",
                [
                    candidate({ primaryType: "Compilation" }),
                    candidate({
                        rgMbid: MBID_B,
                        title: "Album (Deluxe Edition)",
                    }),
                ],
                disallowSingle,
            ),
        ).toBeNull();
    });

    it.each([
        ["Album", "EP", "Album"],
        ["EP", "Single", "EP"],
    ])(
        "prefers the %s type bucket over lower-priority candidates",
        (preferredType, secondType, expectedType) => {
            const candidates = [
                candidate({ rgMbid: MBID_A, primaryType: secondType }),
                candidate({ rgMbid: MBID_B, primaryType: preferredType }),
            ];

            expect(
                pickRemoteAlbumMbidMatch("Album", candidates, {
                    allowSingle: true,
                }),
            ).toEqual({
                rgMbid: MBID_B,
                tier: "exact",
                primaryType: expectedType,
            });
        },
    );

    it("prefers Album over EP over Single when all are eligible", () => {
        expect(
            pickRemoteAlbumMbidMatch(
                "Album",
                [
                    candidate({ rgMbid: MBID_A, primaryType: "Single" }),
                    candidate({ rgMbid: MBID_B, primaryType: "EP" }),
                    candidate({ rgMbid: MBID_C, primaryType: "Album" }),
                ],
                { allowSingle: true },
            ),
        ).toEqual({
            rgMbid: MBID_C,
            tier: "exact",
            primaryType: "Album",
        });
    });

    it("rejects a Single without a matching liked track title", () => {
        expect(
            pickRemoteAlbumMbidMatch(
                "Album",
                [candidate({ primaryType: "Single" })],
                { allowSingle: false },
            ),
        ).toBeNull();
    });

    it("accepts a Single with a matching liked track title", () => {
        expect(
            pickRemoteAlbumMbidMatch(
                "Album",
                [candidate({ primaryType: "Single" })],
                { allowSingle: true },
            ),
        ).toEqual({
            rgMbid: MBID_A,
            tier: "exact",
            primaryType: "Single",
        });
    });

    it("returns null for two distinct Albums with the same title", () => {
        expect(
            pickRemoteAlbumMbidMatch(
                "Album",
                [candidate({ rgMbid: MBID_A }), candidate({ rgMbid: MBID_B })],
                disallowSingle,
            ),
        ).toBeNull();
    });

    it("accepts duplicate rows for the same release group", () => {
        expect(
            pickRemoteAlbumMbidMatch(
                "Album",
                [candidate(), candidate()],
                disallowSingle,
            ),
        ).toEqual({
            rgMbid: MBID_A,
            tier: "exact",
            primaryType: "Album",
        });
    });

    it("ignores candidates rejected by the caller's artist check", () => {
        expect(
            pickRemoteAlbumMbidMatch(
                "Album",
                [candidate({ artistMatches: false })],
                disallowSingle,
            ),
        ).toBeNull();
    });

    it.each([89, Number.NaN, Number.POSITIVE_INFINITY])(
        "drops an invalid search score of %s",
        (score) => {
            expect(
                pickRemoteAlbumMbidMatch(
                    "Album",
                    [candidate({ score })],
                    disallowSingle,
                ),
            ).toBeNull();
        },
    );

    it("ignores invalid MBIDs before choosing the strongest title tier", () => {
        expect(
            pickRemoteAlbumMbidMatch(
                "Album",
                [
                    candidate({
                        rgMbid: "remote:not-an-mbid",
                        primaryType: "Compilation",
                    }),
                    candidate({
                        rgMbid: MBID_C,
                        title: "Album (Deluxe Edition)",
                    }),
                ],
                disallowSingle,
            ),
        ).toEqual({
            rgMbid: MBID_C,
            tier: "edition",
            primaryType: "Album",
        });
    });
});
