import { mapSubsonicScrobbleEvents } from "../../../routes/subsonic/scrobbleMapping";

describe("mapSubsonicScrobbleEvents", () => {
    it("maps client timestamps and submission=false to now-playing", () => {
        const now = new Date("2026-08-25T12:00:00.000Z");

        expect(
            mapSubsonicScrobbleEvents(
                ["track-1", "track-2", "track-3"],
                ["false", "true", "true"],
                ["1700000000000", "bad"],
                now,
            ),
        ).toEqual([
            {
                trackId: "track-1",
                kind: "now_playing",
                listenedAt: new Date("2023-11-14T22:13:20.000Z"),
            },
            { trackId: "track-2", kind: "scrobble", listenedAt: now },
            { trackId: "track-3", kind: "scrobble", listenedAt: now },
        ]);
    });
});
