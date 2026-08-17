import { z } from "zod";
import { config } from "../config";
import { recordVibeProviderRequest } from "../metrics";
import type {
    VibeProviderEndpoint,
    VibeProviderOutcome,
} from "../metrics/providerMetrics";
import {
    embeddingPreprocessingMatches,
    getActiveSpace,
    type ActiveEmbeddingSpace,
} from "./embeddingSpaces";

/** Shared deadline for provider identity and health operations. */
export const PROVIDER_SPACE_HEALTH_TIMEOUT_MS = 5_000;
/** Deadline for provider text inference. */
export const PROVIDER_TEXT_TIMEOUT_MS = 30_000;
/** Deadline for provider audio inference. */
export const PROVIDER_AUDIO_TIMEOUT_MS = 120_000;

const UNIT_NORM_TOLERANCE = 1e-3;
const MAX_PROVIDER_VECTOR_DIMENSION = 8_192;
const textInputSchema = z.string().min(1).max(2_048);
const trackRefSchema = z.string().min(1);
const vectorResponseSchema = z.strictObject({
    vector: z.array(z.number().finite()),
});
const errorResponseSchema = z.object({
    error: z.string().min(1),
});
const providerSpaceSchema = z.object({
    family: z.string().min(1),
    checkpointHash: z.string().min(1),
    dim: z.number().int().positive().max(MAX_PROVIDER_VECTOR_DIMENSION),
    sampleRateHz: z.number().int().positive(),
    preprocessing: z.record(z.string(), z.json()),
    revision: z.string().min(1),
    textTower: z.boolean(),
});

/** Validated provider embedding-space identity and capability metadata. */
export type ProviderSpace = z.infer<typeof providerSpaceSchema>;

/** Registry identity required to validate one provider vector response. */
export type EmbeddingVectorSpace = Pick<ActiveEmbeddingSpace, "id" | "dim">;

type VibeProviderErrorCode =
    | "unreachable"
    | "timeout"
    | "auth"
    | "contract"
    | "provider_5xx"
    | "request_rejected"
    | "space_mismatch";

/** Base class for stable vibe-provider failure classification. */
export class VibeProviderError extends Error {
    constructor(
        public readonly code: VibeProviderErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "VibeProviderError";
    }
}

/** Raised when the configured provider cannot be reached. */
export class VibeProviderUnavailableError extends VibeProviderError {
    constructor(cause?: unknown) {
        super("unreachable", "Vibe provider is unreachable", { cause });
        this.name = "VibeProviderUnavailableError";
    }
}

/** Raised when a provider operation exceeds its fixed deadline. */
export class VibeProviderTimeoutError extends VibeProviderError {
    constructor(cause?: unknown) {
        super("timeout", "Vibe provider request timed out", { cause });
        this.name = "VibeProviderTimeoutError";
    }
}

/** Raised when the provider rejects the internal credential. */
export class VibeProviderAuthError extends VibeProviderError {
    constructor(message = "Vibe provider authentication failed") {
        super("auth", message);
        this.name = "VibeProviderAuthError";
    }
}

/** Raised when provider data violates the v1 wire or vector contract. */
export class VibeProviderContractError extends VibeProviderError {
    constructor(cause?: unknown) {
        super("contract", "Vibe provider returned an invalid response", {
            cause,
        });
        this.name = "VibeProviderContractError";
    }
}

/** Raised when the provider reports an internal service failure. */
export class VibeProviderServerError extends VibeProviderError {
    constructor(
        public readonly status: number,
        message = `Vibe provider returned ${status}`,
    ) {
        super("provider_5xx", message);
        this.name = "VibeProviderServerError";
    }
}

/** Raised when the provider rejects a validly transported request. */
export class VibeProviderRequestError extends VibeProviderError {
    constructor(
        public readonly status: number,
        message = `Vibe provider rejected the request (${status})`,
    ) {
        super("request_rejected", message);
        this.name = "VibeProviderRequestError";
    }
}

/** Raised when provider and active registry identities differ. */
export class VibeProviderSpaceMismatchError extends VibeProviderError {
    constructor() {
        super(
            "space_mismatch",
            "Vibe provider does not match the active space",
        );
        this.name = "VibeProviderSpaceMismatchError";
    }
}

