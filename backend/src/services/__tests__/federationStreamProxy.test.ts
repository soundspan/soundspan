import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";

const getStream = jest.fn();
const createFederationClient = jest.fn(() => ({ getStream }));
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
        const req = createRequest();
        const res = createResponse();
        const operation = proxyFederatedTrackStream({
            req: req as never,
            res: res as never,
            peer,
            remoteId: "remote-track-1",
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
                quality: "original",
            }),
        ).rejects.toThrow("peer error");
        expect(prisma.federationPeer.updateMany).toHaveBeenCalledWith({
            where: { id: "peer-1", status: "ACTIVE" },
            data: { status: "OFFLINE" },
        });
    });
});
