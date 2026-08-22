import { Readable, Writable } from "node:stream";
import type { Request, Response } from "express";

const mockTidalStream = jest.fn();
const mockYtMusicStream = jest.fn();

jest.mock("../tidalStreaming", () => ({
    tidalStreamingService: { getStreamProxy: mockTidalStream },
}));
jest.mock("../youtubeMusic", () => ({
    ytMusicService: { getStreamProxy: mockYtMusicStream },
}));

import { serveMappedProviderStream } from "../mappedProviderStream";

function responseSink(): Response {
    const sink = new Writable({
        write(_chunk, _encoding, callback) {
            callback();
        },
    }) as Writable & Partial<Response>;
    sink.headersSent = false;
    sink.status = jest.fn(() => sink as unknown as Response);
    sink.setHeader = jest.fn();
    return sink as unknown as Response;
}

function failingBody(res: Response, afterBytes: boolean): Readable {
    let read = false;
    return new Readable({
        read() {
            if (read) return;
            read = true;
            if (afterBytes) {
                (res as Response & { headersSent: boolean }).headersSent = true;
                this.push(Buffer.from("audio"));
            }
            this.destroy(new Error("upstream body failed"));
        },
    });
}

describe("mapped provider stream", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it.each([false, true])(
        "reports a destroyed response when the body fails afterBytes=%s",
        async (afterBytes) => {
            const res = responseSink();
            mockTidalStream.mockResolvedValueOnce({
                status: 200,
                headers: { "content-type": "audio/flac" },
                data: failingBody(res, afterBytes),
            });

            const result = await serveMappedProviderStream({
                req: { headers: {} } as Request,
                res,
                userId: "user-1",
                quality: "high",
                fallback: { source: "tidal", tidalTrackId: 42 },
            });

            expect(result).toMatchObject({
                status: "failed",
                responseState: {
                    headersSent: afterBytes,
                    destroyed: true,
                },
            });
            expect(mockTidalStream).toHaveBeenCalledWith(
                "user-1",
                42,
                "high",
                undefined,
            );
        },
    );

    it("passes the selected YouTube identity and quality", async () => {
        const res = responseSink();
        mockYtMusicStream.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: Readable.from([Buffer.from("audio")]),
        });

        await serveMappedProviderStream({
            req: { headers: { range: "bytes=0-99" } } as Request,
            res,
            userId: "user-1",
            youtubeUserId: "oauth-user-1",
            quality: "low",
            fallback: { source: "ytmusic", youtubeVideoId: "video-1" },
        });

        expect(mockYtMusicStream).toHaveBeenCalledWith(
            "oauth-user-1",
            "video-1",
            "low",
            "bytes=0-99",
        );
    });
});
