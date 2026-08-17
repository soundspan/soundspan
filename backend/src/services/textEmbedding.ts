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

let cachedProviderSearchSpace: EmbeddingVectorSpace | null = null;
let providerSpaceCacheExpiresAt = 0;
let lastUnregisteredWarningAt = Number.NEGATIVE_INFINITY;

/** Text vector plus the registered space whose track vectors it can query. */
export interface ResolvedTextEmbedding {
    embedding: number[];
    spaceId: string;
}

/** Stable timeout identity consumed by the vibe route error mapper. */
export class TextEmbeddingTimeoutError extends Error {
    constructor(options?: ErrorOptions) {
        super("Text embedding request timed out", options);
        this.name = "TextEmbeddingTimeoutError";
    }
}

/** Stable non-timeout provider-failure identity for route error mapping. */
export class TextEmbeddingProviderError extends Error {
    constructor(options?: ErrorOptions) {
        super("Text embedding provider request failed", options);
        this.name = "TextEmbeddingProviderError";
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

async function loadProviderSearchSpace(): Promise<EmbeddingVectorSpace> {
    const [providerSpace, activeSpace] = await Promise.all([
        fetchProviderSpace(),
        getActiveSpace(),
    ]);
    try {
        assertProviderMatchesActiveSpace(providerSpace, activeSpace);
        return { id: activeSpace.id, dim: activeSpace.dim };
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
    return { id: registeredSpace.id, dim: registeredSpace.dim };
}

async function getProviderSearchSpace(): Promise<EmbeddingVectorSpace> {
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
    if (
        error instanceof VibeProviderTimeoutError ||
        error instanceof VibeProviderUnavailableError
    ) {
        throw new TextEmbeddingTimeoutError({ cause: error });
    }
    if (error instanceof VibeProviderError) {
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
        return { embedding, spaceId: searchSpace.id };
    } catch (error) {
        return mapProviderError(error);
    }
}
