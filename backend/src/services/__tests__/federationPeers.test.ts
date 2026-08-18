process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "federation-peers-test-secret-12345678";

const mockGetManifest = jest.fn();
const mockCreateFederationClient = jest.fn(() => ({
    getManifest: mockGetManifest,
}));
const mockPairFederationPeer = jest.fn();
const mockResolveBaseUrl = jest.fn((value: string) => new URL(value));
const mockEncrypt = jest.fn((value: string) => `v2:${value}`);
const mockDecrypt = jest.fn((value: string) => value.replace(/^v2:/, ""));
const mockConfig = {
    soundspanCallbackUrl: "http://backend:3006",
    federation: {
        instanceName: "Local Library",
        allowPrivatePeers: false,
    },
};
const mockRemoveReplacementCacheFiles = jest.fn();
const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);

const prisma = {
    systemSettings: {
        upsert: jest.fn(),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
    },
    federationPeer: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    federationPairingCode: {
        deleteMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
    },
    transcodedFile: {
        findMany: jest.fn(),
    },
    $transaction: jest.fn(),
};

jest.mock("../../utils/db", () => ({ prisma }));
jest.mock("../../config", () => ({
    config: mockConfig,
}));
jest.mock("../../utils/encryption", () => ({
    encrypt: mockEncrypt,
    decrypt: mockDecrypt,
}));
jest.mock("../../utils/logger", () => ({ logger: mockLogger }));
jest.mock("../federationClient", () => ({
    createFederationClient: mockCreateFederationClient,
    pairFederationPeer: mockPairFederationPeer,
    resolveBaseUrl: mockResolveBaseUrl,
}));
jest.mock("../trackReplacement", () => ({
    removeReplacementCacheFiles: mockRemoveReplacementCacheFiles,
}));

import { hashApiKey } from "../../utils/apiKeyHash";
import {
    consumePairingCode,
    consumeFederationPairingRequest,
    createBothFederationPeer,
    createFederationPairingCode,
    createHostFederationPeer,
    deleteFederationPeer,
    FederationPeerConflictError,
    FederationScopeMismatchError,
    getConsumerPeerConnection,
    linkConsumerFederationPeer,
    listFederationPeers,
    pairAndLinkConsumerFederationPeer,
    revokeFederationPeer,
    rotateFederationPeerCredential,
    updateFederationPeerSettings,
} from "../federationPeers";

const manifest = {
    instanceId: "remote-instance-1",
    name: "Remote Library",
    version: "2.0.2",
    catalogEpoch: "epoch-9",
    mediaTypes: ["artist", "album", "track"],
    counts: { artists: 1, albums: 2, tracks: 3 },
    embeddingsAvailable: true,
};

