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
        GENERIC: 0,
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        track: { findFirst: jest.fn() },
        album: { findFirst: jest.fn() },
        artist: { findFirst: jest.fn() },
        playlist: { findFirst: jest.fn() },
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
            transcodeCachePath: "/var/soundspan/transcode",
            transcodeCacheMaxGb: 2,
        },
    },
}));

// Partially mock the hardened cover-art service: keep the real pure helpers
// (snapCoverArtSize / negotiateCoverArtFormat) so the allowlist snapping is
// exercised, but spy on resizeCoverArt to assert the handler delegates to it.
jest.mock("../../services/coverArtResize", () => {
    const actual = jest.requireActual("../../services/coverArtResize");
    return {
        ...actual,
        resizeCoverArt: jest.fn(),
    };
});

import { prisma } from "../../utils/db";
import { sendSubsonicError } from "../../utils/subsonicResponse";
import { resizeCoverArt } from "../../services/coverArtResize";
import { handleGetCoverArt } from "../subsonic";

const mockAlbumFindFirst = prisma.album.findFirst as jest.Mock;
const mockSendError = sendSubsonicError as jest.Mock;
const mockResizeCoverArt = resizeCoverArt as jest.Mock;

function buildReq(
    query: Record<string, unknown>,
    headers: Record<string, unknown> = {},
): Request {
    return {
        query,
        headers,
        user: { id: "user-1", username: "alice", role: "user" },
    } as unknown as Request;
}

function buildRes(): Response {
    const res: Partial<Response> = {
        setHeader: jest.fn(),
        status: jest.fn(),
        send: jest.fn(),
        headersSent: false,
    };
    (res.status as jest.Mock).mockReturnValue(res);
    return res as Response;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockResizeCoverArt.mockReset();
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe("handleGetCoverArt cover-art resize dedup", () => {
    const nativeCoverPath = "/var/soundspan/covers/album/cover.png";

    it("delegates resizing to the hardened service with a snapped size and negotiated format", async () => {
        mockAlbumFindFirst.mockResolvedValue({
            coverUrl: "native:album/cover.png",
        });
        jest
            .spyOn(fs, "existsSync")
            .mockImplementation((p: fs.PathLike) => p === nativeCoverPath);
        jest.spyOn(fs, "readFileSync").mockReturnValue(Buffer.from("png-bytes"));
        mockResizeCoverArt.mockResolvedValue({
            buffer: Buffer.from("resized-webp"),
            contentType: "image/webp",
            resized: true,
        });

        const res = buildRes();
        await handleGetCoverArt(
            buildReq({ id: "al-album-1", size: "300" }, { accept: "image/webp" }),
            res,
        );

        expect(mockSendError).not.toHaveBeenCalled();
        // "300" must snap up to the 320 allowlist entry, and webp Accept
        // must negotiate the webp output format.
        expect(mockResizeCoverArt).toHaveBeenCalledWith({
            buffer: expect.any(Buffer),
            contentType: "image/png",
            size: 320,
            format: "webp",
        });
        expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "image/webp");
        expect(res.send).toHaveBeenCalledWith(Buffer.from("resized-webp"));
    });

    it("serves the original bytes untouched when no size is requested", async () => {
        mockAlbumFindFirst.mockResolvedValue({
            coverUrl: "native:album/cover.png",
        });
        jest
            .spyOn(fs, "existsSync")
            .mockImplementation((p: fs.PathLike) => p === nativeCoverPath);
        jest.spyOn(fs, "readFileSync").mockReturnValue(Buffer.from("png-bytes"));
        mockResizeCoverArt.mockImplementation(
            async (opts: { buffer: Buffer; contentType: string | null }) => ({
                buffer: opts.buffer,
                contentType: opts.contentType,
                resized: false,
            }),
        );

        const res = buildRes();
        await handleGetCoverArt(buildReq({ id: "al-album-1" }), res);

        expect(mockResizeCoverArt).toHaveBeenCalledWith({
            buffer: expect.any(Buffer),
            contentType: "image/png",
            size: null,
            format: "original",
        });
        expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
        expect(res.status).toHaveBeenCalledWith(200);
    });
});
