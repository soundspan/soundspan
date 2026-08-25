import assert from "node:assert";
import axios, { type AxiosInstance } from "axios";
import pLimit, { type LimitFunction } from "p-limit";
import { config } from "../../config";
import { logger } from "../../utils/logger";
import { getSystemSettings } from "../../utils/systemSettings";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_BASE_BACKOFF_MS = 300;
const DEFAULT_MAX_BACKOFF_MS = 3_000;
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Connection values required to authenticate requests to one Lidarr server. */
export interface LidarrConnection {
    baseUrl: string;
    apiKey: string;
}

interface LidarrHttpErrorDetails {
    status?: number;
    method: string;
    path: string;
    attempts: number;
    isTransient: boolean;
    cause?: unknown;
}

/** Safe, typed failure returned by the Lidarr HTTP boundary. */
export class LidarrHttpError extends Error {
    readonly status?: number;
    readonly method: string;
    readonly path: string;
    readonly attempts: number;
    readonly isTransient: boolean;
    readonly cause?: unknown;

    /** Creates a safe Lidarr failure without connection details or bodies. */
    constructor(details: LidarrHttpErrorDetails) {
        super(
            `Lidarr ${details.method} ${details.path} failed after ${details.attempts} attempt(s)`,
        );
        this.name = "LidarrHttpError";
        this.status = details.status;
        this.method = details.method;
        this.path = details.path;
        this.attempts = details.attempts;
        this.isTransient = details.isTransient;
        this.cause = details.cause;
        Error.captureStackTrace?.(this, LidarrHttpError);
    }
}

/** Runtime bounds and injectable delay behavior for a Lidarr client. */
export interface LidarrHttpClientOptions {
    timeoutMs?: number;
    maxRetries?: number;
    concurrency?: number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    sleep?: (ms: number) => Promise<void>;
}

/** Typed request accepted by the consolidated Lidarr HTTP boundary. */
export interface LidarrRequestConfig {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    params?: Record<string, unknown>;
    data?: unknown;
    retryable?: boolean;
    signal?: AbortSignal;
}

interface ResolvedOptions {
    timeoutMs: number;
    maxRetries: number;
    concurrency: number;
    baseBackoffMs: number;
    maxBackoffMs: number;
    sleep: (ms: number) => Promise<void>;
}

