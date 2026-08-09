import {
    MAX_JOURNEY_EXCLUDE_TRACK_IDS,
    parseJourneyRequest,
} from "../vibeJourneyRequest";

const INVALID_MOOD_ERROR =
    "Invalid mood. Must be one of: happy, sad, chill, energetic, party, focus, melancholy, aggressive, acoustic";

function rejection(error: string) {
    return { ok: false, status: 400, error };
}

describe("parseJourneyRequest", () => {
    it("requires a non-empty fromTrackId", () => {
        expect(parseJourneyRequest({ fromTrackId: "", toTrackId: "to-1" })).toEqual(
            rejection("fromTrackId is required")
        );
    });

    it.each([
        { fromTrackId: "from-1" },
        { fromTrackId: "from-1", toTrackId: "to-1", mood: "happy" },
    ])("requires exactly one target for $body", (body) => {
        expect(parseJourneyRequest(body)).toEqual(
            rejection("Provide exactly one of toTrackId or mood")
        );
    });

    it("rejects an invalid mood", () => {
        expect(
            parseJourneyRequest({ fromTrackId: "from-1", mood: "invalid" })
        ).toEqual(rejection(INVALID_MOOD_ERROR));
    });

    it("rejects an identical origin and destination", () => {
        expect(
            parseJourneyRequest({ fromTrackId: "same-1", toTrackId: "same-1" })
        ).toEqual(rejection("Origin and destination are the same track"));
    });

    it("requires excludeTrackIds to be an array", () => {
        expect(
            parseJourneyRequest({
                fromTrackId: "from-1",
                toTrackId: "to-1",
                excludeTrackIds: "track-1",
            })
        ).toEqual(rejection("excludeTrackIds must be an array of strings"));
    });

    it("limits excludeTrackIds to 200 entries", () => {
        expect(
            parseJourneyRequest({
                fromTrackId: "from-1",
                toTrackId: "to-1",
                excludeTrackIds: Array.from(
                    { length: MAX_JOURNEY_EXCLUDE_TRACK_IDS + 1 },
                    (_, index) => `track-${index}`
                ),
            })
        ).toEqual(rejection("excludeTrackIds cannot exceed 200 entries"));
    });

    it("requires non-empty string excludeTrackIds", () => {
        expect(
            parseJourneyRequest({
                fromTrackId: "from-1",
                toTrackId: "to-1",
                excludeTrackIds: ["track-1", ""],
            })
        ).toEqual(
            rejection("excludeTrackIds must contain non-empty strings")
        );
    });

    it("requires integer steps", () => {
        expect(
            parseJourneyRequest({
                fromTrackId: "from-1",
                toTrackId: "to-1",
                steps: 2.5,
            })
        ).toEqual(rejection("steps must be an integer"));
    });

    it.each([
        [
            {
                fromTrackId: "",
                excludeTrackIds: "invalid",
                steps: "invalid",
            },
            "fromTrackId is required",
        ],
        [
            {
                fromTrackId: "from-1",
                excludeTrackIds: "invalid",
                steps: "invalid",
            },
            "Provide exactly one of toTrackId or mood",
        ],
        [
            {
                fromTrackId: "from-1",
                toTrackId: "to-1",
                excludeTrackIds: "invalid",
                steps: "invalid",
            },
            "excludeTrackIds must be an array of strings",
        ],
    ])("preserves validation precedence for case %#", (body, error) => {
        expect(parseJourneyRequest(body)).toEqual(rejection(error));
    });

    it("accepts a track target", () => {
        expect(
            parseJourneyRequest({ fromTrackId: "from-1", toTrackId: "to-1" })
        ).toEqual({
            ok: true,
            value: {
                fromTrackId: "from-1",
                toTrackId: "to-1",
                mood: null,
                steps: 8,
                excludeTrackIds: [],
            },
        });
    });

    it("accepts a mood target", () => {
        expect(
            parseJourneyRequest({ fromTrackId: "from-1", mood: "happy" })
        ).toEqual({
            ok: true,
            value: {
                fromTrackId: "from-1",
                toTrackId: null,
                mood: "happy",
                steps: 8,
                excludeTrackIds: [],
            },
        });
    });

    it("defaults excludeTrackIds to an empty array", () => {
        const result = parseJourneyRequest({
            fromTrackId: "from-1",
            toTrackId: "to-1",
        });

        expect(result.ok && result.value.excludeTrackIds).toEqual([]);
    });

    it("defaults steps to 8", () => {
        const result = parseJourneyRequest({
            fromTrackId: "from-1",
            toTrackId: "to-1",
        });

        expect(result.ok && result.value.steps).toBe(8);
    });

    it.each([
        [1, 2],
        [99, 20],
    ])("clamps steps from %i to %i", (steps, expected) => {
        const result = parseJourneyRequest({
            fromTrackId: "from-1",
            toTrackId: "to-1",
            steps,
        });

        expect(result.ok && result.value.steps).toBe(expected);
    });

    it.each([null, [], "not-an-object"])(
        "treats non-object body %# as an empty object",
        (body) => {
            expect(parseJourneyRequest(body)).toEqual(
                rejection("fromTrackId is required")
            );
        }
    );
});
