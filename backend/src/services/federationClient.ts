import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";
import { lookup } from "dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { Agent as HttpsAgent } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import pLimit from "p-limit";
import { z } from "zod";
import { recordFederationSyncSkip } from "../metrics";
import { logger } from "../utils/logger";
import {
    FEDERATION_SCOPE_VALUES,
    type FederationScope,
} from "../utils/federationScopes";
import type { ParsedFederationEmbeddingSpaceIdentity } from "./federationEmbeddingSpace";
import { decryptFederationOutboundToken } from "./federationCredentialCipher";
import {
    federationCapabilitiesSchema,
    FEDERATION_CAPABILITY_VALUES,
} from "./federationCapabilities";
import {
    FEDERATION_EMBEDDING_SPACE_ACCEPT_HEADER,
    FEDERATION_EMBEDDING_SPACE_ACCEPT_VALUE,
    FEDERATION_EMBEDDING_SPACE_HEADER,
    parseFederationEmbeddingSpaceHeader,
} from "./federationEmbeddingSpaceHeader";
import { isBlockedAddress } from "./outboundAddressPolicy";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_CONCURRENT_REQUESTS = 8;
/** Maximum number of catalog changes accepted or requested in one page. */
export const MAX_PAGE_ITEMS = 500;
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
const EMBEDDING_DIMENSIONS = 512;
const UNKNOWN_KEY_WARNING_INTERVAL_MS = 60_000;
const MAX_UNKNOWN_KEY_SAMPLES = 32;
const MAX_UNKNOWN_KEY_LENGTH = 128;
const MAX_UNKNOWN_KEY_WARNING_PEERS = 256;
const requestLimit = pLimit(MAX_CONCURRENT_REQUESTS);
const log = logger.child("FederationClient");
const unknownKeyWarningAt = new Map<string, number>();
const embeddingSpaceAcceptHeaders = {
    [FEDERATION_EMBEDDING_SPACE_ACCEPT_HEADER]:
        FEDERATION_EMBEDDING_SPACE_ACCEPT_VALUE,
} as const;

const KNOWN_MEDIA_TYPES = [
    "artist",
    "album",
    "track",
    "podcast",
    "audiobook",
] as const;
const mediaTypeSchema = z.enum(KNOWN_MEDIA_TYPES);
const boundedMediaTypeSchema = z.string().min(1).max(64);
const dateTimeSchema = z.union([z.iso.datetime({ offset: true }), z.date()]);
const artistAttributesSchema = z.strictObject({
    name: z.string().min(1).max(1_000),
    mbid: z.string().min(1).max(1_000),
    normalizedName: z.string().max(1_000),
});
const albumAttributesSchema = z.strictObject({
    title: z.string().min(1).max(2_000),
    rgMbid: z.string().min(1).max(1_000),
    year: z.number().int().min(0).max(9999).nullable(),
    primaryType: z.string().min(1).max(200),
});
const embeddingSchema = z
    .array(z.number().finite())
    .length(EMBEDDING_DIMENSIONS);
const optionalFiniteNumberSchema = z.number().finite().nullable().optional();
const optionalFeatureStringSchema = z.string().max(200).nullable().optional();
const optionalFeatureArraySchema = z
    .array(z.string().max(200))
    .max(64)
    .nullable()
    .optional();
// This compatibility reader intentionally strips additive keys. Ingest stays
// a whitelist because federationSyncPage.syncedFederationTrackValues maps only
// the validated fields declared here into persistence.
const trackAttributesSchema = z.object({
    title: z.string().min(1).max(2_000),
    discNo: z.number().int().min(0).max(10_000),
    trackNo: z.number().int().min(0).max(100_000),
    duration: z.number().int().min(0).max(86_400),
    mime: z.string().max(255).nullable(),
    fileSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    recordingMbid: z.string().max(1_000).nullable(),
    isrc: z.string().max(100).nullable(),
    audioHash: z.string().max(1_000).nullable(),
    bpm: optionalFiniteNumberSchema,
    beatsCount: z.number().int().finite().nullable().optional(),
    key: optionalFeatureStringSchema,
    keyScale: optionalFeatureStringSchema,
    keyStrength: optionalFiniteNumberSchema,
    energy: optionalFiniteNumberSchema,
    loudness: optionalFiniteNumberSchema,
    loudnessLufs: optionalFiniteNumberSchema,
    truePeakDb: optionalFiniteNumberSchema,
    dynamicRange: optionalFiniteNumberSchema,
    danceability: optionalFiniteNumberSchema,
    valence: optionalFiniteNumberSchema,
    arousal: optionalFiniteNumberSchema,
    instrumentalness: optionalFiniteNumberSchema,
    acousticness: optionalFiniteNumberSchema,
    speechiness: optionalFiniteNumberSchema,
    moodHappy: optionalFiniteNumberSchema,
    moodSad: optionalFiniteNumberSchema,
    moodRelaxed: optionalFiniteNumberSchema,
    moodAggressive: optionalFiniteNumberSchema,
    moodParty: optionalFiniteNumberSchema,
    moodAcoustic: optionalFiniteNumberSchema,
    moodElectronic: optionalFiniteNumberSchema,
    danceabilityMl: optionalFiniteNumberSchema,
    moodTags: optionalFeatureArraySchema,
    essentiaGenres: optionalFeatureArraySchema,
    lastfmTags: optionalFeatureArraySchema,
    embedding: embeddingSchema.optional(),
});
const knownTrackAttributeKeys = new Set(
    Object.keys(trackAttributesSchema.shape),
);

