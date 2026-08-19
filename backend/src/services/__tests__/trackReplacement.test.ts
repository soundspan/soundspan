jest.mock("../../config", () => ({
    config: { music: { transcodeCachePath: "/tmp/soundspan-test-cache" } },
}));

jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn() }) },
}));

jest.mock("../../utils/db", () => ({ prisma: {} }));

import { applyTrackReplacement } from "../trackReplacement";

describe("track replacement", () => {
    it("clears stale track and album loudness with the other derived state", async () => {
        const trackState = {
            id: "track-1",
            albumId: "album-1",
            loudnessLufs: -24,
            truePeakDb: -8,
        };
        const albumState = {
            id: "album-1",
            albumLoudnessLufs: -23,
            albumTruePeakDb: -7,
        };
        const transaction = {
            track: {
                findUnique: jest.fn(async () => ({
                    albumId: trackState.albumId,
                })),
                updateMany: jest.fn(async ({ data }) => {
                    Object.assign(trackState, data);
                    return { count: 1 };
                }),
            },
            album: {
                updateMany: jest.fn(async ({ data }) => {
                    Object.assign(albumState, data);
                    return { count: 1 };
                }),
            },
            trackEmbedding: {
                deleteMany: jest.fn(async () => ({ count: 1 })),
            },
            transcodedFile: {
                findMany: jest.fn(async () => [{ cachePath: "track.opus" }]),
                deleteMany: jest.fn(async () => ({ count: 1 })),
            },
        };

        await expect(
            applyTrackReplacement(transaction as never, "track-1"),
        ).resolves.toEqual(["track.opus"]);

        expect(trackState).toEqual(
            expect.objectContaining({
                loudnessLufs: null,
                truePeakDb: null,
            }),
        );
        expect(albumState).toEqual({
            id: "album-1",
            albumLoudnessLufs: null,
            albumTruePeakDb: null,
        });
    });
});
