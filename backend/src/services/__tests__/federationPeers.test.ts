process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "federation-peers-test-secret-12345678";

const prisma = {
    systemSettings: {
        upsert: jest.fn(),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
    },
    federationPeer: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    federationPairingCode: {
        deleteMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
};

jest.mock("../../utils/db", () => ({ prisma }));

import { hashApiKey } from "../../utils/apiKeyHash";
import {
    consumePairingCode,
    createFederationPairingCode,
    createHostFederationPeer,
    deleteFederationPeer,
    listFederationPeers,
    revokeFederationPeer,
    rotateFederationPeerCredential,
} from "../federationPeers";

describe("federation peer credentials", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.systemSettings.upsert.mockResolvedValue({});
        prisma.systemSettings.updateMany.mockResolvedValue({ count: 1 });
        prisma.systemSettings.findUnique.mockResolvedValue({
            federationInstanceId: "instance-1",
            catalogEpoch: "epoch-1",
        });
        prisma.systemSettings.upsert.mockResolvedValue({});
        prisma.systemSettings.updateMany.mockResolvedValue({ count: 1 });
        prisma.systemSettings.findUnique.mockResolvedValue({
            federationInstanceId: "instance-1",
            catalogEpoch: "epoch-1",
        });
        prisma.federationPeer.create.mockImplementation(async ({ data }) => ({
            id: "peer-1",
            createdAt: new Date("2026-08-15T12:00:00.000Z"),
            updatedAt: new Date("2026-08-15T12:00:00.000Z"),
            lastSeenAt: null,
            ...data,
        }));
        prisma.federationPeer.findFirst.mockResolvedValue({ id: "peer-1" });
        prisma.federationPeer.updateMany.mockResolvedValue({ count: 1 });
    });

    it("returns a 32-byte token once and stores only its HMAC", async () => {
        const result = await createHostFederationPeer({
            name: " Peer One ",
            createdById: "admin-1",
            scopes: ["library:read", "stream:read"],
        });

        expect(result.token).toMatch(/^[0-9a-f]{64}$/);
        expect(prisma.federationPeer.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                name: "Peer One",
                credentialHash: hashApiKey(result.token),
                direction: "HOST",
                status: "ACTIVE",
            }),
            select: expect.not.objectContaining({ credentialHash: true }),
        });
        expect(JSON.stringify(result.peer)).not.toContain(result.token);
    });

    it("rotates a credential and invalidates the old hash", async () => {
        const result = await rotateFederationPeerCredential("peer-1");

        expect(result?.token).toMatch(/^[0-9a-f]{64}$/);
        expect(prisma.federationPeer.updateMany).toHaveBeenCalledWith({
            where: { id: "peer-1", status: { not: "REVOKED" } },
            data: {
                credentialHash: hashApiKey(result!.token),
                status: "ACTIVE",
            },
        });
    });

    it("lists without secrets, revokes for audit, and supports explicit deletion", async () => {
        prisma.federationPeer.findMany.mockResolvedValueOnce([
            { id: "peer-1", name: "Peer One" },
        ]);
        prisma.federationPeer.deleteMany.mockResolvedValueOnce({ count: 1 });

        await expect(listFederationPeers()).resolves.toEqual([
            { id: "peer-1", name: "Peer One" },
        ]);
        await expect(revokeFederationPeer("peer-1")).resolves.toBe(true);
        await expect(deleteFederationPeer("peer-1")).resolves.toBe(true);

        const listArgs = prisma.federationPeer.findMany.mock.calls[0][0];
        expect(listArgs.take).toBe(500);
        expect(listArgs.select).not.toHaveProperty("credentialHash");
        expect(listArgs.select).not.toHaveProperty("outboundToken");
        expect(prisma.federationPeer.updateMany).toHaveBeenCalledWith({
            where: { id: "peer-1" },
            data: { status: "REVOKED", credentialHash: null },
        });
    });
});

