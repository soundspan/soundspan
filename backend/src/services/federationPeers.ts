import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { hashApiKey } from "../utils/apiKeyHash";
import { prisma } from "../utils/db";
import { decrypt, encrypt } from "../utils/encryption";
import {
    FEDERATION_SCOPE_VALUES,
    parseFederationScopes,
    type FederationScope,
} from "../utils/federationScopes";
import { createFederationClient, pairFederationPeer } from "./federationClient";

export { FEDERATION_SCOPE_VALUES } from "../utils/federationScopes";
export type { FederationScope } from "../utils/federationScopes";

const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ATTEMPTS = 10;
const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
const PEER_LIST_LIMIT = 500;

const publicPeerSelect = {
    id: true,
    name: true,
    direction: true,
    baseUrl: true,
    scopes: true,
    status: true,
    lastSeenAt: true,
    lastSyncCursor: true,
    catalogEpoch: true,
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
}

/** Validated public pairing request values. */
export interface PairingConsumeInput {
    code: string;
    name: string;
    baseUrl?: string;
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
            status: "ACTIVE",
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

/** Replaces a non-revoked peer credential and returns the new token once. */
export async function rotateFederationPeerCredential(
    peerId: string,
): Promise<{ peer: PublicFederationPeer; token: string } | null> {
    const credential = newCredential();
    const current = await prisma.federationPeer.findFirst({
        where: {
            id: peerId,
            direction: "HOST",
            status: { not: "REVOKED" },
        },
        select: { id: true, status: true },
    });
    if (!current) return null;
    const nextStatus = current.status === "PENDING" ? "ACTIVE" : current.status;
    const result = await prisma.federationPeer.updateMany({
        where: { id: peerId, direction: "HOST", status: current.status },
        data: { credentialHash: credential.credentialHash, status: nextStatus },
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
            status: "REVOKED",
            credentialHash: null,
            outboundToken: null,
        },
    });
    return result.count === 1;
}

function normalizeConsumerBaseUrl(value: string): string {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
        throw new Error("Federation peer base URL is invalid");
    }
    return parsed.origin;
}

function consumerScopes(embeddingsAvailable: boolean): FederationScope[] {
    return embeddingsAvailable
        ? ["library:read", "stream:read", "embeddings:read"]
        : ["library:read", "stream:read"];
}

/** Validates a remote manifest before persisting an encrypted consumer token. */
export async function linkConsumerFederationPeer(
    input: LinkConsumerPeerInput,
): Promise<PublicFederationPeer> {
    const baseUrl = normalizeConsumerBaseUrl(input.baseUrl);
    const duplicate = await prisma.federationPeer.findFirst({
        where: {
            baseUrl,
            direction: { in: ["CONSUMER", "BOTH"] },
            status: { not: "REVOKED" },
        },
        select: { id: true },
    });
    if (duplicate) throw new FederationPeerConflictError();
    const outboundToken = encrypt(input.token);
    const manifest = await createFederationClient({
        id: "pending-link",
        baseUrl,
        outboundToken,
    }).getManifest();
    return prisma.federationPeer.create({
        data: {
            name: input.name?.trim() || manifest.name,
            direction: "CONSUMER",
            baseUrl,
            outboundToken,
            scopes: consumerScopes(manifest.embeddingsAvailable),
            status: "ACTIVE",
            lastSeenAt: new Date(),
            catalogEpoch: manifest.catalogEpoch,
            createdById: input.createdById,
        },
        select: publicPeerSelect,
    });
}

/** Exchanges a short code, then links the resulting token through manifest validation. */
export async function pairAndLinkConsumerFederationPeer(input: {
    baseUrl: string;
    code: string;
    name: string;
    createdById: string;
}): Promise<PublicFederationPeer> {
    const baseUrl = normalizeConsumerBaseUrl(input.baseUrl);
    const callbackUrl = new URL(config.soundspanCallbackUrl);
    const consumerBaseUrl =
        callbackUrl.protocol === "https:" ? callbackUrl.origin : undefined;
    const paired = await pairFederationPeer({
        baseUrl,
        code: input.code,
        name: input.name,
        ...(consumerBaseUrl ? { consumerBaseUrl } : {}),
    });
    return linkConsumerFederationPeer({
        baseUrl,
        token: paired.token,
        name: input.name,
        createdById: input.createdById,
    });
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
            status: true,
        },
    });
    if (!peer?.outboundToken) return null;
    return { ...peer, outboundToken: decrypt(peer.outboundToken) };
}

/** Permanently deletes a peer record selected by an administrator. */
export async function deleteFederationPeer(peerId: string): Promise<boolean> {
    const result = await prisma.federationPeer.deleteMany({
        where: { id: peerId },
    });
    return result.count === 1;
}

function generatePairingCodeValue(): string {
    let code = "";
    for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
        code += PAIRING_CODE_ALPHABET.charAt(
            randomInt(0, PAIRING_CODE_ALPHABET.length),
        );
    }
    return code;
}

async function findAvailablePairingCode(): Promise<string> {
    for (let attempt = 0; attempt < PAIRING_CODE_ATTEMPTS; attempt += 1) {
        const code = generatePairingCodeValue();
        const existing = await prisma.federationPairingCode.findUnique({
            where: { code },
            select: { id: true },
        });
        if (!existing) return code;
    }
    throw new Error("Federation pairing code generation exhausted");
}

/** Creates one short-lived pairing code for an administrator-approved scope set. */
export async function createFederationPairingCode(input: {
    createdById: string;
    scopes: FederationScope[];
}): Promise<{ code: string; expiresAt: Date }> {
    const now = new Date();
    await prisma.federationPairingCode.deleteMany({
        where: { createdById: input.createdById, usedAt: null },
    });
    const code = await findAvailablePairingCode();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
    await prisma.federationPairingCode.create({
        data: {
            code,
            expiresAt,
            createdById: input.createdById,
            scopes: input.scopes,
        },
    });
    return { code, expiresAt };
}

/** Atomically consumes a valid code and returns the newly issued credential once. */
export async function consumePairingCode(
    input: PairingConsumeInput,
    now: Date = new Date(),
): Promise<{ peer: PublicFederationPeer; token: string } | null> {
    const code = await prisma.federationPairingCode.findUnique({
        where: { code: input.code.toUpperCase() },
    });
    if (!code || code.usedAt || code.expiresAt <= now) return null;
    const scopes = parseFederationScopes(code.scopes);
    if (!scopes) return null;
    await ensureFederationIdentity();
    return prisma.$transaction(async (transaction) => {
        const claimed = await transaction.federationPairingCode.updateMany({
            where: { id: code.id, usedAt: null, expiresAt: { gt: now } },
            data: { usedAt: now },
        });
        if (claimed.count !== 1) return null;
        return createPeerWithClient(transaction, {
            name: input.name,
            baseUrl: input.baseUrl,
            createdById: code.createdById,
            scopes,
        });
    });
}