const artistEnvelopeSchema = z.strictObject({
    id: z.string().min(1).max(128),
    mediaType: z.literal("artist"),
    updatedAt: dateTimeSchema,
    attributes: artistAttributesSchema,
});
const albumEnvelopeSchema = z.strictObject({
    id: z.string().min(1).max(128),
    mediaType: z.literal("album"),
    updatedAt: dateTimeSchema,
    parentRef: z.string().min(1).max(128),
    attributes: albumAttributesSchema,
});
const trackEnvelopeSchema = z.strictObject({
    id: z.string().min(1).max(128),
    mediaType: z.literal("track"),
    updatedAt: dateTimeSchema,
    parentRef: z.string().min(1).max(128),
    attributes: trackAttributesSchema,
});
const podcastEnvelopeSchema = z.strictObject({
    id: z.string().min(1).max(128),
    mediaType: z.literal("podcast"),
    updatedAt: dateTimeSchema,
    attributes: z.strictObject({
        feedUrl: z.url().max(4_096),
        title: z.string().min(1).max(2_000),
        author: z.string().max(1_000).nullable(),
        description: z.string().max(100_000).nullable(),
        imageUrl: z.url().max(4_096).nullable(),
        itunesId: z.string().max(256).nullable(),
    }),
});
const audiobookEnvelopeSchema = z.strictObject({
    id: z.string().min(1).max(128),
    mediaType: z.literal("audiobook"),
    updatedAt: dateTimeSchema,
    attributes: z.strictObject({
        title: z.string().min(1).max(2_000),
        author: z.string().max(1_000).nullable(),
        narrator: z.string().max(1_000).nullable(),
        duration: z.number().finite().nonnegative().nullable(),
        description: z.string().max(100_000).nullable(),
        asin: z.string().max(128).nullable(),
        isbn: z.string().max(128).nullable(),
        coverUrl: z.boolean(),
    }),
});
export const federationEnvelopeSchema = z.discriminatedUnion("mediaType", [
    artistEnvelopeSchema,
    albumEnvelopeSchema,
    trackEnvelopeSchema,
    podcastEnvelopeSchema,
    audiobookEnvelopeSchema,
]);

export const federationManifestSchema = z.looseObject({
    instanceId: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    catalogEpoch: z.string().min(1).max(128),
    mediaTypes: z
        .array(boundedMediaTypeSchema)
        .max(32)
        .transform((values) => values.filter(isKnownMediaType)),
    counts: z.looseObject({
        artists: z.number().int().nonnegative(),
        albums: z.number().int().nonnegative(),
        tracks: z.number().int().nonnegative(),
        podcasts: z.number().int().nonnegative().optional(),
        audiobooks: z.number().int().nonnegative().optional(),
    }),
    embeddingsAvailable: z.boolean(),
    capabilities: federationCapabilitiesSchema,
    serverTime: dateTimeSchema.optional(),
});
const catalogPageShapeSchema = z.strictObject({
    items: z.array(z.unknown()).max(MAX_PAGE_ITEMS),
    nextCursor: z.string().min(1).max(512).nullable(),
});
const tombstoneSchema = z.strictObject({
    entityType: boundedMediaTypeSchema,
    entityId: z.string().min(1).max(128),
    deletedAt: dateTimeSchema,
});
const tombstonesSchema = z.array(tombstoneSchema).max(MAX_PAGE_ITEMS);
const deltaPageShapeSchema = z.strictObject({
    kind: z.literal("ok"),
    changes: z.array(z.unknown()).max(MAX_PAGE_ITEMS),
    tombstones: z.array(z.unknown()).max(MAX_PAGE_ITEMS),
    nextCursor: z.string().min(1).max(512).nullable(),
    nextSince: dateTimeSchema,
});
const epochMismatchSchema = z.object({
    code: z.enum(["FEDERATION_EPOCH_MISMATCH", "FEDERATION_STALE_CURSOR"]),
    currentEpoch: z.string().min(1).max(128),
});
const pairedScopesSchema = z
    .array(z.enum(FEDERATION_SCOPE_VALUES))
    .min(1)
    .max(FEDERATION_SCOPE_VALUES.length)
    .refine((scopes) => new Set(scopes).size === scopes.length)
    .refine(
        (scopes) =>
            !scopes.includes("embeddings:read") ||
            scopes.includes("library:read"),
    );
