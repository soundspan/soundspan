import fs from "fs";
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
        NOT_FOUND: 70,
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        track: {
            findFirst: jest.fn(),
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

jest.mock("../../services/lyrics", () => ({
    getLyrics: jest.fn(),
}));

jest.mock("../../services/audioStreaming", () => ({
    AudioStreamingService: jest.fn(),
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
import { getLyrics } from "../../services/lyrics";
import {
    sendSubsonicError,
    sendSubsonicSuccess,
} from "../../utils/subsonicResponse";
import {
    handleDownload,
    handleGetLyricsBySongId,
} from "../subsonic";

function buildReq(query: Record<string, unknown>): Request {
    return {
        query,
        user: {
            id: "user-1",
            username: "alice",
            role: "user",
        },
    } as unknown as Request;
}

function buildRes(): Response {
    return {
        download: jest.fn(),
    } as unknown as Response;
}

describe("subsonic media compatibility handlers", () => {
    const mockTrackFindFirst = prisma.track.findFirst as jest.Mock;
    const mockGetLyrics = getLyrics as jest.Mock;
    const mockSendError = sendSubsonicError as jest.Mock;
    const mockSendSuccess = sendSubsonicSuccess as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("downloads local library track file", async () => {
        mockTrackFindFirst.mockResolvedValue({
            filePath: "Artist One/Album One/01 Song One.mp3",
        });
        jest.spyOn(fs, "existsSync").mockReturnValue(true);
        const res = buildRes();

        await handleDownload(
            buildReq({
                id: "tr-track-1",
            }),
            res,
        );

        expect((res.download as jest.Mock).mock.calls[0][0]).toContain(
            "/music/Artist One/Album One/01 Song One.mp3",
        );
        expect((res.download as jest.Mock).mock.calls[0][1]).toBe("01 Song One.mp3");
        jest.restoreAllMocks();
    });

    it("returns not found when download track lookup fails", async () => {
        mockTrackFindFirst.mockResolvedValue(null);

        await handleDownload(
            buildReq({
                id: "tr-missing",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            70,
            "Song not found",
            "json",
            undefined,
        );
    });

    it("returns synced lyrics mapped to structuredLyrics line entries", async () => {
        mockTrackFindFirst.mockResolvedValue({
            title: "Song One",
            album: {
                artist: {
                    name: "Artist One",
                },
            },
        });
        mockGetLyrics.mockResolvedValue({
            syncedLyrics: "[00:01.00] first line\n[00:02.50] second line",
            plainLyrics: null,
            source: "lrclib",
            synced: true,
        });

        await handleGetLyricsBySongId(
            buildReq({
                id: "tr-track-1",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                lyricsList: expect.objectContaining({
                    structuredLyrics: expect.arrayContaining([
                        expect.objectContaining({
                            displayArtist: "Artist One",
                            displayTitle: "Song One",
                            synced: true,
                            line: expect.arrayContaining([
                                expect.objectContaining({
                                    value: "first line",
                                    start: 1000,
                                }),
                                expect.objectContaining({
                                    value: "second line",
                                    start: 2500,
                                }),
                            ]),
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns empty structuredLyrics when no lyrics are available", async () => {
        mockTrackFindFirst.mockResolvedValue({
            title: "Song One",
            album: {
                artist: {
                    name: "Artist One",
                },
            },
        });
        mockGetLyrics.mockResolvedValue({
            syncedLyrics: null,
            plainLyrics: null,
            source: "none",
            synced: false,
        });

        await handleGetLyricsBySongId(
            buildReq({
                id: "tr-track-1",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {
                lyricsList: {
                    structuredLyrics: [],
                },
            },
            "json",
            undefined,
        );
    });
});
