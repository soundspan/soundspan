import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";

const getStream = jest.fn();
const createFederationClient = jest.fn(() => ({ getStream }));
const getCachedFederatedStreamFilePath = jest.fn();
const cacheFederatedStream = jest.fn();
const streamFileWithRangeSupport = jest.fn();
const destroyStreamingService = jest.fn();
const logDebug = jest.fn();
const logInfo = jest.fn();
const prisma = {
    federationPeer: { updateMany: jest.fn() },
};

jest.mock("../../utils/db", () => ({ prisma }));
jest.mock("../federationClient", () => ({
    createFederationClient,
    FederationHttpError: class FederationHttpError extends Error {
        constructor(
            public readonly status: number | null,
            public readonly transient: boolean,
        ) {
            super("peer error");
        }
    },
}));
jest.mock("../audioStreaming", () => ({
    FederatedCacheCapacityError: class FederatedCacheCapacityError extends Error {
        constructor() {
            super("Federated cache fill exceeded remaining capacity");
        }
    },
    AudioStreamingService: jest.fn(() => ({
        getCachedFederatedStreamFilePath,
        cacheFederatedStream,
        streamFileWithRangeSupport,
        destroy: destroyStreamingService,
    })),
}));
jest.mock("../../utils/logger", () => ({
    logger: {
        child: jest.fn(() => ({
            debug: logDebug,
            info: logInfo,
        })),
    },
}));
jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/music",
            transcodeCachePath: "/cache",
            transcodeCacheMaxGb: 2,
        },
    },
}));

import { proxyFederatedTrackStream } from "../federationStreamProxy";

function createRequest(range?: string) {
    const request = new EventEmitter() as EventEmitter & {
        headers: Record<string, string | undefined>;
    };
    request.headers = { range };
    return request;
}

function createResponse() {
    const response = new PassThrough() as PassThrough & {
        statusCode: number;
        headers: Record<string, string>;
        status: (code: number) => typeof response;
        setHeader: (name: string, value: string) => typeof response;
    };
    response.statusCode = 200;
    response.headers = {};
    response.status = (code) => {
        response.statusCode = code;
        return response;
    };
    response.setHeader = (name, value) => {
        response.headers[name.toLowerCase()] = String(value);
        return response;
    };
    return response;
}

const peer = {
    id: "peer-1",
    baseUrl: "https://peer.example",
    outboundToken: "encrypted-token",
};