const pairedPeerSchema = z.object({
    peer: z.object({
        id: z.string().min(1).max(128),
        name: z.string().min(1).max(120),
        direction: z.enum(["HOST", "CONSUMER", "BOTH"]),
        baseUrl: z.string().nullable(),
        scopes: pairedScopesSchema,
        inboundStatus: z
            .enum(["PENDING", "ACTIVE", "OFFLINE", "REVOKED"])
            .nullable(),
        outboundStatus: z
            .enum(["PENDING", "ACTIVE", "OFFLINE", "REVOKED"])
            .nullable(),
        lastSeenAt: dateTimeSchema.nullable(),
        lastSyncCursor: z.string().nullable(),
        catalogEpoch: z.string().nullable(),
        createdAt: dateTimeSchema,
        updatedAt: dateTimeSchema,
    }),
    token: z.string().min(1).max(4_096),
    capabilities: federationCapabilitiesSchema,
});

export type FederationManifest = z.infer<typeof federationManifestSchema>;
export type FederationEnvelope = z.infer<typeof federationEnvelopeSchema>;
export interface FederationCatalogPage {
    items: FederationEnvelope[];
    nextCursor: string | null;
    skippedInvalid: number;
    embeddingSpace?: ParsedFederationEmbeddingSpaceIdentity;
}
export interface FederationDelta {
    kind: "ok";
    changes: FederationEnvelope[];
    tombstones: Array<
        z.infer<typeof tombstoneSchema> & {
            entityType: z.infer<typeof mediaTypeSchema>;
        }
    >;
    nextCursor: string | null;
    nextSince: z.infer<typeof dateTimeSchema>;
    skippedInvalid: number;
    skippedUnknownTombstones: number;
    embeddingSpace?: ParsedFederationEmbeddingSpaceIdentity;
}

function isKnownMediaType(
    value: string,
): value is z.infer<typeof mediaTypeSchema> {
    return KNOWN_MEDIA_TYPES.some((known) => known === value);
}

interface UnknownKeySample {
    keys: string[];
    totalCount: number;
}

function collectUnknownTrackAttributeKeys(
    value: unknown,
    sample: UnknownKeySample,
): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const envelope = value as Record<string, unknown>;
    if (envelope.mediaType !== "track") return;
    const attributes = envelope.attributes;
    if (
        !attributes ||
        typeof attributes !== "object" ||
        Array.isArray(attributes)
    ) {
        return;
    }
    const keys = Object.keys(attributes);
    for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        if (knownTrackAttributeKeys.has(key)) continue;
        sample.totalCount += 1;
        if (sample.keys.length >= MAX_UNKNOWN_KEY_SAMPLES) continue;
        const boundedKey = key.slice(0, MAX_UNKNOWN_KEY_LENGTH);
        if (!sample.keys.includes(boundedKey)) sample.keys.push(boundedKey);
    }
}

function reportUnknownTrackAttributeKeys(
    peerId: string,
    sample: UnknownKeySample,
): void {
    if (sample.totalCount === 0) return;
    recordFederationSyncSkip("unknown_key_stripped", sample.totalCount);
    const now = Date.now();
    const previous = unknownKeyWarningAt.get(peerId);
    if (
        previous !== undefined &&
        now - previous < UNKNOWN_KEY_WARNING_INTERVAL_MS
    ) {
        return;
    }
    unknownKeyWarningAt.delete(peerId);
    if (unknownKeyWarningAt.size >= MAX_UNKNOWN_KEY_WARNING_PEERS) {
        const oldestPeerId = unknownKeyWarningAt.keys().next().value;
        if (oldestPeerId !== undefined)
            unknownKeyWarningAt.delete(oldestPeerId);
    }
    unknownKeyWarningAt.set(peerId, now);
    log.warn("Stripped unknown federation track attribute keys", {
        peerId,
        keys: sample.keys.slice().sort(),
        omittedCount: sample.totalCount - sample.keys.length,
    });
}

