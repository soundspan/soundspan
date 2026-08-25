import { classifyReleaseGroup } from "../artistExpansionEligibility";

const REQUESTED_ARTIST_MBID = "artist-drake";

function releaseGroup(overrides: Record<string, unknown> = {}): unknown {
    return {
        id: "release-group-1",
        title: "Official Release",
        "primary-type": "Album",
        "secondary-types": [],
        "artist-credit": [
            { artist: { id: REQUESTED_ARTIST_MBID, name: "Drake" } },
        ],
        ...overrides,
    };
}

describe("artist expansion release-group eligibility", () => {
    it.each(["Album", "EP"])(
        "accepts an official %s with the requested artist first",
        (primaryType) => {
            expect(
                classifyReleaseGroup(
                    releaseGroup({ "primary-type": primaryType }),
                    REQUESTED_ARTIST_MBID,
                ),
            ).toEqual({ eligible: true });
        },
    );

    it.each(["Mixtape/Street", "Remix", "Live", "Compilation"])(
        "rejects the %s secondary type",
        (secondaryType) => {
            expect(
                classifyReleaseGroup(
                    releaseGroup({ "secondary-types": [secondaryType] }),
                    REQUESTED_ARTIST_MBID,
                ),
            ).toEqual({ eligible: false, reason: "secondary_type" });
        },
    );

    it("rejects a Single even when MusicBrainz returns it", () => {
        expect(
            classifyReleaseGroup(
                releaseGroup({ "primary-type": "Single" }),
                REQUESTED_ARTIST_MBID,
            ),
        ).toEqual({ eligible: false, reason: "wrong_primary_type" });
    });

    it("rejects a release where the requested artist is not the first credit", () => {
        expect(
            classifyReleaseGroup(
                releaseGroup({
                    title: "I'm on One",
                    "artist-credit": [
                        { artist: { id: "artist-dj-khaled" } },
                        { artist: { id: REQUESTED_ARTIST_MBID } },
                    ],
                }),
                REQUESTED_ARTIST_MBID,
            ),
        ).toEqual({ eligible: false, reason: "not_primary_credit" });
    });

    it("accepts a release where the requested artist is first with features after", () => {
        expect(
            classifyReleaseGroup(
                releaseGroup({
                    "artist-credit": [
                        { artist: { id: REQUESTED_ARTIST_MBID } },
                        { artist: { id: "featured-artist" } },
                    ],
                }),
                REQUESTED_ARTIST_MBID,
            ),
        ).toEqual({ eligible: true });
    });

    it("matches artist MBIDs without case sensitivity", () => {
        const result = classifyReleaseGroup(
            releaseGroup(),
            REQUESTED_ARTIST_MBID.toUpperCase(),
        );

        expect(result).toEqual({ eligible: true });
    });

    it.each([
        ["missing artist-credit", undefined],
        ["non-array artist-credit", "Drake"],
        ["missing first artist id", [{ artist: { name: "Drake" } }]],
    ])("rejects %s as missing credit data", (_name, artistCredit) => {
        expect(
            classifyReleaseGroup(
                releaseGroup({ "artist-credit": artistCredit }),
                REQUESTED_ARTIST_MBID,
            ),
        ).toEqual({ eligible: false, reason: "missing_credits" });
    });

    it.each([
        ["non-array secondary types", { "secondary-types": "Live" }],
        ["non-string secondary type", { "secondary-types": [42] }],
        ["non-object payload", null],
    ])("fails closed without throwing for %s", (_name, malformed) => {
        const result = classifyReleaseGroup(
            malformed === null ? null : releaseGroup(malformed),
            REQUESTED_ARTIST_MBID,
        );

        expect(result).toEqual(
            malformed === null
                ? { eligible: false, reason: "wrong_primary_type" }
                : { eligible: false, reason: "secondary_type" },
        );
    });
});
