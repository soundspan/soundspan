jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: any, _res: any, next: () => void) => next(),
}));

const mockLyricsMutationLimiter = jest.fn(
    (_req: any, _res: any, next: () => void) => next()
);
jest.mock("../../middleware/rateLimiter", () => ({
    lyricsMutationLimiter: mockLyricsMutationLimiter,
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../services/lyrics", () => ({
    getLyrics: jest.fn(),
    clearLyricsCache: jest.fn(),
}));

import router from "../lyrics";
import { logger } from "../../utils/logger";
import { getLyrics, clearLyricsCache } from "../../services/lyrics";

const mockGetLyrics = getLyrics as jest.Mock;
const mockClearLyricsCache = clearLyricsCache as jest.Mock;
const mockLoggerDebug = logger.debug as jest.Mock;
const mockLoggerWarn = logger.warn as jest.Mock;
const mockLoggerError = logger.error as jest.Mock;

function getHandler(
    path: string,
    method: "get" | "delete",
    stackIndex?: number
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );
    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }

    const resolvedIndex =
        typeof stackIndex === "number"
            ? stackIndex
            : layer.route.stack.length - 1;
    return layer.route.stack[resolvedIndex].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
    };

    return res;
}

describe("lyrics routes runtime", () => {
    const getLyricsHandler = getHandler("/:trackId", "get");
    const deleteLimiterHandler = getHandler("/:trackId", "delete", 0);
    const deleteLyricsHandler = getHandler("/:trackId", "delete", 1);

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();

        mockGetLyrics.mockResolvedValue({
            syncedLyrics: "[00:01.00] Test line",
            plainLyrics: "Test line",
            source: "embedded",
            synced: true,
        });
        mockClearLyricsCache.mockResolvedValue(undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("returns lyrics for GET and forwards parsed lookup context", async () => {
        const req = {
            params: { trackId: "track-1" },
            query: {
                artist: "Artist",
                title: "Title",
                album: "Album",
                duration: "245.5",
            },
        } as any;
        const res = createRes();

        await getLyricsHandler(req, res);

        expect(mockGetLyrics).toHaveBeenCalledWith("track-1", {
            artistName: "Artist",
            trackName: "Title",
            albumName: "Album",
            duration: 245.5,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            syncedLyrics: "[00:01.00] Test line",
            plainLyrics: "Test line",
            source: "embedded",
            synced: true,
        });
        expect(mockLoggerDebug).toHaveBeenCalledTimes(1);
    });

    it("omits invalid query metadata before lyrics lookup", async () => {
        const req = {
            params: { trackId: "track-2" },
            query: {
                artist: ["NotAString"],
                title: 10,
                album: null,
                duration: "0",
            },
        } as any;
        const res = createRes();

        await getLyricsHandler(req, res);

        expect(mockGetLyrics).toHaveBeenCalledWith("track-2", {
            artistName: undefined,
            trackName: undefined,
            albumName: undefined,
            duration: undefined,
        });
        expect(res.statusCode).toBe(200);
    });

    it("returns 504 when lyrics lookup exceeds route timeout", async () => {
        jest.useFakeTimers();
        mockGetLyrics.mockReturnValue(new Promise(() => {}));

        const req = {
            params: { trackId: "track-slow" },
            query: {},
        } as any;
        const res = createRes();

        const pending = getLyricsHandler(req, res);
        await jest.advanceTimersByTimeAsync(20000);
        await pending;

        expect(res.statusCode).toBe(504);
        expect(res.body).toEqual({ error: "Lyrics lookup timed out" });
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "[Lyrics] GET /lyrics/track-slow timed out after 20000ms"
        );
    });

    it("returns 503 when lyrics lookup throws", async () => {
        const error = new Error("lyrics service unavailable");
        mockGetLyrics.mockRejectedValueOnce(error);

        const req = {
            params: { trackId: "track-error" },
            query: {},
        } as any;
        const res = createRes();

        await getLyricsHandler(req, res);

        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({ error: "Failed to load lyrics" });
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Get lyrics error for track track-error:",
            error
        );
    });

    it("executes delete limiter middleware and clears cached lyrics", async () => {
        const limiterReq = { params: { trackId: "track-1" } } as any;
        const limiterRes = createRes();
        const next = jest.fn();
        deleteLimiterHandler(limiterReq, limiterRes, next);

        expect(mockLyricsMutationLimiter).toHaveBeenCalledWith(
            limiterReq,
            limiterRes,
            next
        );
        expect(next).toHaveBeenCalledTimes(1);

        const req = { params: { trackId: "track-1" } } as any;
        const res = createRes();
        await deleteLyricsHandler(req, res);

        expect(mockClearLyricsCache).toHaveBeenCalledWith("track-1");
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ message: "Lyrics cache cleared" });
    });

    it("returns 500 when clear lyrics cache fails", async () => {
        mockClearLyricsCache.mockRejectedValueOnce(new Error("db write failed"));
        const req = { params: { trackId: "track-1" } } as any;
        const res = createRes();

        await deleteLyricsHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to clear lyrics cache" });
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Clear lyrics cache error for track track-1:",
            expect.any(Error)
        );
    });
});