function reportUnknownTrackAttributeKeysForValue(
    peerId: string,
    value: unknown,
): void {
    const sample: UnknownKeySample = { keys: [], totalCount: 0 };
    collectUnknownTrackAttributeKeys(value, sample);
    reportUnknownTrackAttributeKeys(peerId, sample);
}

/** Peer returned a valid HTTP response outside the accepted status set. */
export class FederationHttpError extends Error {
    readonly peerCode?: string;
    readonly transportCode?: string;

    constructor(
        public readonly status: number | null,
        public readonly transient: boolean,
        options: {
            peerCode?: string;
            transportCode?: string;
            cause?: unknown;
        } = {},
    ) {
        super(
            status === null
                ? "Federation request failed"
                : `Federation peer returned ${status}`,
            options.cause === undefined ? undefined : { cause: options.cause },
        );
        this.name = "FederationHttpError";
        this.peerCode = options.peerCode;
        this.transportCode = options.transportCode;
    }
}

/** Peer returned malformed data at a JSON trust boundary. */
export class FederationResponseError extends Error {
    constructor() {
        super("Federation peer returned malformed data");
        this.name = "FederationResponseError";
    }
}

/** Peer delta cursor belongs to a different catalog epoch. */
export class FederationEpochMismatchError extends Error {
    constructor(public readonly currentEpoch: string) {
        super("Federation catalog epoch mismatch");
        this.name = "FederationEpochMismatchError";
    }
}

/** Peer no longer retains every tombstone needed by the supplied cursor. */
export class FederationStaleCursorError extends Error {
    constructor(public readonly currentEpoch: string) {
        super("Federation catalog cursor is stale");
        this.name = "FederationStaleCursorError";
    }
}

export interface FederationClientPeer {
    id: string;
    baseUrl: string | null;
    outboundToken: string | null;
}

interface FederationClientOptions {
    timeoutMs?: number;
    attempts?: number;
    retryDelayMs?: number;
    allowPrivatePeers?: boolean;
    allowProxy?: boolean;
}

/** Pure hostname policy for literal private addresses and localhost. */
export function isDisallowedPeerHost(hostname: string): boolean {
    const normalized = hostname
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "")
        .toLowerCase();
    if (normalized === "localhost") return true;
    const family = isIP(normalized);
    if (family === 0) return false;
    return isBlockedAddress(normalized);
}

/** Resolves an HTTPS peer origin under the literal-address SSRF policy. */
export function resolveBaseUrl(
    value: string | null,
    allowPrivatePeers = false,
): URL {
    if (!value) throw new Error("Federation peer base URL is missing");
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("Federation peer base URL is invalid");
    }
    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        (!allowPrivatePeers && isDisallowedPeerHost(url.hostname))
    ) {
        throw new Error("Federation peer base URL is invalid");
    }
    return url;
}

function peerUrl(baseUrl: URL, path: string): string {
    return new URL(path, `${baseUrl.origin}/`).toString();
}

function isTransientNetworkError(error: unknown): boolean {
    if (!(error instanceof Error) && !axios.isAxiosError(error)) return false;
    const code = (error as NodeJS.ErrnoException).code ?? "";
    return [
        "ECONNABORTED",
        "ECONNREFUSED",
        "ECONNRESET",
        "EAI_AGAIN",
        "ENETUNREACH",
        "ENOTFOUND",
        "ETIMEDOUT",
    ].includes(code);
}

function transportCode(error: unknown): string | undefined {
    if (!error || typeof error !== "object" || !("code" in error)) {
        return undefined;
    }
    return typeof error.code === "string" ? error.code : undefined;
}

function federationTransportError(
    transient: boolean,
    cause?: unknown,
): FederationHttpError {
    return new FederationHttpError(null, transient, {
        cause,
        transportCode: transportCode(cause),
    });
}

function peerNetworkHostname(destination: URL): string {
    return destination.hostname.replace(/^\[|\]$/g, "");
}