describe("federation pairing codes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.federationPairingCode.deleteMany.mockResolvedValue({ count: 0 });
        prisma.federationPairingCode.findUnique.mockResolvedValue(null);
        prisma.federationPairingCode.create.mockImplementation(
            async ({ data }) => ({
                id: "code-1",
                ...data,
            }),
        );
        prisma.federationPairingCode.updateMany.mockResolvedValue({ count: 1 });
        prisma.federationPeer.create.mockImplementation(async ({ data }) => ({
            id: "peer-1",
            createdAt: new Date(),
            updatedAt: new Date(),
            lastSeenAt: null,
            ...data,
        }));
        prisma.$transaction.mockImplementation(async (callback) =>
            callback(prisma),
        );
    });

    it("creates an eight-character code with a five-minute lifetime", async () => {
        jest.useFakeTimers().setSystemTime(
            new Date("2026-08-15T12:00:00.000Z"),
        );

        const code = await createFederationPairingCode({
            createdById: "admin-1",
            scopes: ["library:read"],
        });

        expect(code.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
        expect(code.expiresAt).toEqual(new Date("2026-08-15T12:05:00.000Z"));
        jest.useRealTimers();
    });

    it("rejects expired and already-used codes without creating peers", async () => {
        for (const record of [
            { expiresAt: new Date("2026-08-15T11:59:00.000Z"), usedAt: null },
            {
                expiresAt: new Date("2026-08-15T12:05:00.000Z"),
                usedAt: new Date(),
            },
        ]) {
            prisma.federationPairingCode.findUnique.mockResolvedValueOnce({
                id: "code-1",
                code: "ABCDEFGH",
                createdById: "admin-1",
                scopes: ["library:read"],
                ...record,
            });
            await expect(
                consumePairingCode(
                    {
                        code: "ABCDEFGH",
                        name: "Peer",
                        baseUrl: "https://peer.example",
                    },
                    new Date("2026-08-15T12:00:00.000Z"),
                ),
            ).resolves.toBeNull();
        }
        expect(prisma.federationPeer.create).not.toHaveBeenCalled();
    });

    it("consumes a code once before minting the peer token", async () => {
        prisma.federationPairingCode.findUnique.mockResolvedValue({
            id: "code-1",
            code: "ABCDEFGH",
            createdById: "admin-1",
            scopes: ["library:read", "stream:read"],
            expiresAt: new Date("2026-08-15T12:05:00.000Z"),
            usedAt: null,
        });

        const result = await consumePairingCode(
            { code: "abcdefgh", name: "Peer", baseUrl: "https://peer.example" },
            new Date("2026-08-15T12:00:00.000Z"),
        );

        expect(prisma.federationPairingCode.updateMany).toHaveBeenCalledWith({
            where: {
                id: "code-1",
                usedAt: null,
                expiresAt: { gt: new Date("2026-08-15T12:00:00.000Z") },
            },
            data: { usedAt: new Date("2026-08-15T12:00:00.000Z") },
        });
        expect(result?.token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("does not mint a token when another request consumed the code first", async () => {
        prisma.federationPairingCode.findUnique.mockResolvedValue({
            id: "code-1",
            code: "ABCDEFGH",
            createdById: "admin-1",
            scopes: ["library:read"],
            expiresAt: new Date("2026-08-15T12:05:00.000Z"),
            usedAt: null,
        });
        prisma.federationPairingCode.updateMany.mockResolvedValueOnce({
            count: 0,
        });

        await expect(
            consumePairingCode(
                {
                    code: "ABCDEFGH",
                    name: "Peer",
                    baseUrl: "https://peer.example",
                },
                new Date("2026-08-15T12:00:00.000Z"),
            ),
        ).resolves.toBeNull();
        expect(prisma.federationPeer.create).not.toHaveBeenCalled();
    });

    it("rejects malformed persisted scopes before claiming a code", async () => {
        prisma.federationPairingCode.findUnique.mockResolvedValue({
            id: "code-1",
            code: "ABCDEFGH",
            createdById: "admin-1",
            scopes: ["unknown:scope"],
            expiresAt: new Date("2026-08-15T12:05:00.000Z"),
            usedAt: null,
        });

        await expect(
            consumePairingCode(
                {
                    code: "ABCDEFGH",
                    name: "Peer",
                    baseUrl: "https://peer.example",
                },
                new Date("2026-08-15T12:00:00.000Z"),
            ),
        ).resolves.toBeNull();
        expect(prisma.federationPairingCode.updateMany).not.toHaveBeenCalled();
    });
});
