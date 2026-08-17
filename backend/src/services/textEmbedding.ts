import { randomUUID } from "crypto";
import { config } from "../config";
import { blockingBlPop, redisClient } from "../utils/redis";
import {
    embedText,
    VibeProviderError,
    VibeProviderTimeoutError,
    VibeProviderUnavailableError,
} from "./vibeProvider";

const TEXT_EMBED_REQUEST_STREAM = "audio:text:embed:requests";
const TEXT_EMBED_RESPONSE_PREFIX = "audio:text:embed:response:";
const TEXT_EMBED_TIMEOUT_SECONDS = 30;
const TEXT_EMBED_REQUEST_STREAM_MAX_LENGTH = 100;

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

/** Resolve text embeddings through provider mode or the unchanged legacy stream. */
export async function resolveTextEmbedding(text: string): Promise<number[]> {
    if (!config.vibeProviderUrl) return embedTextWithLegacyStream(text);
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