async function resolvePeerAddresses(
    destination: URL,
    allowPrivatePeers: boolean,
): Promise<LookupAddress[]> {
    try {
        const addresses = await lookup(peerNetworkHostname(destination), {
            all: true,
            verbatim: true,
        });
        if (addresses.length === 0) throw federationTransportError(false);
        const hasInvalidAddress = addresses.some(
            ({ address }) =>
                isIP(address) === 0 ||
                (!allowPrivatePeers && isBlockedAddress(address)),
        );
        if (hasInvalidAddress) throw federationTransportError(false);
        return addresses;
    } catch (error) {
        if (error instanceof FederationHttpError) throw error;
        throw federationTransportError(isTransientNetworkError(error), error);
    }
}

function lookupFamily(options: LookupOptions): number | undefined {
    if (options.family === 4 || options.family === "IPv4") return 4;
    if (options.family === 6 || options.family === "IPv6") return 6;
    return undefined;
}

function lookupError(code: string): NodeJS.ErrnoException {
    const error = new Error(
        "Federation request failed",
    ) as NodeJS.ErrnoException;
    error.code = code;
    return error;
}

function createPinnedLookup(
    expectedHostname: string,
    addresses: readonly LookupAddress[],
): LookupFunction {
    return (hostname, options, callback) => {
        if (hostname.toLowerCase() !== expectedHostname.toLowerCase()) {
            callback(lookupError("EOUTBOUNDBLOCKED"), "", 0);
            return;
        }
        const family = lookupFamily(options);
        const eligible = addresses.filter(
            (address) => family === undefined || address.family === family,
        );
        if (eligible.length === 0) {
            callback(lookupError("EAFNOSUPPORT"), "", 0);
            return;
        }
        if (options.all) {
            callback(null, eligible.slice());
            return;
        }
        callback(null, eligible[0].address, eligible[0].family);
    };
}

async function pinnedTransport(
    destination: URL,
    allowPrivatePeers: boolean,
    allowProxy: boolean,
): Promise<{ httpsAgent?: HttpsAgent; proxy?: false }> {
    const addresses = await resolvePeerAddresses(
        destination,
        allowPrivatePeers,
    );
    if (allowProxy) {
        // A proxy makes the outbound connection, so pinning cannot prevent
        // rebinding on the proxy side; pre-connect validation still runs.
        return {};
    }
    return {
        httpsAgent: new HttpsAgent({
            keepAlive: false,
            lookup: createPinnedLookup(
                peerNetworkHostname(destination),
                addresses,
            ),
        }),
        proxy: false,
    };
}

async function waitForRetry(delayMs: number, attempt: number): Promise<void> {
    const boundedDelay = Math.min(delayMs * 2 ** attempt, 4_000);
    if (boundedDelay <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, boundedDelay));
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new FederationResponseError();
    return result.data;
}

function parseLenientItems<T>(
    values: readonly unknown[],
    schema: z.ZodType<T>,
): { items: T[]; skippedInvalid: number; unknownKeys: UnknownKeySample } {
    const items: T[] = [];
    const unknownKeys: UnknownKeySample = { keys: [], totalCount: 0 };
    let skippedInvalid = 0;
    for (
        let index = 0;
        index < values.length && index < MAX_PAGE_ITEMS;
        index += 1
    ) {
        const parsed = schema.safeParse(values[index]);
        if (!parsed.success) {
            skippedInvalid += 1;
            continue;
        }
        items.push(parsed.data);
        collectUnknownTrackAttributeKeys(values[index], unknownKeys);
    }
    return { items, skippedInvalid, unknownKeys };
}

function parseCatalogPage(
    value: unknown,
    embeddingSpace: ParsedFederationEmbeddingSpaceIdentity | undefined,
): { page: FederationCatalogPage; unknownKeys: UnknownKeySample } {
    const page = parseResponse(catalogPageShapeSchema, value);
    const parsed = parseLenientItems(page.items, federationEnvelopeSchema);
    return {
        page: {
            items: parsed.items,
            skippedInvalid: parsed.skippedInvalid,
            nextCursor: page.nextCursor,
            ...(embeddingSpace !== undefined ? { embeddingSpace } : {}),
        },
        unknownKeys: parsed.unknownKeys,
    };
}

