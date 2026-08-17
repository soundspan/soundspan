import { z } from "zod";
import { config } from "../config";
import { recordVibeProviderRequest } from "../metrics";
import type {
    VibeProviderEndpoint,
    VibeProviderOutcome,
} from "../metrics/providerMetrics";
import { getActiveSpace, type ActiveEmbeddingSpace } from "./embeddingSpaces";

/** Shared deadline for provider identity and health operations. */
export const PROVIDER_SPACE_HEALTH_TIMEOUT_MS = 5_000;
/** Deadline for provider text inference. */
export const PROVIDER_TEXT_TIMEOUT_MS = 30_000;
/** Deadline for provider audio inference. */
export const PROVIDER_AUDIO_TIMEOUT_MS = 120_000;

const UNIT_NORM_TOLERANCE = 1e-3;
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
    dim: z.number().int().positive(),
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

function providerUrl(path: string): string {
    const baseUrl = config.vibeProviderUrl;
    if (!baseUrl) throw new VibeProviderUnavailableError();
    return `${baseUrl.replace(/\/+$/, "")}${path}`;
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

async function requestJson(
    path: string,
    timeoutMs: number,
    init: Pick<RequestInit, "method" | "body">,
): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(providerUrl(path), {
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

function assertUnitVector(
    vector: readonly number[],
    targetSpace: EmbeddingVectorSpace,
): void {
    if (vector.length !== targetSpace.dim) {
        throw new VibeProviderContractError();
    }
    const squaredNorm = vector.reduce((sum, value) => sum + value * value, 0);
    const norm = Math.sqrt(squaredNorm);
    if (Math.abs(norm - 1) > UNIT_NORM_TOLERANCE) {
        throw new VibeProviderContractError();
    }
}

/** Assert that provider identity matches the active registry tuple. */
export function assertProviderMatchesActiveSpace(
    providerSpace: ProviderSpace,
    activeSpace: ActiveEmbeddingSpace,
): void {
    const matches =
        providerSpace.family === activeSpace.family &&
        providerSpace.checkpointHash === activeSpace.checkpointHash &&
        providerSpace.dim === activeSpace.dim;
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
        assertUnitVector(parsed.vector, targetSpace);
        return parsed.vector;
    });
}

/** Embed text through the configured provider and active-space trust boundary. */
export async function embedText(text: string): Promise<number[]> {
    const validatedText = parseWithContract(textInputSchema, text);
    const activeSpace = await getActiveSpace();
    return embed(
        "text",
        "/v1/embed/text",
        { text: validatedText },
        PROVIDER_TEXT_TIMEOUT_MS,
        activeSpace,
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