describe("federated stream proxy", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.federationPeer.updateMany.mockResolvedValue({ count: 1 });
        getCachedFederatedStreamFilePath.mockResolvedValue(null);
        cacheFederatedStream.mockImplementation(
            async (_trackId, _quality, _modified, _mime, loadStream) => {
                await loadStream();
                return {
                    filePath: "/cache/federated.audio",
                    mimeType: "audio/flac",
                };
            },
        );
        streamFileWithRangeSupport.mockResolvedValue(undefined);
    });

    it.each([200, 206, 416])(
        "passes through %s, Range, and bounded response headers",
        async (status) => {
            getStream.mockResolvedValueOnce({
                status,
                headers: {
                    "content-type": "audio/flac",
                    "content-length": "5",
                    "accept-ranges": "bytes",
                    "content-range": "bytes 0-4/5",
                    authorization: "Bearer must-not-leak",
                },
                data: Readable.from(["audio"]),
            });
            const req = createRequest("bytes=0-4");
            const res = createResponse();
            let body = "";
            res.on("data", (chunk) => {
                body += chunk.toString();
            });

            await proxyFederatedTrackStream({
                req: req as never,
                res: res as never,
                peer,
                remoteId: "remote-track-1",
                trackId: "fed-track-1",
                sourceModified: new Date("2026-08-15T12:00:00.000Z"),
                sourceMime: "audio/flac",
                quality: "original",
            });

            expect(getStream).toHaveBeenCalledWith({
                remoteId: "remote-track-1",
                quality: "original",
                range: "bytes=0-4",
                signal: expect.any(AbortSignal),
            });
            expect(res.statusCode).toBe(status);
            expect(res.headers).toEqual({
                "content-type": "audio/flac",
                "content-length": "5",
                "accept-ranges": "bytes",
                "content-range": "bytes 0-4/5",
            });
            expect(body).toBe("audio");
            expect(cacheFederatedStream).not.toHaveBeenCalled();
            expect(JSON.stringify(res.headers)).not.toContain("must-not-leak");
        },
    );

    it("aborts and destroys the upstream when the consumer disconnects", async () => {
        const upstream = new PassThrough();
        let upstreamSignal: AbortSignal | undefined;
        getStream.mockImplementationOnce(async (input) => {
            upstreamSignal = input.signal;
            return { status: 200, headers: {}, data: upstream };
        });
        const req = createRequest("bytes=0-");
        const res = createResponse();
        const operation = proxyFederatedTrackStream({
            req: req as never,
            res: res as never,
            peer,
            remoteId: "remote-track-1",
            trackId: "fed-track-1",
            sourceModified: new Date("2026-08-15T12:00:00.000Z"),
            sourceMime: "audio/flac",
            quality: "medium",
        });
        await new Promise<void>((resolve) => setImmediate(resolve));

        res.emit("close");
        await operation;

        expect(upstreamSignal?.aborted).toBe(true);
        expect(upstream.destroyed).toBe(true);
    });

    it("marks the peer offline after a transient upstream failure", async () => {
        const { FederationHttpError } = jest.requireMock("../federationClient");
        getStream.mockRejectedValueOnce(new FederationHttpError(503, true));

        await expect(
            proxyFederatedTrackStream({
                req: createRequest() as never,
                res: createResponse() as never,
                peer,
                remoteId: "remote-track-1",
                trackId: "fed-track-1",
                sourceModified: new Date("2026-08-15T12:00:00.000Z"),
                sourceMime: "audio/flac",
                quality: "original",
            }),
        ).rejects.toThrow("peer error");
        expect(prisma.federationPeer.updateMany).toHaveBeenCalledWith({
            where: { id: "peer-1", outboundStatus: "ACTIVE" },
            data: { outboundStatus: "OFFLINE" },
        });
    });

    it("fills a non-Range miss and serves the completed cached file", async () => {
        getStream.mockResolvedValueOnce({
            status: 200,
            headers: { "content-type": "audio/flac" },
            data: Readable.from(["audio"]),
        });
        const req = createRequest();
        const res = createResponse();

        await proxyFederatedTrackStream({
            req: req as never,
            res: res as never,
            peer,
            remoteId: "remote-track-1",
            trackId: "fed-track-1",
            sourceModified: new Date("2026-08-15T12:00:00.000Z"),
            sourceMime: "audio/flac",
            quality: "original",
        });

        expect(getStream).toHaveBeenCalledWith(
            expect.objectContaining({ range: undefined }),
        );
        expect(cacheFederatedStream).toHaveBeenCalledTimes(1);
        expect(streamFileWithRangeSupport).toHaveBeenCalledWith(
            req,
            res,
            "/cache/federated.audio",
            "audio/flac",
        );
    });

    it("passes through a known-length response that exceeds cache capacity", async () => {
        getStream.mockResolvedValueOnce({
            status: 200,
            headers: {
                "content-type": "audio/flac",
                "content-length": "999999999999",
                "accept-ranges": "bytes",
            },
            data: Readable.from(["audio"]),
        });
        cacheFederatedStream.mockImplementationOnce(
            async (_trackId, _quality, _modified, _mime, loadStream) =>
                loadStream(),
        );
        const req = createRequest();
        const res = createResponse();
        let body = "";
        res.on("data", (chunk) => {
            body += chunk.toString();
        });

        await proxyFederatedTrackStream({
            req: req as never,
            res: res as never,
            peer,
            remoteId: "remote-track-1",
            trackId: "fed-track-1",
            sourceModified: new Date("2026-08-15T12:00:00.000Z"),
            sourceMime: "audio/flac",
            quality: "original",
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers).toEqual({
            "content-type": "audio/flac",
            "content-length": "999999999999",
            "accept-ranges": "bytes",
        });
        expect(body).toBe("audio");
        expect(streamFileWithRangeSupport).not.toHaveBeenCalled();
    });

    it("retries an unknown-length capacity overflow as uncached passthrough", async () => {
        const { FederatedCacheCapacityError } =
            jest.requireMock("../audioStreaming");
        const overflowStream = Readable.from(["discarded"]);
        getStream
            .mockResolvedValueOnce({
                status: 200,
                headers: { "content-type": "audio/flac" },
                data: overflowStream,
            })
            .mockResolvedValueOnce({
                status: 200,
                headers: { "content-type": "audio/flac" },
                data: Readable.from(["fresh-audio"]),
            });
        cacheFederatedStream.mockImplementationOnce(
            async (_trackId, _quality, _modified, _mime, loadStream) => {
                const source = await loadStream();
                source.stream.destroy();
                throw new FederatedCacheCapacityError();
            },
        );
        const req = createRequest();
        const res = createResponse();
        let body = "";
        res.on("data", (chunk) => {
            body += chunk.toString();
        });

        await proxyFederatedTrackStream({
            req: req as never,
            res: res as never,
            peer,
            remoteId: "remote-track-1",
            trackId: "fed-track-1",
            sourceModified: new Date("2026-08-15T12:00:00.000Z"),
            sourceMime: "audio/flac",
            quality: "original",
        });

        expect(getStream).toHaveBeenCalledTimes(2);
        expect(body).toBe("fresh-audio");
        expect(streamFileWithRangeSupport).not.toHaveBeenCalled();
        expect(prisma.federationPeer.updateMany).not.toHaveBeenCalled();
        expect(logDebug).toHaveBeenCalledTimes(1);
        expect(logDebug).toHaveBeenCalledWith(
            "Federated stream cache capacity exceeded; retrying uncached",
            { peerId: "peer-1", trackId: "fed-track-1" },
        );
    });

    it.each([206, 416])(
        "passes through non-200 status %s without serving a cache file",
        async (status) => {
            getStream.mockResolvedValueOnce({
                status,
                headers: { "content-range": "bytes */5" },
                data: Readable.from([]),
            });
            cacheFederatedStream.mockImplementationOnce(
                async (_trackId, _quality, _modified, _mime, loadStream) =>
                    loadStream(),
            );
            const res = createResponse();

            await proxyFederatedTrackStream({
                req: createRequest() as never,
                res: res as never,
                peer,
                remoteId: "remote-track-1",
                trackId: "fed-track-1",
                sourceModified: new Date("2026-08-15T12:00:00.000Z"),
                sourceMime: "audio/flac",
                quality: "original",
            });

            expect(res.statusCode).toBe(status);
            expect(streamFileWithRangeSupport).not.toHaveBeenCalled();
        },
    );

    it("destroys the response after a non-transient mid-stream Range failure", async () => {
        const upstream = new PassThrough();
        getStream.mockResolvedValueOnce({
            status: 206,
            headers: { "content-range": "bytes 0-4/5" },
            data: upstream,
        });
        const res = createResponse();
        const operation = proxyFederatedTrackStream({
            req: createRequest("bytes=0-4") as never,
            res: res as never,
            peer,
            remoteId: "remote-track-1",
            trackId: "fed-track-1",
            sourceModified: new Date("2026-08-15T12:00:00.000Z"),
            sourceMime: "audio/flac",
            quality: "original",
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        upstream.destroy(new Error("decoder stream failed"));

        await expect(operation).resolves.toBeUndefined();
        expect(res.destroyed).toBe(true);
        expect(prisma.federationPeer.updateMany).not.toHaveBeenCalled();
    });

    it("serves Range requests from a complete cache hit without peer I/O", async () => {
        getCachedFederatedStreamFilePath.mockResolvedValueOnce({
            filePath: "/cache/federated.audio",
            mimeType: "audio/mpeg",
        });
        const req = createRequest("bytes=10-19");
        const res = createResponse();

        await proxyFederatedTrackStream({
            req: req as never,
            res: res as never,
            peer,
            remoteId: "remote-track-1",
            trackId: "fed-track-1",
            sourceModified: new Date("2026-08-15T12:00:00.000Z"),
            sourceMime: "audio/mpeg",
            quality: "medium",
        });

        expect(getStream).not.toHaveBeenCalled();
        expect(cacheFederatedStream).not.toHaveBeenCalled();
        expect(streamFileWithRangeSupport).toHaveBeenCalledWith(
            req,
            res,
            "/cache/federated.audio",
            "audio/mpeg",
        );
    });
});