function parseDeltaPage(
    value: unknown,
    embeddingSpace: ParsedFederationEmbeddingSpaceIdentity | undefined,
): { delta: FederationDelta; unknownKeys: UnknownKeySample } {
    const page = parseResponse(deltaPageShapeSchema, value);
    const changes = parseLenientItems(page.changes, federationEnvelopeSchema);
    const parsedTombstones = parseResponse(tombstonesSchema, page.tombstones);
    const tombstones = parsedTombstones.filter(
        (
            item,
        ): item is typeof item & {
            entityType: z.infer<typeof mediaTypeSchema>;
        } => isKnownMediaType(item.entityType),
    );
    return {
        delta: {
            kind: "ok",
            changes: changes.items,
            tombstones,
            nextCursor: page.nextCursor,
            nextSince: page.nextSince,
            skippedInvalid: changes.skippedInvalid,
            skippedUnknownTombstones:
                parsedTombstones.length - tombstones.length,
            ...(embeddingSpace !== undefined ? { embeddingSpace } : {}),
        },
        unknownKeys: changes.unknownKeys,
    };
}

function parseEmbeddingSpaceResponseHeader(
    response: AxiosResponse,
): ParsedFederationEmbeddingSpaceIdentity | undefined {
    const name = FEDERATION_EMBEDDING_SPACE_HEADER.toLowerCase();
    return parseFederationEmbeddingSpaceHeader(response.headers?.[name]);
}

function destroyStreamBody(response: AxiosResponse): void {
    const body = response.data as { destroy?: () => void } | undefined;
    body?.destroy?.();
}

class FederationClient {
    private readonly peerId: string;
    private readonly baseUrl: URL;
    private readonly token: string;
    private readonly timeoutMs: number;
    private readonly attempts: number;
    private readonly retryDelayMs: number;
    private readonly allowPrivatePeers: boolean;
    private readonly allowProxy: boolean;

    constructor(peer: FederationClientPeer, options: FederationClientOptions) {
        this.peerId = peer.id;
        this.baseUrl = resolveBaseUrl(
            peer.baseUrl,
            options.allowPrivatePeers ?? false,
        );
        this.token = peer.outboundToken
            ? decryptFederationOutboundToken(peer.outboundToken)
            : "";
        if (!this.token) throw new Error("Federation peer token is missing");
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.attempts = options.attempts ?? DEFAULT_ATTEMPTS;
        this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
        this.allowPrivatePeers = options.allowPrivatePeers ?? false;
        this.allowProxy = options.allowProxy ?? false;
    }

    private async request(config: AxiosRequestConfig): Promise<AxiosResponse> {
        for (let attempt = 0; attempt < this.attempts; attempt += 1) {
            try {
                const response = await requestLimit(() =>
                    pinnedTransport(
                        this.baseUrl,
                        this.allowPrivatePeers,
                        this.allowProxy,
                    ).then((transport) =>
                        axios.request({
                            ...config,
                            ...transport,
                            timeout: this.timeoutMs,
                            maxRedirects: 0,
                            validateStatus: () => true,
                            headers: {
                                ...config.headers,
                                Authorization: `Bearer ${this.token}`,
                            },
                        }),
                    ),
                );
                if (response.status < 500 || attempt + 1 === this.attempts) {
                    return response;
                }
                if (config.responseType === "stream") {
                    destroyStreamBody(response);
                }
            } catch (error) {
                if (error instanceof FederationHttpError && !error.transient) {
                    throw error;
                }
                const transient = isTransientNetworkError(error);
                const retryable =
                    error instanceof FederationHttpError
                        ? error.transient
                        : transient;
                if (!retryable || attempt + 1 === this.attempts) {
                    if (error instanceof FederationHttpError) throw error;
                    if (axios.isAxiosError(error))
                        throw federationTransportError(transient, error);
                    throw error;
                }
            }
            await waitForRetry(this.retryDelayMs, attempt);
        }
        throw new FederationHttpError(null, true);
    }

    private async requestJson<T>(
        path: string,
        schema: z.ZodType<T>,
        config: AxiosRequestConfig = {},
        inspectAccepted?: (value: unknown) => void,
    ): Promise<T> {
        const response = await this.request({
            method: "GET",
            ...config,
            url: peerUrl(this.baseUrl, path),
            headers: {
                ...config.headers,
                ...embeddingSpaceAcceptHeaders,
            },
            maxContentLength: MAX_JSON_BODY_BYTES,
            maxBodyLength: MAX_JSON_BODY_BYTES,
        });
        if (response.status < 200 || response.status >= 300) {
            throw new FederationHttpError(
                response.status,
                response.status >= 500,
            );
        }
        const parsed = parseResponse(schema, response.data);
        inspectAccepted?.(response.data);
        return parsed;
    }

