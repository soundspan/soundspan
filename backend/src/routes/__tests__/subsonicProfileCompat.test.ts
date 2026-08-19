import { Request, Response } from "express";

jest.mock("../../middleware/subsonicAuth", () => ({
    requireSubsonicAuth: (_req: Request, _res: Response, next: () => void) =>
        next(),
    subsonicRateLimiter: (_req: Request, _res: Response, next: () => void) =>
        next(),
}));

jest.mock("../../utils/subsonicResponse", () => ({
    getResponseFormat: jest.fn(() => "json"),
    sendSubsonicError: jest.fn(),
    sendSubsonicSuccess: jest.fn(),
    SubsonicErrorCode: {
        MISSING_PARAMETER: 10,
        NOT_AUTHORIZED: 50,
        NOT_FOUND: 70,
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        user: {
            findUnique: jest.fn(),
        },
        track: {
            findMany: jest.fn(),
        },
        trackRating: {
            upsert: jest.fn(),
            deleteMany: jest.fn(),
        },
    },
}));

jest.mock("../../workers/queues", () => ({
    scanQueue: {
        getActive: jest.fn(),
        getWaiting: jest.fn(),
        getDelayed: jest.fn(),
        add: jest.fn(),
    },
}));

jest.mock("../../services/audioStreaming", () => ({
    AudioStreamingService: jest.fn(),
}));

jest.mock("../../services/lyrics", () => ({
    getLyrics: jest.fn(),
}));

jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/music",
            transcodeCachePath: "/tmp/soundspan-cache",
            transcodeCacheMaxGb: 1,
        },
    },
}));

import { prisma } from "../../utils/db";
import {
    sendSubsonicError,
    sendSubsonicSuccess,
} from "../../utils/subsonicResponse";
import { handleGetAvatar, handleSetRating } from "../subsonic";

function buildReq(
    query: Record<string, unknown>,
    user: { id: string; username: string; role: string } = {
        id: "user-1",
        username: "alice",
        role: "user",
    },
): Request {
    return {
        query,
        user,
    } as unknown as Request;
}

function buildRes(): Response {
    return {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
    } as unknown as Response;
}

describe("subsonic profile compatibility handlers", () => {
    const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
    const mockTrackFindMany = prisma.track.findMany as jest.Mock;
    const mockTrackRating = (
        prisma as unknown as {
            trackRating: { upsert: jest.Mock; deleteMany: jest.Mock };
        }
    ).trackRating;
    const mockTrackRatingUpsert = mockTrackRating.upsert;
    const mockTrackRatingDeleteMany = mockTrackRating.deleteMany;
    const mockSendSuccess = sendSubsonicSuccess as jest.Mock;
    const mockSendError = sendSubsonicError as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockTrackFindMany.mockResolvedValue([
            {
                id: "track-1",
            },
        ]);
    });

    it("returns a default avatar image for an authorized user", async () => {
        mockUserFindUnique.mockResolvedValue({
            username: "alice",
        });
        const res = buildRes();

        await handleGetAvatar(buildReq({}), res);

        expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.send).toHaveBeenCalledWith(expect.any(Buffer));
    });

    it("rejects avatar lookup for another user when requester is not admin", async () => {
        await handleGetAvatar(
            buildReq({
                username: "bob",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            50,
            "Not authorized",
            "json",
            undefined,
        );
    });

    it("persists the exact non-zero user rating independently", async () => {
        mockTrackRatingUpsert.mockResolvedValue({});

        await handleSetRating(
            buildReq({
                id: "tr-track-1",
                rating: "3",
            }),
            buildRes(),
        );

        expect(mockTrackRatingUpsert).toHaveBeenCalledWith({
            where: {
                userId_trackId: { userId: "user-1", trackId: "track-1" },
            },
            create: { userId: "user-1", trackId: "track-1", rating: 3 },
            update: { rating: 3 },
        });
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {},
            "json",
            undefined,
        );
    });

    it("deletes a numeric rating without changing star state", async () => {
        mockTrackRatingDeleteMany.mockResolvedValue({
            count: 1,
        });

        await handleSetRating(
            buildReq({
                id: "tr-track-1",
                rating: "0",
            }),
            buildRes(),
        );

        expect(mockTrackRatingDeleteMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                trackId: "track-1",
            },
        });
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {},
            "json",
            undefined,
        );
    });

    it.each(["3.9", "3junk", "3e2", "6", "-1"])(
        "rejects malformed setRating value %s",
        async (rating) => {
            await handleSetRating(
                buildReq({ id: "tr-track-1", rating }),
                buildRes(),
            );

            expect(mockTrackRatingUpsert).not.toHaveBeenCalled();
            expect(mockTrackRatingDeleteMany).not.toHaveBeenCalled();
            expect(mockSendError).toHaveBeenCalledWith(
                expect.anything(),
                10,
                "Required parameter 'rating' is invalid",
                "json",
                undefined,
            );
        },
    );

    it.each(["0", "1", "2", "3", "4", "5"])(
        "accepts exact setRating value %s",
        async (rating) => {
            await handleSetRating(
                buildReq({ id: "tr-track-1", rating }),
                buildRes(),
            );

            expect(mockSendError).not.toHaveBeenCalled();
            expect(mockSendSuccess).toHaveBeenCalledWith(
                expect.anything(),
                {},
                "json",
                undefined,
            );
        },
    );
});