describe("federation peer credentials", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockConfig.soundspanCallbackUrl = "http://backend:3006";
        mockConfig.federation.allowPrivatePeers = false;
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
        prisma.federationPeer.update.mockImplementation(async ({ data }) => ({
            id: "peer-1",
            createdAt: new Date("2026-08-15T12:00:00.000Z"),
            updatedAt: new Date("2026-08-15T12:00:00.000Z"),
            inboundStatus: "ACTIVE",
            ...data,
        }));
        prisma.federationPeer.updateMany.mockResolvedValue({ count: 1 });
        prisma.transcodedFile.findMany.mockResolvedValue([]);
        mockRemoveReplacementCacheFiles.mockResolvedValue(undefined);
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
                inboundStatus: "ACTIVE",
                outboundStatus: null,
            }),
            select: expect.not.objectContaining({ credentialHash: true }),
        });
        expect(JSON.stringify(result.peer)).not.toContain(result.token);
    });

    it("rotates a credential and invalidates the old hash", async () => {
        prisma.federationPeer.findFirst
            .mockResolvedValueOnce({
                id: "peer-1",
                inboundStatus: "OFFLINE",
            })
            .mockResolvedValueOnce({
                id: "peer-1",
                inboundStatus: "OFFLINE",
            });
        const result = await rotateFederationPeerCredential("peer-1");

        expect(result?.token).toMatch(/^[0-9a-f]{64}$/);
        expect(prisma.federationPeer.updateMany).toHaveBeenCalledWith({
            where: {
                id: "peer-1",
                inboundStatus: "OFFLINE",
            },
            data: {
                credentialHash: hashApiKey(result!.token),
                inboundStatus: "OFFLINE",
            },
        });
    });

    it("does not rotate consumer-direction credentials", async () => {
        prisma.federationPeer.findFirst.mockResolvedValueOnce(null);

        await expect(
            rotateFederationPeerCredential("consumer-1"),
        ).resolves.toBeNull();
        expect(prisma.federationPeer.updateMany).not.toHaveBeenCalled();
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
            data: {
                inboundStatus: "REVOKED",
                outboundStatus: "REVOKED",
                credentialHash: null,
                outboundToken: null,
            },
        });
    });

    it("updates settings through the public peer projection", async () => {
        prisma.federationPeer.updateMany.mockResolvedValueOnce({ count: 1 });
        prisma.federationPeer.findUnique.mockResolvedValueOnce({
            id: "peer-1",
            showDedupedCopies: true,
            maxConcurrentStreams: 4,
            maxStreamKbps: 320,
        });

        await expect(
            updateFederationPeerSettings("peer-1", {
                showDedupedCopies: true,
                maxConcurrentStreams: 4,
                maxStreamKbps: 320,
            }),
        ).resolves.toEqual(
            expect.objectContaining({
                id: "peer-1",
                showDedupedCopies: true,
            }),
        );
        expect(prisma.federationPeer.findUnique).toHaveBeenCalledWith({
            where: { id: "peer-1" },
            select: expect.objectContaining({
                showDedupedCopies: true,
                maxConcurrentStreams: true,
                maxStreamKbps: true,
            }),
        });
    });

    it("removes federated cache files after peer deletion cascades their rows", async () => {
        prisma.transcodedFile.findMany.mockResolvedValue([
            { cachePath: "peer-track-medium.audio" },
        ]);
        prisma.federationPeer.deleteMany.mockResolvedValue({ count: 1 });

        await expect(deleteFederationPeer("peer-1")).resolves.toBe(true);

        expect(prisma.transcodedFile.findMany).toHaveBeenCalledWith({
            where: { track: { peerId: "peer-1" } },
            select: { cachePath: true },
        });
        expect(mockRemoveReplacementCacheFiles).toHaveBeenCalledWith([
            "peer-track-medium.audio",
        ]);
    });
});