    async getManifest(signal?: AbortSignal): Promise<FederationManifest> {
        return this.requestJson(
            "/api/federation/v1/manifest",
            federationManifestSchema,
            { signal },
        );
    }

    async getCatalogItems(
        mediaType: z.infer<typeof mediaTypeSchema>,
        cursor?: string,
        signal?: AbortSignal,
    ): Promise<FederationCatalogPage> {
        const response = await this.request({
            method: "GET",
            url: peerUrl(this.baseUrl, "/api/federation/v1/catalog/items"),
            params: { type: mediaType, limit: MAX_PAGE_ITEMS, cursor },
            headers: embeddingSpaceAcceptHeaders,
            signal,
            maxContentLength: MAX_JSON_BODY_BYTES,
            maxBodyLength: MAX_JSON_BODY_BYTES,
        });
        if (response.status < 200 || response.status >= 300) {
            throw new FederationHttpError(
                response.status,
                response.status >= 500,
            );
        }
        const parsed = parseCatalogPage(
            response.data,
            parseEmbeddingSpaceResponseHeader(response),
        );
        reportUnknownTrackAttributeKeys(this.peerId, parsed.unknownKeys);
        return parsed.page;
    }

    async getCatalogItem(
        mediaType: z.infer<typeof mediaTypeSchema>,
        id: string,
        signal?: AbortSignal,
    ): Promise<FederationEnvelope> {
        return this.requestJson(
            `/api/federation/v1/catalog/items/${mediaType}/${encodeURIComponent(id)}`,
            federationEnvelopeSchema,
            { signal },
            (value) =>
                reportUnknownTrackAttributeKeysForValue(this.peerId, value),
        );
    }

    async getCatalogDelta(input: {
        since: Date;
        epoch: string;
        cursor?: string;
        signal?: AbortSignal;
    }): Promise<FederationDelta> {
        const response = await this.request({
            method: "GET",
            url: peerUrl(this.baseUrl, "/api/federation/v1/catalog/delta"),
            params: {
                since: input.since.toISOString(),
                epoch: input.epoch,
                cursor: input.cursor,
                limit: MAX_PAGE_ITEMS,
            },
            headers: embeddingSpaceAcceptHeaders,
            signal: input.signal,
            maxContentLength: MAX_JSON_BODY_BYTES,
            maxBodyLength: MAX_JSON_BODY_BYTES,
        });
        if (response.status === 409) {
            const mismatch = parseResponse(epochMismatchSchema, response.data);
            if (mismatch.code === "FEDERATION_STALE_CURSOR") {
                throw new FederationStaleCursorError(mismatch.currentEpoch);
            }
            throw new FederationEpochMismatchError(mismatch.currentEpoch);
        }
        if (response.status < 200 || response.status >= 300) {
            throw new FederationHttpError(
                response.status,
                response.status >= 500,
            );
        }
        const parsed = parseDeltaPage(
            response.data,
            parseEmbeddingSpaceResponseHeader(response),
        );
        reportUnknownTrackAttributeKeys(this.peerId, parsed.unknownKeys);
        return parsed.delta;
    }

    async getStream(input: {
        remoteId: string;
        quality: string;
        range?: string;
        signal?: AbortSignal;
    }): Promise<AxiosResponse<NodeJS.ReadableStream>> {
        const response = await this.request({
            method: "GET",
            url: peerUrl(
                this.baseUrl,
                `/api/federation/v1/stream/${encodeURIComponent(input.remoteId)}`,
            ),
            params: { quality: input.quality },
            headers: input.range ? { Range: input.range } : {},
            responseType: "stream",
            signal: input.signal,
        });
        if (![200, 206, 416].includes(response.status)) {
            destroyStreamBody(response);
            throw new FederationHttpError(
                response.status,
                response.status >= 500,
            );
        }
        return response as AxiosResponse<NodeJS.ReadableStream>;
    }

    async getAudiobookStream(input: {
        remoteId: string;
        range?: string;
        signal?: AbortSignal;
    }): Promise<AxiosResponse<NodeJS.ReadableStream>> {
        const response = await this.request({
            method: "GET",
            url: peerUrl(
                this.baseUrl,
                `/api/federation/v1/stream/audiobook/${encodeURIComponent(input.remoteId)}`,
            ),
            headers: input.range ? { Range: input.range } : {},
            responseType: "stream",
            signal: input.signal,
        });
        if (![200, 206, 416].includes(response.status)) {
            destroyStreamBody(response);
            throw new FederationHttpError(
                response.status,
                response.status >= 500,
            );
        }
        return response as AxiosResponse<NodeJS.ReadableStream>;
    }