function metricOutcome(error: unknown): VibeProviderOutcome {
    if (error instanceof VibeProviderTimeoutError) return "timeout";
    if (error instanceof VibeProviderAuthError) return "auth";
    if (error instanceof VibeProviderContractError) return "contract";
    if (error instanceof VibeProviderSpaceMismatchError) return "mismatch";
    return "error";
}

/** Operations exposed by one provider URL and its declared embedding space. */
export interface VibeProviderClient {
    fetchSpace(): Promise<ProviderSpace>;
    embedText(text: string): Promise<number[]>;
    embedAudio(trackRef: string): Promise<number[]>;
}

/** Parse and normalize an operator-supplied provider base URL. */
export function normalizeProviderBaseUrl(value: string): string {
    try {
        const url = new URL(value.trim());
        const valid =
            (url.protocol === "http:" || url.protocol === "https:") &&
            Boolean(url.hostname) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash;
        if (!valid) throw new TypeError("invalid provider URL");
        return url.toString().replace(/\/+$/, "");
    } catch (error) {
        throw new TypeError(
            "provider URL must be HTTP(S) without credentials",
            {
                cause: error,
            },
        );
    }
}

function configuredProviderBaseUrl(): string {
    const baseUrl = config.vibeProviderUrl;
    if (!baseUrl) throw new VibeProviderUnavailableError();
    return normalizeProviderBaseUrl(baseUrl);
}

function requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
    };
    if (config.internalApiSecret) {
        headers["X-Internal-Secret"] = config.internalApiSecret;
    }
    return headers;
}

async function parseJson(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch (error) {
        throw new VibeProviderContractError(error);
    }
}

function throwForStatus(status: number, body: unknown): never {
    const parsedError = errorResponseSchema.safeParse(body);
    const message = parsedError.success ? parsedError.data.error : undefined;
    if (status === 401) throw new VibeProviderAuthError(message);
    if (status >= 500) throw new VibeProviderServerError(status, message);
    throw new VibeProviderRequestError(status, message);
}

async function parseErrorBody(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return undefined;
    }
}

