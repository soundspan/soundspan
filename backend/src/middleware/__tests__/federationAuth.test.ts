process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "federation-auth-test-secret-123456789";

const mockFindUnique = jest.fn();
const mockUpdateMany = jest.fn();
const mockLogger = {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);

jest.mock("../../utils/db", () => ({
    prisma: {
        federationPeer: {
            findUnique: (...args: unknown[]) => mockFindUnique(...args),
            updateMany: (...args: unknown[]) => mockUpdateMany(...args),
        },
    },
}));
jest.mock("../../utils/logger", () => ({ logger: mockLogger }));

import type { NextFunction, Request, Response } from "express";
import { hashApiKey } from "../../utils/apiKeyHash";
import { requireFederationPeer } from "../federationAuth";

function createResponse() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn((code: number) => {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn((body: unknown) => {
            res.body = body;
            return res;
        }),
    };
    return res;
}

function peer(overrides: Record<string, unknown> = {}) {
    return {
        id: "peer-1",
        name: "Peer One",
        direction: "HOST",
        scopes: ["library:read", "stream:read"],
        capabilities: ["track-attrs-loudness", "future-capability"],
        inboundStatus: "ACTIVE",
        lastSeenAt: new Date("2026-08-15T10:00:00.000Z"),
        maxConcurrentStreams: null,
        maxStreamKbps: null,
        ...overrides,
    };
}

describe("requireFederationPeer", () => {
    const rawToken = "a".repeat(64);

    beforeEach(() => {
        jest.clearAllMocks();
        mockUpdateMany.mockResolvedValue({ count: 1 });
    });

    it.each([
        ["missing", undefined, null],
        ["unknown", `Bearer ${rawToken}`, null],
        ["revoked", `Bearer ${rawToken}`, peer({ inboundStatus: "REVOKED" })],
    ])(
        "returns a uniform 401 for %s credentials",
        async (_name, auth, record) => {
            mockFindUnique.mockResolvedValue(record);
            const req = { headers: { authorization: auth } } as Request;
            const res = createResponse();
            const next = jest.fn() as NextFunction;

            await requireFederationPeer("library:read")(
                req,
                res as unknown as Response,
                next,
            );

            expect(res.statusCode).toBe(401);
            expect(res.body).toEqual({
                error: "Federation peer authentication required",
            });
            expect(next).not.toHaveBeenCalled();
            expect(req.user).toBeUndefined();
        },
    );

    it("keeps BOTH inbound auth active when outbound health is offline", async () => {
        mockFindUnique.mockResolvedValue(
            peer({
                direction: "BOTH",
                inboundStatus: "ACTIVE",
                outboundStatus: "OFFLINE",
            }),
        );
        const req = {
            headers: { authorization: `Bearer ${rawToken}` },
        } as Request;
        const next = jest.fn() as NextFunction;

        await requireFederationPeer("library:read")(
            req,
            createResponse() as unknown as Response,
            next,
        );

        expect(next).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["HOST", true],
        ["BOTH", true],
        ["CONSUMER", false],
    ])(
        "enforces the %s inbound direction capability",
        async (direction, allowed) => {
            mockFindUnique.mockResolvedValue(peer({ direction }));
            const req = {
                headers: { authorization: `Bearer ${rawToken}` },
            } as Request;
            const res = createResponse();
            const next = jest.fn() as NextFunction;

            await requireFederationPeer("library:read")(
                req,
                res as unknown as Response,
                next,
            );

            expect(next).toHaveBeenCalledTimes(allowed ? 1 : 0);
            expect(res.statusCode).toBe(allowed ? 200 : 401);
        },
    );

    it("returns 403 when the authenticated peer lacks a required scope", async () => {
        mockFindUnique.mockImplementation(async ({ where }) =>
            where.credentialHash === hashApiKey(rawToken)
                ? peer({ scopes: ["library:read"] })
                : null,
        );
        const req = {
            headers: { authorization: `Bearer ${rawToken}` },
        } as Request;
        const res = createResponse();
        const next = jest.fn() as NextFunction;

        await requireFederationPeer("stream:read")(
            req,
            res as unknown as Response,
            next,
        );

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: "Federation peer scope required" });
        expect(next).not.toHaveBeenCalled();
    });

    it("treats malformed persisted scopes as invalid credentials", async () => {
        mockFindUnique.mockResolvedValue(peer({ scopes: ["unknown:scope"] }));
        const req = {
            headers: { authorization: `Bearer ${rawToken}` },
        } as Request;
        const res = createResponse();
        const next = jest.fn() as NextFunction;

        await requireFederationPeer("library:read")(
            req,
            res as unknown as Response,
            next,
        );

        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });

    it("attaches peer identity without touching user identity", async () => {
        mockFindUnique.mockImplementation(async ({ where }) =>
            where.credentialHash === hashApiKey(rawToken)
                ? peer({ lastSeenAt: null })
                : null,
        );
        const req = {
            headers: { authorization: `Bearer ${rawToken}` },
        } as Request;
        const res = createResponse();
        const next = jest.fn() as NextFunction;

        await requireFederationPeer("library:read")(
            req,
            res as unknown as Response,
            next,
        );

        expect(req.federationPeer).toEqual({
            id: "peer-1",
            name: "Peer One",
            scopes: ["library:read", "stream:read"],
            capabilities: ["track-attrs-loudness"],
            maxConcurrentStreams: null,
            maxStreamKbps: null,
        });
        expect(req.user).toBeUndefined();
        expect(next).toHaveBeenCalledTimes(1);
        expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    });

    it("does not update lastSeenAt while the stored value is fresh", async () => {
        jest.useFakeTimers().setSystemTime(
            new Date("2026-08-15T12:00:00.000Z"),
        );
        mockFindUnique.mockResolvedValue(
            peer({ lastSeenAt: new Date("2026-08-15T11:59:30.000Z") }),
        );
        const req = {
            headers: { authorization: `Bearer ${rawToken}` },
        } as Request;

        await requireFederationPeer("library:read")(
            req,
            createResponse() as unknown as Response,
            jest.fn(),
        );

        expect(mockUpdateMany).not.toHaveBeenCalled();
        jest.useRealTimers();
    });
});