    async getCover(
        remoteId: string,
        signal?: AbortSignal,
    ): Promise<AxiosResponse<NodeJS.ReadableStream>> {
        const response = await this.request({
            method: "GET",
            url: peerUrl(
                this.baseUrl,
                `/api/federation/v1/cover/${encodeURIComponent(remoteId)}`,
            ),
            responseType: "stream",
            signal,
        });
        if (![200, 304, 404].includes(response.status)) {
            destroyStreamBody(response);
            throw new FederationHttpError(
                response.status,
                response.status >= 500,
            );
        }
        return response as AxiosResponse<NodeJS.ReadableStream>;
    }

    async getAudiobookCover(
        remoteId: string,
        signal?: AbortSignal,
    ): Promise<AxiosResponse<NodeJS.ReadableStream>> {
        const response = await this.request({
            method: "GET",
            url: peerUrl(
                this.baseUrl,
                `/api/federation/v1/cover/audiobook/${encodeURIComponent(remoteId)}`,
            ),
            responseType: "stream",
            signal,
        });
        if (![200, 304, 404].includes(response.status)) {
            destroyStreamBody(response);
            throw new FederationHttpError(
                response.status,
                response.status >= 500,
            );
        }
        return response as AxiosResponse<NodeJS.ReadableStream>;
    }
}

/** Creates the single bounded HTTP adapter used for one persisted consumer peer. */
export function createFederationClient(
    peer: FederationClientPeer,
    options: FederationClientOptions = {},
): FederationClient {
    return new FederationClient(peer, options);
}

async function requestPairWithRetry(
    config: AxiosRequestConfig,
    options: FederationClientOptions,
    baseUrl: URL,
): Promise<AxiosResponse> {
    const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const response = await requestLimit(() =>
                pinnedTransport(
                    baseUrl,
                    options.allowPrivatePeers ?? false,
                    options.allowProxy ?? false,
                ).then((transport) =>
                    axios.request({
                        ...config,
                        ...transport,
                        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                        maxRedirects: 0,
                        validateStatus: () => true,
                        maxContentLength: MAX_JSON_BODY_BYTES,
                        maxBodyLength: MAX_JSON_BODY_BYTES,
                    }),
                ),
            );
            if (response.status < 500 || attempt + 1 === attempts) {
                return response;
            }
        } catch (error) {
            if (error instanceof FederationHttpError && !error.transient) {
                throw error;
            }
            const transient = isTransientNetworkError(error);
            const retryable =
                error instanceof FederationHttpError
                    ? error.transient
                    : transient;
            if (!retryable || attempt + 1 === attempts) {
                if (error instanceof FederationHttpError) throw error;
                if (axios.isAxiosError(error))
                    throw federationTransportError(transient, error);
                throw error;
            }
        }
        await waitForRetry(retryDelayMs, attempt);
    }
    throw new FederationHttpError(null, true);
}

function peerErrorCode(value: unknown): string | undefined {
    if (!value || typeof value !== "object" || !("code" in value)) {
        return undefined;
    }
    return typeof value.code === "string" ? value.code : undefined;
}

/** Exchanges a short pairing code through the same bounded transport policy. */
export async function pairFederationPeer(input: {
    baseUrl: string;
    code: string;
    name: string;
    requestedScopes?: FederationScope[];
    options?: FederationClientOptions;
}): Promise<z.infer<typeof pairedPeerSchema>> {
    const options = input.options ?? {};
    const baseUrl = resolveBaseUrl(
        input.baseUrl,
        options.allowPrivatePeers ?? false,
    );
    const response = await requestPairWithRetry(
        {
            method: "POST",
            url: peerUrl(baseUrl, "/api/federation/v1/pair"),
            data: {
                code: input.code,
                name: input.name,
                capabilities: [...FEDERATION_CAPABILITY_VALUES],
                ...(input.requestedScopes
                    ? { requestedScopes: input.requestedScopes }
                    : {}),
            },
        },
        options,
        baseUrl,
    );
    if (response.status < 200 || response.status >= 300) {
        throw new FederationHttpError(response.status, response.status >= 500, {
            peerCode: peerErrorCode(response.data),
        });
    }
    return parseResponse(pairedPeerSchema, response.data);
}
