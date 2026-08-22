import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { hashApiKey } from "../utils/apiKeyHash";
import {
    acquireUserScopedLock,
    USER_LOCK_NAMESPACES,
} from "../utils/advisoryLocks";
import { prisma } from "../utils/db";
import {
    FEDERATION_SCOPE_VALUES,
    parseFederationScopes,
    type FederationScope,
} from "../utils/federationScopes";
import {
    createFederationClient,
    pairFederationPeer,
    resolveBaseUrl,
    type FederationManifest,
} from "./federationClient";
import {
    decryptFederationOutboundToken,
    encryptFederationOutboundToken,
} from "./federationCredentialCipher";
import type { FederationCapability } from "./federationCapabilities";
import { resolveFederationInstanceName } from "./federationInstanceName";
import { removeReplacementCacheFiles } from "./trackReplacement";

export { FEDERATION_SCOPE_VALUES } from "../utils/federationScopes";
export type { FederationScope } from "../utils/federationScopes";

const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ATTEMPTS = 10;
const PAIRING_CODE_TTL_MS = 30 * 60 * 1000;
const MAX_LIVE_PAIRING_CODES = 5;
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

/** Validated public pairing request values. */
export interface PairingConsumeInput {
    code: string;
    name: string;
    baseUrl?: string;
    requestedScopes?: FederationScope[];
    capabilities?: FederationCapability[];
}

/** A normalized active consumer URL is already linked. */
export class FederationPeerConflictError extends Error {
    constructor() {
        super("Federation consumer peer already exists");
        this.name = "FederationPeerConflictError";
    }
}

/** Requested and granted federation scopes have no shared capability. */
export class FederationScopeMismatchError extends Error {
    readonly code = "FEDERATION_SCOPE_MISMATCH";

