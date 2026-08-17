import { config } from "../config";
import { logger } from "../utils/logger";
import {
    findRegisteredProviderEmbeddingSpace,
    getActiveSpace,
} from "./embeddingSpaces";
import {
    assertProviderMatchesActiveSpace,
    embedText,
    fetchProviderSpace,
    type EmbeddingVectorSpace,
    VibeProviderError,
    VibeProviderSpaceMismatchError,
    VibeProviderTimeoutError,
    VibeProviderUnavailableError,
} from "./vibeProvider";

const PROVIDER_SPACE_CACHE_TTL_MS = 60_000;
const log =
    typeof (logger as { child?: unknown }).child === "function"
        ? logger.child("TextEmbedding")
        : logger;

let cachedProviderSearchSpace: ProviderSearchSpace | null = null;
let providerSpaceCacheExpiresAt = 0;
let lastUnregisteredWarningAt = Number.NEGATIVE_INFINITY;

/** Text vector plus the registered space whose track vectors it can query. */
export interface ResolvedTextEmbedding {
    embedding: number[];
    spaceId: string;
    family: string;
    checkpointHash: string;
}

interface ProviderSearchSpace extends EmbeddingVectorSpace {
    family: string;
    checkpointHash: string;
}

/** Stable timeout identity consumed by the vibe route error mapper. */
export class TextEmbeddingTimeoutError extends Error {
    readonly status = 504;

    constructor(options?: ErrorOptions) {
        super("Text embedding request timed out", options);
        this.name = "TextEmbeddingTimeoutError";
    }
}

/** Stable unavailable-provider identity consumed by the vibe route mapper. */
export class TextEmbeddingUnavailableError extends Error {
    readonly status = 503;

    constructor(options?: ErrorOptions) {
        super("Text embedding provider is unavailable", options);
        this.name = "TextEmbeddingUnavailableError";
    }
}

/** Stable non-timeout provider-failure identity for route error mapping. */
export class TextEmbeddingProviderError extends Error {
    readonly status = 500;

    constructor(options?: ErrorOptions) {
        super("Text embedding provider request failed", options);
        this.name = "TextEmbeddingProviderError";
    }
}

/** Stable invalid-upstream identity consumed by the vibe route mapper. */
export class TextEmbeddingBadGatewayError extends Error {
    readonly status = 502;

    constructor(options?: ErrorOptions) {
        super("Text embedding provider returned an invalid response", options);
        this.name = "TextEmbeddingBadGatewayError";
    }
}

function warnUnregisteredProviderSpace(
    family: string,
    checkpointHash: string,
): void {
    const now = Date.now();
    if (now - lastUnregisteredWarningAt < PROVIDER_SPACE_CACHE_TTL_MS) return;
    lastUnregisteredWarningAt = now;
    log.warn("Vibe text provider space is not registered", {
        family,
        checkpointHash,
    });
}

async function loadProviderSearchSpace(): Promise<ProviderSearchSpace> {
    const [providerSpace, activeSpace] = await Promise.all([
        fetchProviderSpace(),
        getActiveSpace(),
    ]);
    try {
        assertProviderMatchesActiveSpace(providerSpace, activeSpace);
        return {
            id: activeSpace.id,
            dim: activeSpace.dim,
            family: activeSpace.family,
            checkpointHash: activeSpace.checkpointHash,
        };
    } catch (error) {
        if (!(error instanceof VibeProviderSpaceMismatchError)) throw error;
    }

    const registeredSpace =
        await findRegisteredProviderEmbeddingSpace(providerSpace);
    if (!registeredSpace) {
        warnUnregisteredProviderSpace(
            providerSpace.family,
            providerSpace.checkpointHash,
        );
        throw new VibeProviderSpaceMismatchError();
    }
    log.warn(
        "Vibe text search is using the provider embedding space during migration",
        { providerSpaceId: registeredSpace.id },
    );
    return {
        id: registeredSpace.id,
        dim: registeredSpace.dim,
        family: registeredSpace.family,
        checkpointHash: registeredSpace.checkpointHash,
    };
}

async function getProviderSearchSpace(): Promise<ProviderSearchSpace> {
    if (!config.vibeProviderUrl) throw new VibeProviderUnavailableError();
    if (cachedProviderSearchSpace && Date.now() < providerSpaceCacheExpiresAt) {
        return cachedProviderSearchSpace;
    }
    const searchSpace = await loadProviderSearchSpace();
    cachedProviderSearchSpace = searchSpace;
    providerSpaceCacheExpiresAt = Date.now() + PROVIDER_SPACE_CACHE_TTL_MS;
    return searchSpace;
}

function mapProviderError(error: unknown): never {
    if (error instanceof VibeProviderTimeoutError) {
        throw new TextEmbeddingTimeoutError({ cause: error });
    }
    if (error instanceof VibeProviderUnavailableError) {
        throw new TextEmbeddingUnavailableError({ cause: error });
    }
    if (error instanceof VibeProviderError) {
        if (error.code === "provider_5xx") {
            throw new TextEmbeddingUnavailableError({ cause: error });
        }
        if (error.code === "contract" || error.code === "space_mismatch") {
            throw new TextEmbeddingBadGatewayError({ cause: error });
        }
        throw new TextEmbeddingProviderError({ cause: error });
    }
    throw error;
}

/** Clear process-local provider-space state after configuration changes. */
export function invalidateTextEmbeddingProviderSpaceCache(): void {
    cachedProviderSearchSpace = null;
    providerSpaceCacheExpiresAt = 0;
    lastUnregisteredWarningAt = Number.NEGATIVE_INFINITY;
}

/** Embed text with the provider and identify the registered search space. */
export async function resolveTextEmbedding(
    text: string,
): Promise<ResolvedTextEmbedding> {
    try {
        const searchSpace = await getProviderSearchSpace();
        const embedding = await embedText(text, searchSpace);
        return {
            embedding,
            spaceId: searchSpace.id,
            family: searchSpace.family,
            checkpointHash: searchSpace.checkpointHash,
        };
    } catch (error) {
        return mapProviderError(error);
    }
}
