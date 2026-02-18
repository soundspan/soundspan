import { Request, Response } from "express";

jest.mock("../../middleware/subsonicAuth", () => ({
    requireSubsonicAuth: (_req: Request, _res: Response, next: () => void) => next(),
    subsonicRateLimiter: (_req: Request, _res: Response, next: () => void) => next(),
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
        likedTrack: {
            createMany: jest.fn(),
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
import {
    handleGetAvatar,
    handleSetRating,
} from "../subsonic";

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
    const mockLikedTrackCreateMany = prisma.likedTrack.createMany as jest.Mock;
    const mockLikedTrackDeleteMany = prisma.likedTrack.deleteMany as jest.Mock;
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

    it("maps non-zero setRating to likedTrack create semantics", async () => {
        mockLikedTrackCreateMany.mockResolvedValue({
            count: 1,
        });

        await handleSetRating(
            buildReq({
                id: "tr-track-1",
                rating: "5",
            }),
            buildRes(),
        );

        expect(mockLikedTrackCreateMany).toHaveBeenCalledWith({
            data: [
                {
                    userId: "user-1",
                    trackId: "track-1",
                },
            ],
            skipDuplicates: true,
        });
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {},
            "json",
            undefined,
        );
    });

    it("maps zero setRating to likedTrack deletion semantics", async () => {
        mockLikedTrackDeleteMany.mockResolvedValue({
            count: 1,
        });

        await handleSetRating(
            buildReq({
                id: "tr-track-1",
                rating: "0",
            }),
            buildRes(),
        );

        expect(mockLikedTrackDeleteMany).toHaveBeenCalledWith({
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

    it("rejects invalid setRating values", async () => {
        await handleSetRating(
            buildReq({
                id: "tr-track-1",
                rating: "10",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'rating' is invalid",
            "json",
            undefined,
        );
    });
});
