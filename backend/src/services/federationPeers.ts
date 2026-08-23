import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { hashApiKey } from "../utils/apiKeyHash";
import { prisma } from "../utils/db";
import {
    FEDERATION_SCOPE_VALUES,
    type FederationScope,
} from "../utils/federationScopes";
import {
    createFederationClient,
    resolveBaseUrl,
    type FederationManifest,
} from "./federationClient";
import {
    decryptFederationOutboundToken,
    encryptFederationOutboundToken,
} from "./federationCredentialCipher";
import type { FederationCapability } from "./federationCapabilities";
import { removeReplacementCacheFiles } from "./trackReplacement";

export { FEDERATION_SCOPE_VALUES } from "../utils/federationScopes";
export type { FederationScope } from "../utils/federationScopes";

const PEER_LIST_LIMIT = 500;

const publicPeerSelect = {
    id: true,
    name: true,
    direction: true,
    baseUrl: true,
    scopes: true,
    inboundStatus: true,
    outboundStatus: true,
    lastSeenAt: true,
    lastSyncSuccessAt: true,
    lastSyncDurationMs: true,
    lastErrorAt: true,
    lastError: true,
    lastSyncCursor: true,
    catalogEpoch: true,
    showDedupedCopies: true,
    maxConcurrentStreams: true,
    maxStreamKbps: true,
    createdAt: true,
    updatedAt: true,
} satisfies Prisma.FederationPeerSelect;

/** Public peer record with all credential material excluded. */
export type PublicFederationPeer = Prisma.FederationPeerGetPayload<{
    select: typeof publicPeerSelect;
}>;

/** Validated values used to issue a host-direction peer credential. */
export interface CreateHostPeerInput {
    name: string;
    createdById: string;
    scopes: FederationScope[];
    baseUrl?: string;
    capabilities?: FederationCapability[];
}

/** Validated administrator-controlled peer behavior settings. */
export interface FederationPeerSettingsInput {
    showDedupedCopies?: boolean;
    maxConcurrentStreams?: number | null;
    maxStreamKbps?: number | null;
}

/** A normalized active consumer URL is already linked. */
export class FederationPeerConflictError extends Error {
    constructor() {
        super("Federation consumer peer already exists");
        this.name = "FederationPeerConflictError";
    }
}

/** Validated values used to link a consumer-direction peer. */
export interface LinkConsumerPeerInput {
    baseUrl: string;
    token: string;
    name?: string;
    createdById: string;
    scopes?: FederationScope[];
}

function newCredential(): { token: string; credentialHash: string } {
    const token = randomBytes(32).toString("hex");
    return { token, credentialHash: hashApiKey(token) };
}

/** Ensures stable host identity and epoch values exist in SystemSettings. */
export async function ensureFederationIdentity(): Promise<{
    federationInstanceId: string;
    catalogEpoch: string;
}> {
    await prisma.systemSettings.upsert({
        where: { id: "default" },
        create: {
            id: "default",
            federationInstanceId: randomUUID(),
            catalogEpoch: randomUUID(),
        },
        update: {},
    });
    await fillMissingIdentityValues();
    const settings = await prisma.systemSettings.findUnique({
        where: { id: "default" },
        select: { federationInstanceId: true, catalogEpoch: true },
    });
    if (!settings?.federationInstanceId || !settings.catalogEpoch) {
        throw new Error("Federation identity initialization failed");
    }
    return {
        federationInstanceId: settings.federationInstanceId,
        catalogEpoch: settings.catalogEpoch,
    };
}

async function fillMissingIdentityValues(): Promise<void> {
    await prisma.systemSettings.updateMany({
        where: { id: "default", federationInstanceId: null },
        data: { federationInstanceId: randomUUID() },
    });
    await prisma.systemSettings.updateMany({
        where: { id: "default", catalogEpoch: null },
        data: { catalogEpoch: randomUUID() },
    });
}

async function createPeerWithClient(
    client: Prisma.TransactionClient | typeof prisma,
    input: CreateHostPeerInput,
): Promise<{ peer: PublicFederationPeer; token: string }> {
    const credential = newCredential();
    const peer = await client.federationPeer.create({
        data: {
            name: input.name.trim(),
            direction: "HOST",
            baseUrl: input.baseUrl,
            credentialHash: credential.credentialHash,
            scopes: input.scopes,
            capabilities: input.capabilities ?? [],
            inboundStatus: "ACTIVE",
            outboundStatus: null,
            createdById: input.createdById,
        },
        select: publicPeerSelect,
    });
    return { peer, token: credential.token };
}

/** Creates an active host-direction peer and returns its raw token once. */
export async function createHostFederationPeer(
    input: CreateHostPeerInput,
): Promise<{ peer: PublicFederationPeer; token: string }> {
    await ensureFederationIdentity();
    return createPeerWithClient(prisma, input);
}

/** Lists peers without credential hashes or outbound tokens. */
export async function listFederationPeers(): Promise<PublicFederationPeer[]> {
    return prisma.federationPeer.findMany({
        select: publicPeerSelect,
        orderBy: { createdAt: "desc" },
        take: PEER_LIST_LIMIT,
    });
}