    constructor() {
        super("Federation peer scopes do not overlap");
        this.name = "FederationScopeMismatchError";
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

/**
 * Result of claiming a public federation pairing code.
 * Missing rows and lost claim races map to `not_found`; corrupt persisted
 * scopes map to `invalid`. Used, expired, and scope failures remain distinct.
 */
export type PairingConsumeResult =
    | { ok: true; peer: PublicFederationPeer; token: string }
    | {
          ok: false;
          reason:
              | "not_found"
              | "used"
              | "expired"
              | "scope_mismatch"
              | "invalid";
      };

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

function consumerScopes(embeddingsAvailable: boolean): FederationScope[] {
    return embeddingsAvailable
        ? ["library:read", "stream:read", "embeddings:read"]
        : ["library:read", "stream:read"];
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
    const scopes = input.scopes ?? consumerScopes(manifest.embeddingsAvailable);
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

/** Exchanges a short code, then links the resulting token through manifest validation. */
export async function pairAndLinkConsumerFederationPeer(input: {
    baseUrl: string;
    code: string;
    name: string;
    createdById: string;
    scopes?: FederationScope[];
}): Promise<{ peer: PublicFederationPeer }> {
    const baseUrl = normalizeConsumerBaseUrl(input.baseUrl);
    const duplicate = await findDuplicateConsumerPeer(baseUrl);
    if (duplicate) throw new FederationPeerConflictError();
    const scopes = input.scopes ?? ["library:read", "stream:read"];
    const instanceName = await resolveFederationInstanceName();
    const paired = await pairFederationPeer({
        baseUrl,
        code: input.code,
        name: instanceName,
        requestedScopes: scopes,
        options: outboundClientOptions(),
    });
    const linkedScopes = mutualScopes(paired.peer.scopes, scopes);
    if (linkedScopes.length === 0) {
        throw new FederationScopeMismatchError();
    }
    const peer = await linkConsumerFederationPeer({
        baseUrl,
        token: paired.token,
        name: input.name,
        createdById: input.createdById,
        scopes: linkedScopes,
    });
    return { peer };
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

function generatePairingCodeValue(): string {
    let code = "";
    for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
        code += PAIRING_CODE_ALPHABET.charAt(
            randomInt(0, PAIRING_CODE_ALPHABET.length),
        );
    }
    return code;
}

async function findAvailablePairingCode(
    transaction: Prisma.TransactionClient,
): Promise<string> {
    for (let attempt = 0; attempt < PAIRING_CODE_ATTEMPTS; attempt += 1) {
        const code = generatePairingCodeValue();
        const existing = await transaction.federationPairingCode.findUnique({
            where: { code },
            select: { id: true },
        });
        if (!existing) return code;
    }
    throw new Error("Federation pairing code generation exhausted");
}

async function prunePairingCodes(
    transaction: Prisma.TransactionClient,
    createdById: string,
    now: Date,
): Promise<void> {
    await transaction.federationPairingCode.deleteMany({
        where: { createdById, expiresAt: { lte: now } },
    });
    const retained = await transaction.federationPairingCode.findMany({
        where: { createdById, usedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "desc" },
        take: MAX_LIVE_PAIRING_CODES - 1,
        select: { id: true },
    });
    await transaction.federationPairingCode.deleteMany({
        where: {
            createdById,
            usedAt: null,
            expiresAt: { gt: now },
            id: { notIn: retained.map(({ id }) => id) },
        },
    });
}

/** Creates one short-lived pairing code for an administrator-approved scope set. */
export async function createFederationPairingCode(input: {
    createdById: string;
    scopes: FederationScope[];
}): Promise<{ code: string; expiresAt: Date }> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
    return prisma.$transaction(async (transaction) => {
        await acquireUserScopedLock(
            transaction,
            USER_LOCK_NAMESPACES.federationPairingCodeCreate,
            input.createdById,
        );
        await prunePairingCodes(transaction, input.createdById, now);
        const code = await findAvailablePairingCode(transaction);
        await transaction.federationPairingCode.create({
            data: {
                code,
                expiresAt,
                createdById: input.createdById,
                scopes: input.scopes,
            },
        });
        return { code, expiresAt };
    });
}

/** Atomically consumes a valid code and returns the newly issued credential once. */
export async function consumePairingCode(
    input: PairingConsumeInput,
    now: Date = new Date(),
): Promise<PairingConsumeResult> {
    const code = await prisma.federationPairingCode.findUnique({
        where: { code: input.code.toUpperCase() },
    });
    if (!code) return { ok: false, reason: "not_found" };
    if (code.usedAt) return { ok: false, reason: "used" };
    if (code.expiresAt <= now) return { ok: false, reason: "expired" };
    const grantedScopes = parseFederationScopes(code.scopes);
    if (!grantedScopes) return { ok: false, reason: "invalid" };
    const requestedScopes = input.requestedScopes;
    if (
        requestedScopes &&
        !requestedScopes.every((scope) => grantedScopes.includes(scope))
    ) {
        return { ok: false, reason: "scope_mismatch" };
    }
    const scopes = requestedScopes ?? grantedScopes;
    await ensureFederationIdentity();
    return prisma.$transaction(async (transaction) => {
        const claimed = await transaction.federationPairingCode.updateMany({
            where: { id: code.id, usedAt: null, expiresAt: { gt: now } },
            data: { usedAt: now },
        });
        if (claimed.count !== 1) {
            return { ok: false as const, reason: "not_found" as const };
        }
        const created = await createPeerWithClient(transaction, {
            name: input.name,
            baseUrl: input.baseUrl,
            createdById: code.createdById,
            scopes,
            capabilities: input.capabilities,
        });
        return { ok: true as const, ...created };
    });
}

function mutualScopes(
    granted: readonly string[],
    reciprocal: readonly FederationScope[],
): FederationScope[] {
    return reciprocal.filter((scope) => granted.includes(scope));
}

/** Consumes one code and ignores legacy reciprocal callback fields. */
export async function consumeFederationPairingRequest(
    input: PairingConsumeInput,
): Promise<PairingConsumeResult> {
    return consumePairingCode(input);
}
