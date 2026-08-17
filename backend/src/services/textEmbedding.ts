import { randomUUID } from "crypto";
import { config } from "../config";
import { logger } from "../utils/logger";
import { blockingBlPop, redisClient } from "../utils/redis";
import { getActiveSpace } from "./embeddingSpaces";
import {
    assertProviderMatchesActiveSpace,
    embedText,
    fetchProviderSpace,
    VibeProviderError,
    VibeProviderTimeoutError,
    VibeProviderUnavailableError,
} from "./vibeProvider";

const TEXT_EMBED_REQUEST_STREAM = "audio:text:embed:requests";
const TEXT_EMBED_RESPONSE_PREFIX = "audio:text:embed:response:";
const TEXT_EMBED_TIMEOUT_SECONDS = 30;
const TEXT_EMBED_REQUEST_STREAM_MAX_LENGTH = 100;
const PROVIDER_SPACE_MATCH_TTL_MS = 60_000;
// Several route suites stub the logger without .child; tolerate the partial
// double like the other services that scope their logger at module init.
const log =
    typeof (logger as { child?: unknown }).child === "function"
        ? logger.child("TextEmbedding")
        : logger;

let cachedProviderMatchesActive = false;
let providerMatchCacheExpiresAt = 0;
let lastMismatchWarningAt = Number.NEGATIVE_INFINITY;

interface LegacyTextEmbedResponse {
    requestId: string;
    success: boolean;
    embedding: number[] | null;
    modelVersion: string;
    error?: string;
}

/** Stable timeout identity consumed by the vibe route error mapper. */
export class TextEmbeddingTimeoutError extends Error {
    constructor(options?: ErrorOptions) {
        super("Text embedding request timed out", options);
        this.name = "TextEmbeddingTimeoutError";
    }
}

/**
 * Stable non-timeout provider-failure identity. The route maps this before
 * any message inspection so provider-controlled error text can never steer
 * the HTTP status.
 */
export class TextEmbeddingProviderError extends Error {
    constructor(options?: ErrorOptions) {
        super("Text embedding provider request failed", options);
        this.name = "TextEmbeddingProviderError";
    }
}

function parseLegacyResponse(value: string): number[] {
    let payload: LegacyTextEmbedResponse;
    try {
        payload = JSON.parse(value) as LegacyTextEmbedResponse;
    } catch {
        throw new Error("Invalid response from analyzer");
    }
    if (payload.error) throw new Error(payload.error);
    if (!Array.isArray(payload.embedding)) {
        throw new Error("Invalid response from analyzer");
    }
    return payload.embedding;
}

async function embedTextWithLegacyStream(text: string): Promise<number[]> {
    const requestId = randomUUID();
    const responseKey = `${TEXT_EMBED_RESPONSE_PREFIX}${requestId}`;
    try {
        await redisClient.xAdd(
            TEXT_EMBED_REQUEST_STREAM,
            "*",
            { requestId, text, responseKey },
            {
                TRIM: {
                    strategy: "MAXLEN",
                    strategyModifier: "~",
                    threshold: TEXT_EMBED_REQUEST_STREAM_MAX_LENGTH,
                },
            },
        );
        const response = await blockingBlPop(
            responseKey,
            TEXT_EMBED_TIMEOUT_SECONDS,
        );
        if (!response?.element) throw new TextEmbeddingTimeoutError();
        return parseLegacyResponse(response.element);
    } finally {
        await redisClient.del(responseKey).catch(() => {});
    }
}

async function providerMatchesActiveSpace(): Promise<boolean> {
    if (Date.now() < providerMatchCacheExpiresAt) {
        return cachedProviderMatchesActive;
    }
    try {
        const [providerSpace, activeSpace] = await Promise.all([
            fetchProviderSpace(),
            getActiveSpace(),
        ]);
        assertProviderMatchesActiveSpace(providerSpace, activeSpace);
        cachedProviderMatchesActive = true;
    } catch {
        cachedProviderMatchesActive = false;
    }
    providerMatchCacheExpiresAt = Date.now() + PROVIDER_SPACE_MATCH_TTL_MS;
    return cachedProviderMatchesActive;
}

function warnProviderMismatch(): void {
    const now = Date.now();
    if (now - lastMismatchWarningAt < PROVIDER_SPACE_MATCH_TTL_MS) return;
    lastMismatchWarningAt = now;
    log.warn(
        "Vibe text provider does not match the active embedding space; using the legacy text tower",
    );
}

/** Clear process-local text-provider identity state after configuration changes. */
export function invalidateTextEmbeddingProviderSpaceCache(): void {
    cachedProviderMatchesActive = false;
    providerMatchCacheExpiresAt = 0;
    lastMismatchWarningAt = Number.NEGATIVE_INFINITY;
}

/** Resolve text embeddings through provider mode or the unchanged legacy stream. */
export async function resolveTextEmbedding(text: string): Promise<number[]> {
    if (!config.vibeProviderUrl) return embedTextWithLegacyStream(text);
    if (!(await providerMatchesActiveSpace())) {
        warnProviderMismatch();
        return embedTextWithLegacyStream(text);
    }
    try {
        return await embedText(text);
    } catch (error) {
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
}