async function requestJsonAt(
    baseUrl: string,
    path: string,
    timeoutMs: number,
    init: Pick<RequestInit, "method" | "body">,
): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${baseUrl}${path}`, {
            ...init,
            headers: requestHeaders(),
            redirect: "error",
            signal: controller.signal,
        });
        if (!response.ok) {
            const body = await parseErrorBody(response);
            throwForStatus(response.status, body);
        }
        return await parseJson(response);
    } catch (error) {
        if (controller.signal.aborted)
            throw new VibeProviderTimeoutError(error);
        if (error instanceof VibeProviderError) throw error;
        throw new VibeProviderUnavailableError(error);
    } finally {
        clearTimeout(timeout);
    }
}

async function requestJson(
    path: string,
    timeoutMs: number,
    init: Pick<RequestInit, "method" | "body">,
): Promise<unknown> {
    return requestJsonAt(configuredProviderBaseUrl(), path, timeoutMs, init);
}

async function observeRequest<T>(
    endpoint: VibeProviderEndpoint,
    operation: () => Promise<T>,
): Promise<T> {
    const startedAt = process.hrtime.bigint();
    try {
        const result = await operation();
        const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
        recordVibeProviderRequest(endpoint, "ok", seconds);
        return result;
    } catch (error) {
        const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
        recordVibeProviderRequest(endpoint, metricOutcome(error), seconds);
        throw error;
    }
}

function parseWithContract<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new VibeProviderContractError(parsed.error);
    return parsed.data;
}

/** Assert finite values, declared dimension, and unit norm for one provider. */
export function assertProviderVector(
    vector: readonly number[],
    expectedDimension: number,
): void {
    if (
        !Array.isArray(vector) ||
        !Number.isInteger(expectedDimension) ||
        expectedDimension < 1 ||
        expectedDimension > MAX_PROVIDER_VECTOR_DIMENSION ||
        vector.length !== expectedDimension ||
        !vector.every(Number.isFinite)
    ) {
        throw new VibeProviderContractError();
    }
    const squaredNorm = vector.reduce((sum, value) => sum + value * value, 0);
    const norm = Math.sqrt(squaredNorm);
    if (Math.abs(norm - 1) > UNIT_NORM_TOLERANCE) {
        throw new VibeProviderContractError();
    }
}

async function requestEmbeddingAt(
    baseUrl: string,
    endpoint: "text" | "audio",
    body: Readonly<Record<string, string>>,
    expectedDimension: number,
): Promise<number[]> {
    const path = endpoint === "text" ? "/v1/embed/text" : "/v1/embed/audio";
    const timeout =
        endpoint === "text"
            ? PROVIDER_TEXT_TIMEOUT_MS
            : PROVIDER_AUDIO_TIMEOUT_MS;
    return observeRequest(endpoint, async () => {
        const response = await requestJsonAt(baseUrl, path, timeout, {
            method: "POST",
            body: JSON.stringify(body),
        });
        const parsed = parseWithContract(vectorResponseSchema, response);
        assertProviderVector(parsed.vector, expectedDimension);
        return parsed.vector;
    });
}

/** Create a provider client whose vectors are checked against its own `/v1/space`. */
export function createProviderClient(baseUrl: string): VibeProviderClient {
    const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl);
    let declaredSpace: ProviderSpace | undefined;
    const fetchSpace = async (): Promise<ProviderSpace> =>
        observeRequest("space", async () => {
            const body = await requestJsonAt(
                normalizedBaseUrl,
                "/v1/space",
                PROVIDER_SPACE_HEALTH_TIMEOUT_MS,
                { method: "GET" },
            );
            declaredSpace = parseWithContract(providerSpaceSchema, body);
            return declaredSpace;
        });
    const requireSpace = async (): Promise<ProviderSpace> =>
        declaredSpace ?? fetchSpace();
    return {
        fetchSpace,
        embedText: async (text) => {
            const validated = parseWithContract(textInputSchema, text);
            const space = await requireSpace();
            return requestEmbeddingAt(
                normalizedBaseUrl,
                "text",
                { text: validated },
                space.dim,
            );
        },
        embedAudio: async (trackRef) => {
            const validated = parseWithContract(trackRefSchema, trackRef);
            const space = await requireSpace();
            return requestEmbeddingAt(
                normalizedBaseUrl,
                "audio",
                { trackRef: validated },
                space.dim,
            );
        },
    };
}

/** Assert that provider identity matches the active registry tuple. */
export function assertProviderMatchesActiveSpace(
    providerSpace: ProviderSpace,
    activeSpace: ActiveEmbeddingSpace,
): void {
    const matches =
        providerSpace.family === activeSpace.family &&
        providerSpace.checkpointHash === activeSpace.checkpointHash &&
        providerSpace.dim === activeSpace.dim &&
        embeddingPreprocessingMatches(
            activeSpace.preprocessing,
            providerSpace.preprocessing,
        );
    if (!matches) throw new VibeProviderSpaceMismatchError();
}

/** Fetch and validate provider identity for worker-side registry resolution. */
export async function fetchProviderSpace(): Promise<ProviderSpace> {
    return observeRequest("space", async () => {
        const body = await requestJson(
            "/v1/space",
            PROVIDER_SPACE_HEALTH_TIMEOUT_MS,
            { method: "GET" },
        );
        return parseWithContract(providerSpaceSchema, body);
    });
}

async function embed(
    endpoint: "text" | "audio",
    path: string,
    body: Readonly<Record<string, string>>,
    timeoutMs: number,
    targetSpace: EmbeddingVectorSpace,
): Promise<number[]> {
    return observeRequest(endpoint, async () => {
        const response = await requestJson(path, timeoutMs, {
            method: "POST",
            body: JSON.stringify(body),
        });
        const parsed = parseWithContract(vectorResponseSchema, response);
        assertProviderVector(parsed.vector, targetSpace.dim);
        return parsed.vector;
    });
}

/** Embed text through the configured provider and a registered-space boundary. */
export async function embedText(
    text: string,
    targetSpace?: EmbeddingVectorSpace,
): Promise<number[]> {
    const validatedText = parseWithContract(textInputSchema, text);
    const resolvedTargetSpace = targetSpace ?? (await getActiveSpace());
    return embed(
        "text",
        "/v1/embed/text",
        { text: validatedText },
        PROVIDER_TEXT_TIMEOUT_MS,
        resolvedTargetSpace,
    );
}

/** Embed one provider-owned track reference through its worker target boundary. */
export async function embedAudio(
    trackRef: string,
    targetSpace: EmbeddingVectorSpace,
): Promise<number[]> {
    const validatedTrackRef = parseWithContract(trackRefSchema, trackRef);
    return embed(
        "audio",
        "/v1/embed/audio",
        { trackRef: validatedTrackRef },
        PROVIDER_AUDIO_TIMEOUT_MS,
        targetSpace,
    );
}
