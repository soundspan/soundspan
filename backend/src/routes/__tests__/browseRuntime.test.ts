import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: Request, _res: Response, next: () => void) =>
        next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const deezerService = {
    parseUrl: jest.fn(),
};

jest.mock("../../services/deezer", () => ({
    deezerService,
}));

const spotifyService = {
    parseUrl: jest.fn(),
};

jest.mock("../../services/spotify", () => ({
    spotifyService,
}));

jest.mock("../../services/youtubeMusic", () => ({
    ytMusicService: {},
}));

import router from "../browse";
import { createMockJsonResponse } from "./helpers/mockJsonResponse";

function getHandler(path: string, method: "get" | "post") {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );

    if (!layer) {
        throw new Error(`${method.toUpperCase()} route not found: ${path}`);
    }

    return layer.route.stack[layer.route.stack.length - 1].handle;
}

const createRes = createMockJsonResponse;

describe("browse route runtime", () => {
    const parsePlaylistUrl = getHandler("/playlists/parse", "post");
    const deprecatedPaths = [
        "/playlists/featured",
        "/playlists/search",
        "/playlists/:id",
        "/radios",
        "/radios/by-genre",
        "/radios/:id",
        "/genres",
        "/genres/:id",
        "/genres/:id/playlists",
        "/all",
    ] as const;

    beforeEach(() => {
        jest.clearAllMocks();
        deezerService.parseUrl.mockReturnValue(null);
        spotifyService.parseUrl.mockReturnValue(null);
    });

    it("returns 410 for deprecated Deezer browse endpoints", async () => {
        for (const path of deprecatedPaths) {
            const handler = getHandler(path, "get");
            const req = { params: { id: "id-1" }, query: {} } as any;
            const res = createRes();

            await handler(req, res);

            expect(res.statusCode).toBe(410);
            expect(res.body).toEqual({
                error: "Deezer browse has been replaced by YouTube Music. Use /api/browse/ytmusic/* endpoints instead.",
            });
        }
    });

    it("parses deezer and spotify playlist URLs", async () => {
        deezerService.parseUrl.mockReturnValueOnce({
            type: "playlist",
            id: "dz-1",
        });

        const deezerReq = {
            body: { url: "https://www.deezer.com/playlist/dz-1" },
        } as any;
        const deezerRes = createRes();

        await parsePlaylistUrl(deezerReq, deezerRes);

        expect(deezerRes.statusCode).toBe(200);
        expect(deezerRes.body).toEqual({
            source: "deezer",
            type: "playlist",
            id: "dz-1",
            url: "https://www.deezer.com/playlist/dz-1",
        });

        spotifyService.parseUrl.mockReturnValueOnce({
            type: "playlist",
            id: "sp-1",
        });

        const spotifyReq = {
            body: { url: "https://open.spotify.com/playlist/sp-1" },
        } as any;
        const spotifyRes = createRes();

        await parsePlaylistUrl(spotifyReq, spotifyRes);

        expect(spotifyRes.statusCode).toBe(200);
        expect(spotifyRes.body).toEqual({
            source: "spotify",
            type: "playlist",
            id: "sp-1",
            url: "https://open.spotify.com/playlist/sp-1",
        });
    });

    it("validates parse URL request and handles unsupported/error paths", async () => {
        const missingReq = { body: {} } as any;
        const missingRes = createRes();

        await parsePlaylistUrl(missingReq, missingRes);

        expect(missingRes.statusCode).toBe(400);
        expect(missingRes.body).toEqual({ error: "URL is required" });

        const unsupportedReq = {
            body: { url: "https://example.com/not-a-playlist" },
        } as any;
        const unsupportedRes = createRes();

        await parsePlaylistUrl(unsupportedReq, unsupportedRes);

        expect(unsupportedRes.statusCode).toBe(400);
        expect(unsupportedRes.body).toEqual({
            error: "Invalid or unsupported URL. Please provide a Spotify or Deezer playlist URL.",
        });

        deezerService.parseUrl.mockImplementationOnce(() => {
            throw new Error("parse exploded");
        });

        const errorReq = {
            body: { url: "https://www.deezer.com/playlist/dz-1" },
        } as any;
        const errorRes = createRes();

        await parsePlaylistUrl(errorReq, errorRes);

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "parse exploded" });
    });
});
