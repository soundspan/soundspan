const findMany = jest.fn();
const add = jest.fn();

jest.mock("../../../utils/db", () => ({
    prisma: { scrobbleConnection: { findMany } },
}));
jest.mock("../../../workers/queues", () => ({
    scrobbleQueue: { add },
}));
jest.mock("../../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn() }) },
}));

import {
    forwardScrobble,
    forwardScrobbleIsolated,
} from "../../scrobbleForwarder";

const event = {
    userId: "user-1",
    mediaType: "music" as const,
    kind: "scrobble" as const,
    listenedAt: new Date(1_700_000_000_000),
    track: {
        artist: "Artist",
        title: "Track",
        album: "Album",
        durationSeconds: 240,
    },
};

describe("forwardScrobble", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        add.mockResolvedValue({ id: "job-1" });
    });

    it.each([
        [[{ service: "lastfm" }, { service: "listenbrainz" }], 2],
        [[{ service: "listenbrainz" }], 1],
        [[], 0],
    ])("fans out enabled services %#", async (connections, expected) => {
        findMany.mockResolvedValue(connections);

        await forwardScrobble(event);

        expect(add).toHaveBeenCalledTimes(expected);
        expect(findMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                enabled: true,
                encryptedCredential: { not: null },
                service: { in: ["lastfm", "listenbrainz"] },
            },
            select: { service: true },
            take: 2,
            orderBy: { service: "asc" },
        });
        if (expected > 0) {
            expect(add).toHaveBeenCalledWith(
                "submit",
                expect.objectContaining({
                    userId: "user-1",
                    listenedAtSeconds: 1_700_000_000,
                }),
            );
        }
    });

    it.each(["audiobook", "podcast"] as const)(
        "never enqueues %s playback",
        async (mediaType) => {
            await forwardScrobble({ ...event, mediaType });

            expect(findMany).not.toHaveBeenCalled();
            expect(add).not.toHaveBeenCalled();
        },
    );

    it("contains connection lookup failures outside play recording", async () => {
        findMany.mockRejectedValue(new Error("database unavailable"));

        expect(() => forwardScrobbleIsolated(event)).not.toThrow();
        await new Promise((resolve) => setImmediate(resolve));
    });
});