describe("federation consumer peers", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockConfig.federation.allowPrivatePeers = false;
        prisma.federationPeer.findFirst.mockResolvedValue(null);
        mockGetManifest.mockResolvedValue(manifest);
        mockPairFederationPeer.mockResolvedValue({
            token: "paired-token",
            peer: {
                id: "remote-peer",
                scopes: ["library:read", "stream:read"],
            },
        });
        prisma.federationPairingCode.deleteMany.mockResolvedValue({ count: 0 });
        prisma.federationPairingCode.findUnique.mockResolvedValue(null);
        prisma.federationPairingCode.create.mockResolvedValue({});
        prisma.systemSettings.upsert.mockResolvedValue({});
        prisma.systemSettings.updateMany.mockResolvedValue({ count: 1 });
        prisma.systemSettings.findUnique.mockResolvedValue({
            federationInstanceId: "instance-1",
            catalogEpoch: "epoch-1",
        });
        prisma.federationPeer.update.mockImplementation(async ({ data }) => ({
            id: "local-host-row",
            createdAt: new Date("2026-08-15T12:00:00.000Z"),
            updatedAt: new Date("2026-08-15T12:00:00.000Z"),
            inboundStatus: "ACTIVE",
            ...data,
        }));
        prisma.federationPeer.create.mockImplementation(async ({ data }) => {
            const { outboundToken: _outboundToken, ...publicData } = data;
            return {
                id: "consumer-peer-1",
                createdAt: new Date("2026-08-15T12:00:00.000Z"),
                updatedAt: new Date("2026-08-15T12:00:00.000Z"),
                ...publicData,
            };
        });
    });

    it("validates the manifest before storing an encrypted outbound token", async () => {
        const result = await linkConsumerFederationPeer({
            baseUrl: "https://peer.example/",
            token: "raw-token",
            name: "Chosen Name",
            createdById: "admin-1",
        });

        expect(mockCreateFederationClient).toHaveBeenCalledWith(
            {
                id: "pending-link",
                baseUrl: "https://peer.example",
                outboundToken: "v2:raw-token",
            },
            { allowPrivatePeers: false },
        );
        expect(prisma.federationPeer.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                name: "Chosen Name",
                direction: "CONSUMER",
                baseUrl: "https://peer.example",
                outboundToken: "v2:raw-token",
                scopes: ["library:read", "stream:read", "embeddings:read"],
                inboundStatus: null,
                outboundStatus: "ACTIVE",
                catalogEpoch: "epoch-9",
                createdById: "admin-1",
                lastSeenAt: expect.any(Date),
            }),
            select: expect.not.objectContaining({ outboundToken: true }),
        });
        expect(JSON.stringify(result)).not.toContain("raw-token");
    });

    it("does not write a peer when manifest validation fails", async () => {
        mockGetManifest.mockRejectedValueOnce(new Error("malformed peer"));

        await expect(
            linkConsumerFederationPeer({
                baseUrl: "https://peer.example",
                token: "raw-token",
                createdById: "admin-1",
            }),
        ).rejects.toThrow("malformed peer");
        expect(prisma.federationPeer.create).not.toHaveBeenCalled();
    });

    it("threads the private-peer escape hatch through validation and requests", async () => {
        mockConfig.federation.allowPrivatePeers = true;

        await linkConsumerFederationPeer({
            baseUrl: "https://10.0.0.8",
            token: "raw-token",
            createdById: "admin-1",
        });

        expect(mockResolveBaseUrl).toHaveBeenCalledWith(
            "https://10.0.0.8",
            true,
        );
        expect(mockCreateFederationClient).toHaveBeenCalledWith(
            expect.objectContaining({ baseUrl: "https://10.0.0.8" }),
            { allowPrivatePeers: true },
        );
    });

    it("creates a manual BOTH peer with independent active statuses", async () => {
        const result = await createBothFederationPeer({
            baseUrl: "https://peer.example",
            outboundToken: "remote-token",
            name: "Mutual Peer",
            createdById: "admin-1",
            scopes: ["library:read", "stream:read"],
        });

        expect(result.token).toMatch(/^[0-9a-f]{64}$/);
        expect(prisma.federationPeer.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                direction: "BOTH",
                inboundStatus: "ACTIVE",
                outboundStatus: "ACTIVE",
                credentialHash: hashApiKey(result.token),
                outboundToken: "v2:remote-token",
            }),
            select: expect.any(Object),
        });
    });

    it("exchanges a pairing code and then runs the same validated link flow", async () => {
        await pairAndLinkConsumerFederationPeer({
            baseUrl: "https://peer.example",
            code: "ABCDEFGH",
            name: "Consumer Name",
            createdById: "admin-1",
        });

        expect(mockPairFederationPeer).toHaveBeenCalledWith({
            baseUrl: "https://peer.example",
            code: "ABCDEFGH",
            name: "Consumer Name",
            options: { allowPrivatePeers: false },
        });
        expect(mockCreateFederationClient).toHaveBeenCalledWith(
            expect.objectContaining({ outboundToken: "v2:paired-token" }),
            { allowPrivatePeers: false },
        );
        expect(mockEncrypt).toHaveBeenCalledWith("paired-token");
    });

    it("does not request a reciprocal callback unless BOTH is selected", async () => {
        mockConfig.soundspanCallbackUrl = "https://consumer.example/app";

        const result = await pairAndLinkConsumerFederationPeer({
            baseUrl: "https://host.example",
            code: "ABCDEFGH",
            name: "Consumer Name",
            createdById: "admin-1",
        });

        expect(mockPairFederationPeer).toHaveBeenCalledWith({
            baseUrl: "https://host.example",
            code: "ABCDEFGH",
            name: "Consumer Name",
            options: { allowPrivatePeers: false },
        });
        expect(prisma.federationPairingCode.create).not.toHaveBeenCalled();
        expect(result.peer).toEqual(
            expect.objectContaining({ direction: "CONSUMER" }),
        );
    });

    it("sends the configured consumer URL instead of the host URL", async () => {
        mockConfig.soundspanCallbackUrl = "https://consumer.example/app";

        await pairAndLinkConsumerFederationPeer({
            baseUrl: "https://host.example",
            code: "ABCDEFGH",
            name: "Consumer Name",
            createdById: "admin-1",
            direction: "BOTH",
        });

        expect(mockPairFederationPeer).toHaveBeenCalledWith(
            expect.objectContaining({
                baseUrl: "https://host.example",
                code: "ABCDEFGH",
                name: "Consumer Name",
                consumerBaseUrl: "https://consumer.example",
                reciprocalPairingCode:
                    expect.stringMatching(/^[A-HJ-NP-Z2-9]{8}$/),
                reciprocalScopes: ["library:read", "stream:read"],
                options: { allowPrivatePeers: false },
            }),
        );
    });

    it("upgrades the reciprocal callback row instead of creating a duplicate", async () => {
        mockConfig.soundspanCallbackUrl = "https://consumer.example";
        mockPairFederationPeer.mockResolvedValue({
            token: "paired-token",
            reciprocalPeerId: "local-host-row",
            peer: {
                id: "remote-both-row",
                scopes: ["library:read", "stream:read"],
            },
        });
        prisma.federationPeer.findFirst.mockResolvedValue({
            id: "local-host-row",
        });

        const result = await pairAndLinkConsumerFederationPeer({
            baseUrl: "https://host.example",
            code: "ABCDEFGH",
            name: "Consumer Name",
            createdById: "admin-1",
            direction: "BOTH",
        });

        expect(result.peer).toEqual(
            expect.objectContaining({
                id: "local-host-row",
                direction: "BOTH",
            }),
        );
        expect(prisma.federationPeer.create).not.toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ direction: "CONSUMER" }),
            }),
        );
        expect(prisma.federationPeer.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "local-host-row" },
                data: expect.objectContaining({
                    direction: "BOTH",
                    outboundStatus: "ACTIVE",
                }),
            }),
        );
    });

    it("keeps a degraded reciprocal upgrade within the shared scope grant", async () => {
        mockConfig.soundspanCallbackUrl = "https://consumer.example";
        mockPairFederationPeer.mockResolvedValue({
            token: "paired-token",
            reciprocalPeerId: "local-host-row",
            warning: "remote upgrade failed",
            peer: {
                id: "remote-host-row",
                scopes: ["library:read", "stream:read", "embeddings:read"],
            },
        });
        prisma.federationPeer.findFirst.mockResolvedValue({
            id: "local-host-row",
        });

        const result = await pairAndLinkConsumerFederationPeer({
            baseUrl: "https://host.example",
            code: "ABCDEFGH",
            name: "Consumer Name",
            createdById: "admin-1",
            direction: "BOTH",
        });

        expect(result.warning).toBe("remote upgrade failed");
        expect(prisma.federationPeer.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    direction: "BOTH",
                    scopes: ["library:read", "stream:read"],
                }),
            }),
        );
    });

    it("rejects a duplicate normalized non-revoked consumer URL", async () => {
        prisma.federationPeer.findFirst.mockResolvedValueOnce({
            id: "existing-peer",
        });

        await expect(
            linkConsumerFederationPeer({
                baseUrl: "https://peer.example/path",
                token: "raw-token",
                createdById: "admin-1",
            }),
        ).rejects.toMatchObject({ name: "FederationPeerConflictError" });
        expect(mockGetManifest).not.toHaveBeenCalled();
        expect(prisma.federationPeer.create).not.toHaveBeenCalled();
    });

    it("checks for a duplicate URL when a reciprocal upgrade target is stale", async () => {
        prisma.federationPeer.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "existing-peer" });

        await expect(
            linkConsumerFederationPeer({
                baseUrl: "https://peer.example/path",
                token: "raw-token",
                createdById: "admin-1",
                upgradePeerId: "stale-host-row",
            }),
        ).rejects.toBeInstanceOf(FederationPeerConflictError);
        expect(prisma.federationPeer.create).not.toHaveBeenCalled();
    });

    it("uses a stable typed error when paired scopes do not overlap", async () => {
        mockConfig.soundspanCallbackUrl = "https://consumer.example";
        mockPairFederationPeer.mockResolvedValueOnce({
            token: "paired-token",
            reciprocalPeerId: "local-host-row",
            peer: { id: "remote-peer", scopes: ["embeddings:read"] },
        });

        await expect(
            pairAndLinkConsumerFederationPeer({
                baseUrl: "https://peer.example",
                code: "ABCDEFGH",
                name: "Consumer Name",
                createdById: "admin-1",
                scopes: ["stream:read"],
                direction: "BOTH",
            }),
        ).rejects.toBeInstanceOf(FederationScopeMismatchError);
        expect(prisma.federationPeer.create).not.toHaveBeenCalled();
    });

    it("decrypts outbound credentials only for internal peer calls", async () => {
        prisma.federationPeer.findUnique.mockResolvedValueOnce({
            id: "consumer-peer-1",
            baseUrl: "https://peer.example",
            outboundToken: "v2:stored-token",
            direction: "CONSUMER",
            outboundStatus: "ACTIVE",
        });

        await expect(
            getConsumerPeerConnection("consumer-peer-1"),
        ).resolves.toEqual({
            id: "consumer-peer-1",
            baseUrl: "https://peer.example",
            outboundToken: "stored-token",
            direction: "CONSUMER",
            outboundStatus: "ACTIVE",
        });
        expect(mockDecrypt).toHaveBeenCalledWith("v2:stored-token");
    });
});

