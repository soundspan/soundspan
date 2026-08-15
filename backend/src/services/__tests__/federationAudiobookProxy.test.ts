import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";

const getAudiobookStream = jest.fn();
const createFederationClient = jest.fn(() => ({ getAudiobookStream }));
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
jest.mock("../../utils/logger", () => ({
    logger: {
        child: jest.fn(() => ({ info: jest.fn() })),
    },
}));

import { proxyFederatedAudiobookStream } from "../federationAudiobookProxy";

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
        hasHeader: (name: string) => boolean;
    };
    response.headers = {};
    response.status = (code) => {
        response.statusCode = code;
        return response;
    };
    response.setHeader = (name, value) => {
        response.headers[name.toLowerCase()] = String(value);
        return response;
    };
    response.hasHeader = (name) => name.toLowerCase() in response.headers;
    return response;
}

const peer = {
    id: "peer-1",
    baseUrl: "https://peer.example",
    outboundToken: "encrypted-token",
};

describe("federated audiobook proxy", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.federationPeer.updateMany.mockResolvedValue({ count: 1 });
    });

    it("passes Range, status, and bounded response headers", async () => {
        getAudiobookStream.mockResolvedValueOnce({
            status: 206,
            headers: {
                "content-type": "audio/mpeg",
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

        await proxyFederatedAudiobookStream({
            req: req as never,
            res: res as never,
            peer,
            remoteId: "remote-book-1",
        });

        expect(getAudiobookStream).toHaveBeenCalledWith({
            remoteId: "remote-book-1",
            range: "bytes=0-4",
            signal: expect.any(AbortSignal),
        });
        expect(res.statusCode).toBe(206);
        expect(res.headers).toEqual({
            "content-type": "audio/mpeg",
            "content-length": "5",
            "accept-ranges": "bytes",
            "content-range": "bytes 0-4/5",
        });
        expect(body).toBe("audio");
    });

    it("marks the peer offline after a transient upstream failure", async () => {
        const { FederationHttpError } = jest.requireMock("../federationClient");
        getAudiobookStream.mockRejectedValueOnce(
            new FederationHttpError(503, true),
        );

        await expect(
            proxyFederatedAudiobookStream({
                req: createRequest() as never,
                res: createResponse() as never,
                peer,
                remoteId: "remote-book-1",
            }),
        ).rejects.toThrow("peer error");
        expect(prisma.federationPeer.updateMany).toHaveBeenCalledWith({
            where: { id: "peer-1", outboundStatus: "ACTIVE" },
            data: { outboundStatus: "OFFLINE" },
        });
    });
});