interface ErrorResponse {
    status?: unknown;
    headers?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function getErrorResponse(error: unknown): ErrorResponse | undefined {
    if (!isRecord(error) || !isRecord(error.response)) return undefined;
    return error.response;
}

function getStatus(error: unknown): number | undefined {
    const status = getErrorResponse(error)?.status;
    return typeof status === "number" ? status : undefined;
}

function isTransient(error: unknown): boolean {
    if (isAbortError(error)) return false;
    const response = getErrorResponse(error);
    if (!response) return true;
    const status = getStatus(error);
    return status !== undefined && TRANSIENT_STATUSES.has(status);
}

function isAbortError(error: unknown): boolean {
    if (!isRecord(error)) return false;
    return error.code === "ERR_CANCELED" || error.name === "CanceledError";
}

function classifyRetry(config: LidarrRequestConfig, error: unknown): boolean {
    const methodAllowsRetry = config.retryable ?? config.method !== "POST";
    return methodAllowsRetry && isTransient(error);
}

function computeBackoffMs(attempt: number, base: number, max: number): number {
    const exponential = base * 2 ** (attempt - 1);
    const jitter = Math.random() * base;
    return Math.min(max, exponential + jitter);
}

function readHeader(headers: unknown, name: string): unknown {
    if (!isRecord(headers)) return undefined;
    const getter = headers.get;
    if (typeof getter === "function") return getter.call(headers, name);
    const entry = Object.entries(headers).find(
        ([key]) => key.toLowerCase() === name.toLowerCase(),
    );
    return entry?.[1];
}

function retryAfterMs(error: unknown, maxBackoffMs: number): number | null {
    const status = getStatus(error);
    if (status !== 429 && status !== 503) return null;
    const value = readHeader(getErrorResponse(error)?.headers, "retry-after");
    if (typeof value !== "string" && typeof value !== "number") return null;
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.min(maxBackoffMs, seconds * 1_000);
}

function buildError(
    config: LidarrRequestConfig,
    error: unknown,
    attempts: number,
): LidarrHttpError {
    return new LidarrHttpError({
        status: getStatus(error),
        method: config.method,
        path: config.path,
        attempts,
        isTransient: isTransient(error),
        cause: error,
    });
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireInteger(value: number, minimum: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new Error(
            `${name} must be an integer greater than or equal to ${minimum}`,
        );
    }
}

function requireFinite(value: number, minimum: number, name: string): void {
    if (!Number.isFinite(value) || value < minimum) {
        throw new Error(`${name} must be greater than or equal to ${minimum}`);
    }
}

function resolveOptions(options: LidarrHttpClientOptions): ResolvedOptions {
    const resolved = {
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
        concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
        baseBackoffMs: options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
        maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
        sleep: options.sleep ?? defaultSleep,
    };
    requireInteger(resolved.timeoutMs, 1, "timeoutMs");
    requireInteger(resolved.maxRetries, 0, "maxRetries");
    requireInteger(resolved.concurrency, 1, "concurrency");
    requireFinite(resolved.baseBackoffMs, 0, "baseBackoffMs");
    requireFinite(resolved.maxBackoffMs, 0, "maxBackoffMs");
    return resolved;
}

function validateBaseUrl(baseUrl: string): boolean {
    try {
        const parsed = new URL(baseUrl);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}

function validateConnection(connection: LidarrConnection): void {
    if (!validateBaseUrl(connection.baseUrl)) {
        throw new Error("Lidarr base URL must use HTTP or HTTPS");
    }
    if (
        typeof connection.apiKey !== "string" ||
        connection.apiKey.trim() === ""
    ) {
        throw new Error("Lidarr API key must be a non-empty string");
    }
}

function assertRelativePath(path: string): void {
    assert(path.startsWith("/"), "Lidarr request path must start with /");
    assert(!path.startsWith("//"), "Lidarr request path must be relative");
}

async function executeAttempt<T>(
    instance: AxiosInstance,
    config: LidarrRequestConfig,
): Promise<{ data: T; status: number }> {
    return instance.request<T>({
        method: config.method,
        url: config.path,
        params: config.params,
        data: config.data,
        signal: config.signal,
    });
}

/** Bounded, typed HTTP client shared by backend Lidarr integrations. */
export class LidarrHttpClient {
    private readonly instance: AxiosInstance;
    private readonly limit: LimitFunction;
    private readonly options: ResolvedOptions;

    /** Creates one reusable axios instance and one concurrency limiter. */
    constructor(
        connection: LidarrConnection,
        options: LidarrHttpClientOptions = {},
    ) {
        validateConnection(connection);
        this.options = resolveOptions(options);
        this.instance = axios.create({
            baseURL: connection.baseUrl,
            timeout: this.options.timeoutMs,
            headers: { "X-Api-Key": connection.apiKey },
        });
        this.limit = pLimit(this.options.concurrency);
    }

    /** Executes one bounded request, including eligible retry attempts. */
    async request<T>(requestConfig: LidarrRequestConfig): Promise<T> {
        assertRelativePath(requestConfig.path);
        return this.limit(async () => {
            requestConfig.signal?.throwIfAborted();
            const maxAttempts = this.options.maxRetries + 1;
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                try {
                    requestConfig.signal?.throwIfAborted();
                    const response = await executeAttempt<T>(
                        this.instance,
                        requestConfig,
                    );
                    logger.debug("Lidarr HTTP request succeeded", {
                        method: requestConfig.method,
                        path: requestConfig.path,
                        status: response.status,
                        attempt,
                    });
                    return response.data as T;
                } catch (error: unknown) {
                    const shouldRetry =
                        classifyRetry(requestConfig, error) &&
                        attempt < maxAttempts;
                    if (!shouldRetry) {
                        logger.error("Lidarr HTTP request failed", {
                            method: requestConfig.method,
                            path: requestConfig.path,
                            status: getStatus(error),
                            attempt,
                            isTransient: isTransient(error),
                        });
                        throw buildError(requestConfig, error, attempt);
                    }
                    const delay =
                        retryAfterMs(error, this.options.maxBackoffMs) ??
                        computeBackoffMs(
                            attempt,
                            this.options.baseBackoffMs,
                            this.options.maxBackoffMs,
                        );
                    logger.warn("Retrying Lidarr HTTP request", {
                        method: requestConfig.method,
                        path: requestConfig.path,
                        status: getStatus(error),
                        attempt,
                        delayMs: delay,
                    });
                    await this.options.sleep(delay);
                    requestConfig.signal?.throwIfAborted();
                }
            }
            throw new Error("Lidarr request attempt bound was violated");
        });
    }

    /** Sends a typed GET request. */
    get<T>(
        path: string,
        params?: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<T> {
        return this.request<T>({ method: "GET", path, params, signal });
    }

    /** Sends a typed POST request. */
    post<T>(path: string, data?: unknown, signal?: AbortSignal): Promise<T> {
        return this.request<T>({ method: "POST", path, data, signal });
    }

    /** Sends a typed PUT request. */
    put<T>(path: string, data?: unknown, signal?: AbortSignal): Promise<T> {
        return this.request<T>({ method: "PUT", path, data, signal });
    }

    /** Sends a typed DELETE request. */
    delete<T>(
        path: string,
        params?: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<T> {
        return this.request<T>({ method: "DELETE", path, params, signal });
    }
}

/** Resolves a valid enabled Lidarr connection from database or environment settings. */
export async function resolveLidarrConnection(): Promise<LidarrConnection | null> {
    let settings: Awaited<ReturnType<typeof getSystemSettings>> = null;
    try {
        settings = await getSystemSettings();
    } catch {
        logger.error(
            "Unable to read Lidarr system settings; checking environment",
        );
    }
    if (
        settings?.lidarrEnabled &&
        settings.lidarrUrl &&
        settings.lidarrApiKey
    ) {
        if (!validateBaseUrl(settings.lidarrUrl)) {
            logger.warn("Configured Lidarr database URL is invalid");
            return null;
        }
        return { baseUrl: settings.lidarrUrl, apiKey: settings.lidarrApiKey };
    }
    const environment = config.lidarr;
    if (environment?.enabled && environment.url && environment.apiKey) {
        if (!validateBaseUrl(environment.url)) {
            logger.warn("Configured Lidarr environment URL is invalid");
            return null;
        }
        return { baseUrl: environment.url, apiKey: environment.apiKey };
    }
    return null;
}

/** Creates a bounded Lidarr client when a valid enabled connection is configured. */
export async function createLidarrClient(
    options?: LidarrHttpClientOptions,
): Promise<LidarrHttpClient | null> {
    const connection = await resolveLidarrConnection();
    if (!connection) return null;
    return new LidarrHttpClient(connection, options);
}