/** Updates one peer's visibility and host stream limits without exposing credentials. */
export async function updateFederationPeerSettings(
    peerId: string,
    settings: FederationPeerSettingsInput,
): Promise<PublicFederationPeer | null> {
    const updated = await prisma.federationPeer.updateMany({
        where: { id: peerId },
        data: settings,
    });
    if (updated.count !== 1) return null;
    return prisma.federationPeer.findUnique({
        where: { id: peerId },
        select: publicPeerSelect,
    });
}

/** Replaces a non-revoked peer credential and returns the new token once. */
export async function rotateFederationPeerCredential(
    peerId: string,
): Promise<{ peer: PublicFederationPeer; token: string } | null> {
    const credential = newCredential();
    const current = await prisma.federationPeer.findFirst({
        where: {
            id: peerId,
            direction: { in: ["HOST", "BOTH"] },
            inboundStatus: { not: "REVOKED" },
            credentialHash: { not: null },
        },
        select: { id: true, inboundStatus: true },
    });
    if (!current) return null;
    const nextStatus =
        current.inboundStatus === "PENDING" ? "ACTIVE" : current.inboundStatus;
    const result = await prisma.federationPeer.updateMany({
        where: { id: peerId, inboundStatus: current.inboundStatus },
        data: {
            credentialHash: credential.credentialHash,
            inboundStatus: nextStatus,
        },
    });
    if (result.count !== 1) return null;
    const peer = await prisma.federationPeer.findFirst({
        where: { id: peerId },
        select: publicPeerSelect,
    });
    return peer ? { peer, token: credential.token } : null;
}

/** Marks a peer revoked while retaining the row for audit. */
export async function revokeFederationPeer(peerId: string): Promise<boolean> {
    const result = await prisma.federationPeer.updateMany({
        where: { id: peerId },
        data: {
            inboundStatus: "REVOKED",
            outboundStatus: "REVOKED",
            credentialHash: null,
            outboundToken: null,
        },
    });
    return result.count === 1;
}

function normalizeConsumerBaseUrl(value: string): string {
    return resolveBaseUrl(value, config.federation.allowPrivatePeers).origin;
}

export function outboundClientOptions() {
    return {
        allowPrivatePeers: config.federation.allowPrivatePeers,
        allowProxy: config.federation.allowProxy,
    };
}

function consumerScopes(
    embeddingsAvailable: boolean,
    socialAvailable: boolean,
): FederationScope[] {
    const scopes: FederationScope[] = ["library:read", "stream:read"];
    if (embeddingsAvailable) scopes.push("embeddings:read");
    if (socialAvailable) scopes.push("social:read");
    return scopes;
}

async function findDuplicateConsumerPeer(
    baseUrl: string,
): Promise<{ id: string } | null> {
    return prisma.federationPeer.findFirst({
        where: {
            baseUrl,
            direction: { in: ["CONSUMER", "BOTH"] },
            outboundStatus: { not: "REVOKED" },
        },
        select: { id: true },
    });
}

async function persistConsumerLink(
    input: LinkConsumerPeerInput,
    baseUrl: string,
    outboundToken: string,
    manifest: FederationManifest,
): Promise<PublicFederationPeer> {
    const scopes =
        input.scopes ??
        consumerScopes(
            manifest.embeddingsAvailable,
            manifest.socialAvailable === true,
        );
    const shared = {
        name: input.name?.trim() || manifest.name,
        baseUrl,
        outboundToken,
        scopes,
        outboundStatus: "ACTIVE" as const,
        lastSeenAt: new Date(),
        catalogEpoch: manifest.catalogEpoch,
        capabilities: manifest.capabilities,
    };
    return prisma.federationPeer.create({
        data: {
            ...shared,
            direction: "CONSUMER",
            inboundStatus: null,
            createdById: input.createdById,
        },
        select: publicPeerSelect,
    });
}

/** Validates a remote manifest before persisting an encrypted consumer token. */
export async function linkConsumerFederationPeer(
    input: LinkConsumerPeerInput,
): Promise<PublicFederationPeer> {
    const baseUrl = normalizeConsumerBaseUrl(input.baseUrl);
    const duplicate = await findDuplicateConsumerPeer(baseUrl);
    if (duplicate) throw new FederationPeerConflictError();
    const outboundToken = encryptFederationOutboundToken(input.token);
    const manifest = await createFederationClient(
        { id: "pending-link", baseUrl, outboundToken },
        outboundClientOptions(),
    ).getManifest();
    return persistConsumerLink(input, baseUrl, outboundToken, manifest);
}

/** Loads and decrypts a consumer credential for internal-only peer calls. */
export async function getConsumerPeerConnection(peerId: string) {
    const peer = await prisma.federationPeer.findUnique({
        where: { id: peerId },
        select: {
            id: true,
            baseUrl: true,
            outboundToken: true,
            direction: true,
            outboundStatus: true,
        },
    });
    if (!peer?.outboundToken) return null;
    return {
        ...peer,
        outboundToken: decryptFederationOutboundToken(peer.outboundToken),
    };
}

/** Permanently deletes a peer record selected by an administrator. */
export async function deleteFederationPeer(peerId: string): Promise<boolean> {
    const cachedFiles = await prisma.transcodedFile.findMany({
        where: { track: { peerId } },
        select: { cachePath: true },
    });
    const result = await prisma.federationPeer.deleteMany({
        where: { id: peerId },
    });
    if (result.count === 1) {
        await removeReplacementCacheFiles(
            cachedFiles.map((file) => file.cachePath),
        );
    }
    return result.count === 1;
}
