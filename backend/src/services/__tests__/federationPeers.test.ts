process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "federation-peers-test-secret-12345678";

const mockGetManifest = jest.fn();
const mockCreateFederationClient = jest.fn(() => ({
    getManifest: mockGetManifest,
}));
const mockResolveBaseUrl = jest.fn((value: string) => new URL(value));
const mockEncrypt = jest.fn((value: string) => `v2:${value}`);
const mockDecrypt = jest.fn((value: string) => value.replace(/^v2:/, ""));
const mockConfig = {
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
    transcodedFile: {
        findMany: jest.fn(),
    },
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
    resolveBaseUrl: mockResolveBaseUrl,
}));
jest.mock("../trackReplacement", () => ({
    removeReplacementCacheFiles: mockRemoveReplacementCacheFiles,
}));

import { hashApiKey } from "../../utils/apiKeyHash";
import {
    createHostFederationPeer,
    deleteFederationPeer,
    getConsumerPeerConnection,
    linkConsumerFederationPeer,
    listFederationPeers,
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
    socialAvailable: true,
    capabilities: ["track-attrs-loudness"],
};

describe("federation peer credentials", () => {
    beforeEach(() => {
        jest.clearAllMocks();
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
                scopes: [
                    "library:read",
                    "stream:read",
                    "embeddings:read",
                    "social:read",
                ],
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

    it("stores no social grant when a legacy manifest has no signal", async () => {
        const { socialAvailable: _socialAvailable, ...legacyManifest } =
            manifest;
        mockGetManifest.mockResolvedValueOnce({
            ...legacyManifest,
            embeddingsAvailable: false,
        });

        await linkConsumerFederationPeer({
            baseUrl: "https://legacy.example",
            token: "legacy-token",
            createdById: "admin-1",
        });

        expect(prisma.federationPeer.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    scopes: ["library:read", "stream:read"],
                }),
            }),
        );
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