describe("federation pairing codes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockConfig.federation.allowPrivatePeers = false;
        mockConfig.soundspanCallbackUrl = "http://backend:3006";
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
        prisma.federationPeer.update.mockImplementation(async ({ data }) => ({
            id: "peer-1",
            direction: "BOTH",
            inboundStatus: "ACTIVE",
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
        }));
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
            expiresAt: new Date(Date.now() + 60_000),
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

    it("completes the host side of reciprocal pairing as one BOTH row", async () => {
        mockConfig.soundspanCallbackUrl = "https://host.example";
        prisma.federationPairingCode.findUnique.mockResolvedValue({
            id: "code-1",
            code: "ABCDEFGH",
            createdById: "admin-1",
            scopes: ["library:read", "stream:read"],
            expiresAt: new Date(Date.now() + 60_000),
            usedAt: null,
        });
        mockPairFederationPeer.mockResolvedValue({
            token: "reciprocal-token",
            peer: { id: "consumer-host-row" },
        });

        const result = await consumeFederationPairingRequest({
            code: "ABCDEFGH",
            name: "Consumer",
            baseUrl: "https://consumer.example",
            reciprocalPairingCode: "HGFEDCBA",
            reciprocalScopes: ["library:read", "stream:read"],
        });

        expect(result).toEqual(
            expect.objectContaining({
                reciprocalPeerId: "consumer-host-row",
                peer: expect.objectContaining({ direction: "BOTH" }),
            }),
        );
        expect(prisma.federationPeer.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    direction: "BOTH",
                    outboundToken: "v2:reciprocal-token",
                    outboundStatus: "ACTIVE",
                }),
            }),
        );
    });

    it("keeps the issued HOST link when reciprocal pairing fails", async () => {
        mockConfig.soundspanCallbackUrl = "https://host.example";
        prisma.federationPairingCode.findUnique.mockResolvedValue({
            id: "code-1",
            code: "ABCDEFGH",
            createdById: "admin-1",
            scopes: ["library:read", "stream:read"],
            expiresAt: new Date(Date.now() + 60_000),
            usedAt: null,
        });
        mockPairFederationPeer.mockRejectedValue(
            new Error("callback failed with reciprocal-token"),
        );

        const result = await consumeFederationPairingRequest({
            code: "ABCDEFGH",
            name: "Consumer",
            baseUrl: "https://consumer.example",
            reciprocalPairingCode: "HGFEDCBA",
            reciprocalScopes: ["library:read", "stream:read"],
        });

        expect(result).toEqual(
            expect.objectContaining({
                warning: expect.stringContaining("one-directional"),
                peer: expect.objectContaining({ direction: "HOST" }),
            }),
        );
        expect(prisma.federationPeer.update).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledWith(
            "Reciprocal federation pairing failed",
        );
        expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(
            "reciprocal-token",
        );
    });
});
