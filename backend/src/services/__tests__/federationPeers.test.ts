process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "federation-peers-test-secret-12345678";

const mockGetManifest = jest.fn();
const mockCreateFederationClient = jest.fn(() => ({
    getManifest: mockGetManifest,
}));
const mockPairFederationPeer = jest.fn();
const mockResolveBaseUrl = jest.fn((value: string) => new URL(value));
const mockResolveFederationInstanceName = jest.fn();
const mockEncrypt = jest.fn((value: string) => `v2:${value}`);
const mockDecrypt = jest.fn((value: string) => value.replace(/^v2:/, ""));
const mockConfig = {
    soundspanCallbackUrl: "http://backend:3006",
    federation: {
        instanceName: "Local Library",
        allowPrivatePeers: false,
        allowProxy: false,
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
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
    },
    transcodedFile: {
        findMany: jest.fn(),
    },
    $executeRaw: jest.fn(),
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
jest.mock("../federationInstanceName", () => ({
    resolveFederationInstanceName: mockResolveFederationInstanceName,
}));
jest.mock("../trackReplacement", () => ({
    removeReplacementCacheFiles: mockRemoveReplacementCacheFiles,
}));

import { hashApiKey } from "../../utils/apiKeyHash";
import {
    consumePairingCode,
    consumeFederationPairingRequest,
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
    capabilities: ["track-attrs-loudness"],
};

describe("federation peer credentials", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockConfig.soundspanCallbackUrl = "http://backend:3006";
        mockConfig.federation.allowPrivatePeers = false;
        mockConfig.federation.allowProxy = false;
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
        mockResolveFederationInstanceName.mockResolvedValue("This Soundspan");
        prisma.federationPairingCode.deleteMany.mockResolvedValue({ count: 0 });
        prisma.federationPairingCode.findMany.mockResolvedValue([]);
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
            { allowPrivatePeers: false, allowProxy: false },
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
                capabilities: ["track-attrs-loudness"],
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
            { allowPrivatePeers: true, allowProxy: false },
        );
    });

    it("sends the instance identity while retaining the local peer label", async () => {
        const result = await pairAndLinkConsumerFederationPeer({
            baseUrl: "https://peer.example",
            code: "ABCDEFGH",
            name: "Local Peer Label",
            createdById: "admin-1",
        });

        expect(mockPairFederationPeer).toHaveBeenCalledWith({
            baseUrl: "https://peer.example",
            code: "ABCDEFGH",
            name: "This Soundspan",
            requestedScopes: ["library:read", "stream:read"],
            options: { allowPrivatePeers: false, allowProxy: false },
        });
        expect(mockCreateFederationClient).toHaveBeenCalledWith(
            expect.objectContaining({ outboundToken: "v2:paired-token" }),
            { allowPrivatePeers: false, allowProxy: false },
        );
        expect(mockEncrypt).toHaveBeenCalledWith("paired-token");
        expect(prisma.federationPeer.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ name: "Local Peer Label" }),
            }),
        );
        expect(result.peer).toEqual(
            expect.objectContaining({ name: "Local Peer Label" }),
        );
    });

    it("never mints or sends reciprocal pairing data", async () => {
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
            name: "This Soundspan",
            requestedScopes: ["library:read", "stream:read"],
            options: { allowPrivatePeers: false, allowProxy: false },
        });
        expect(prisma.federationPairingCode.create).not.toHaveBeenCalled();
        expect(result.peer).toEqual(
            expect.objectContaining({ direction: "CONSUMER" }),
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

    it("rejects a duplicate paired URL before redeeming the remote code", async () => {
        prisma.federationPeer.findFirst.mockResolvedValueOnce({
            id: "existing-peer",
        });

        await expect(
            pairAndLinkConsumerFederationPeer({
                baseUrl: "https://peer.example/path",
                code: "ABCDEFGH",
                name: "Local Peer Label",
                createdById: "admin-1",
            }),
        ).rejects.toBeInstanceOf(FederationPeerConflictError);
        expect(mockPairFederationPeer).not.toHaveBeenCalled();
        expect(mockCreateFederationClient).not.toHaveBeenCalled();
        expect(prisma.federationPeer.create).not.toHaveBeenCalled();
    });

    it("uses a stable typed error when paired scopes do not overlap", async () => {
        mockPairFederationPeer.mockResolvedValueOnce({
            token: "paired-token",
            peer: { id: "remote-peer", scopes: ["embeddings:read"] },
        });

        await expect(
            pairAndLinkConsumerFederationPeer({
                baseUrl: "https://peer.example",
                code: "ABCDEFGH",
                name: "Consumer Name",
                createdById: "admin-1",
                scopes: ["stream:read"],
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

function installSerializedTransactions(): () => boolean {
    let transactionTail = Promise.resolve();
    let inTransaction = false;
    prisma.$transaction.mockImplementation((callback) => {
        const result = transactionTail.then(async () => {
            inTransaction = true;
            try {
                return await callback(prisma);
            } finally {
                inTransaction = false;
            }
        });
        transactionTail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    });
    return () => inTransaction;
}

function installPairingCodeRaceStore(
    isInTransaction: () => boolean,
): Set<string> {
    const liveCodes = new Set(["old-1", "old-2", "old-3", "old-4"]);
    let firstCapDelete = true;
    let releaseFirstCapDelete: (() => void) | undefined;
    const secondCreateFinished = new Promise<void>((resolve) => {
        releaseFirstCapDelete = resolve;
    });
    prisma.federationPairingCode.findMany.mockImplementation(async () =>
        [...liveCodes]
            .slice(-4)
            .reverse()
            .map((id) => ({ id })),
    );
    prisma.federationPairingCode.deleteMany.mockImplementation(
        async ({ where }) => {
            const retained = where.id?.notIn as string[] | undefined;
            if (!retained) return { count: 0 };
            if (!isInTransaction() && firstCapDelete) {
                firstCapDelete = false;
                await secondCreateFinished;
            }
            const removed = [...liveCodes].filter(
                (id) => !retained.includes(id),
            );
            removed.forEach((id) => liveCodes.delete(id));
            return { count: removed.length };
        },
    );
    let createCount = 0;
    prisma.federationPairingCode.create.mockImplementation(async ({ data }) => {
        liveCodes.add(data.code);
        createCount += 1;
        if (createCount === 1) releaseFirstCapDelete?.();
        return { id: `created-${createCount}`, ...data };
    });
    return liveCodes;
}

describe("federation pairing codes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockConfig.federation.allowPrivatePeers = false;
        mockConfig.federation.allowProxy = false;
        mockConfig.soundspanCallbackUrl = "http://backend:3006";
        prisma.federationPairingCode.deleteMany.mockResolvedValue({ count: 0 });
        prisma.federationPairingCode.findMany.mockResolvedValue([]);
        prisma.federationPairingCode.findUnique.mockResolvedValue(null);
        prisma.federationPairingCode.create.mockImplementation(
            async ({ data }) => ({
                id: "code-1",
                ...data,
            }),
        );
        prisma.federationPairingCode.updateMany.mockResolvedValue({ count: 1 });
        prisma.$executeRaw.mockResolvedValue(1);
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

    it("creates an eight-character code with a thirty-minute lifetime", async () => {
        jest.useFakeTimers().setSystemTime(
            new Date("2026-08-15T12:00:00.000Z"),
        );

        const code = await createFederationPairingCode({
            createdById: "admin-1",
            scopes: ["library:read"],
        });

        expect(code.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
        expect(code.expiresAt).toEqual(new Date("2026-08-15T12:30:00.000Z"));
        jest.useRealTimers();
    });

    it("removes expired codes without clobbering live codes", async () => {
        jest.useFakeTimers().setSystemTime(
            new Date("2026-08-15T12:00:00.000Z"),
        );
        prisma.federationPairingCode.findMany.mockResolvedValue([
            { id: "live-1" },
            { id: "live-2" },
        ]);

        await createFederationPairingCode({
            createdById: "admin-1",
            scopes: ["library:read"],
        });

        expect(prisma.federationPairingCode.deleteMany).toHaveBeenNthCalledWith(
            1,
            {
                where: {
                    createdById: "admin-1",
                    expiresAt: {
                        lte: new Date("2026-08-15T12:00:00.000Z"),
                    },
                },
            },
        );
        expect(prisma.federationPairingCode.deleteMany).toHaveBeenNthCalledWith(
            2,
            {
                where: expect.objectContaining({
                    id: { notIn: ["live-1", "live-2"] },
                    expiresAt: {
                        gt: new Date("2026-08-15T12:00:00.000Z"),
                    },
                }),
            },
        );
        jest.useRealTimers();
    });

    it("retains only four live codes before creating the fifth", async () => {
        prisma.federationPairingCode.findMany.mockResolvedValue([
            { id: "live-5" },
            { id: "live-4" },
            { id: "live-3" },
            { id: "live-2" },
        ]);

        await createFederationPairingCode({
            createdById: "admin-1",
            scopes: ["library:read"],
        });

        expect(prisma.federationPairingCode.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                orderBy: { createdAt: "desc" },
                take: 4,
            }),
        );
        expect(prisma.federationPairingCode.deleteMany).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                where: expect.objectContaining({
                    id: { notIn: ["live-5", "live-4", "live-3", "live-2"] },
                }),
            }),
        );
    });

    it("keeps a second request's newly created code during prune interleaving", async () => {
        const isInTransaction = installSerializedTransactions();
        const liveCodes = installPairingCodeRaceStore(isInTransaction);

        const [first, second] = await Promise.all([
            createFederationPairingCode({
                createdById: "admin-1",
                scopes: ["library:read"],
            }),
            createFederationPairingCode({
                createdById: "admin-1",
                scopes: ["library:read"],
            }),
        ]);

        expect(liveCodes).toContain(first.code);
        expect(liveCodes).toContain(second.code);
        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    });

    it("returns not_found when no code exists", async () => {
        prisma.federationPairingCode.findUnique.mockResolvedValue(null);

        await expect(
            consumePairingCode({ code: "ABCDEFGH", name: "Peer" }),
        ).resolves.toEqual({ ok: false, reason: "not_found" });
    });

    it("returns used for an already claimed code", async () => {
        prisma.federationPairingCode.findUnique.mockResolvedValue({
            id: "code-1",
            code: "ABCDEFGH",
            createdById: "admin-1",
            scopes: ["library:read"],
            expiresAt: new Date("2026-08-15T12:05:00.000Z"),
            usedAt: new Date("2026-08-15T11:59:00.000Z"),
        });

        await expect(
            consumePairingCode(
                { code: "ABCDEFGH", name: "Peer" },
                new Date("2026-08-15T12:00:00.000Z"),
            ),
        ).resolves.toEqual({ ok: false, reason: "used" });
    });

    it("returns expired for an elapsed unused code", async () => {
        prisma.federationPairingCode.findUnique.mockResolvedValue({
            id: "code-1",
            code: "ABCDEFGH",
            createdById: "admin-1",
            scopes: ["library:read"],
            expiresAt: new Date("2026-08-15T11:59:00.000Z"),
            usedAt: null,
        });

        await expect(
            consumePairingCode(
                { code: "ABCDEFGH", name: "Peer" },
                new Date("2026-08-15T12:00:00.000Z"),
            ),
        ).resolves.toEqual({ ok: false, reason: "expired" });
    });

    it("returns scope_mismatch when requested scopes exceed the grant", async () => {
        prisma.federationPairingCode.findUnique.mockResolvedValue({
            id: "code-1",
            code: "ABCDEFGH",
            createdById: "admin-1",
            scopes: ["library:read"],
            expiresAt: new Date("2026-08-15T12:05:00.000Z"),
            usedAt: null,
        });

        await expect(
            consumePairingCode(
                {
                    code: "ABCDEFGH",
                    name: "Peer",
                    requestedScopes: ["stream:read"],
                },
                new Date("2026-08-15T12:00:00.000Z"),
            ),
        ).resolves.toEqual({ ok: false, reason: "scope_mismatch" });
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
        expect(result).toEqual(
            expect.objectContaining({
                ok: true,
                token: expect.stringMatching(/^[0-9a-f]{64}$/),
            }),
        );
        expect(prisma.federationPeer.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ capabilities: [] }),
            }),
        );
    });

    it("persists capabilities advertised while consuming a pairing code", async () => {
        prisma.federationPairingCode.findUnique.mockResolvedValue({
            id: "code-1",
            code: "ABCDEFGH",
            createdById: "admin-1",
            scopes: ["library:read"],
            expiresAt: new Date(Date.now() + 60_000),
            usedAt: null,
        });

        await consumePairingCode(
            {
                code: "ABCDEFGH",
                name: "Peer",
                capabilities: ["track-attrs-loudness"],
            },
            new Date("2026-08-15T12:00:00.000Z"),
        );

        expect(prisma.federationPeer.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    capabilities: ["track-attrs-loudness"],
                }),
            }),
        );
    });

    it("returns not_found when another request wins the claim race", async () => {
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
        ).resolves.toEqual({ ok: false, reason: "not_found" });
        expect(prisma.federationPeer.create).not.toHaveBeenCalled();
    });

    it("returns invalid for malformed persisted scopes", async () => {
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
        ).resolves.toEqual({ ok: false, reason: "invalid" });
        expect(prisma.federationPairingCode.updateMany).not.toHaveBeenCalled();
    });

    it("ignores legacy reciprocal fields and creates only a HOST link", async () => {
        prisma.federationPairingCode.findUnique.mockResolvedValue({
            id: "code-1",
            code: "ABCDEFGH",
            createdById: "admin-1",
            scopes: ["library:read", "stream:read"],
            expiresAt: new Date(Date.now() + 60_000),
            usedAt: null,
        });
        const legacyRequest = {
            code: "ABCDEFGH",
            name: "Consumer",
            baseUrl: "https://consumer.example",
            reciprocalPairingCode: "HGFEDCBA",
            reciprocalScopes: ["library:read", "stream:read"],
        } as const;

        const result = await consumeFederationPairingRequest(legacyRequest);

        expect(result).toEqual(
            expect.objectContaining({
                ok: true,
                peer: expect.objectContaining({ direction: "HOST" }),
            }),
        );
        expect(mockPairFederationPeer).not.toHaveBeenCalled();
        expect(prisma.federationPeer.update).not.toHaveBeenCalled();
    });
});
