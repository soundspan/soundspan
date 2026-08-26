import assert from "node:assert";
import axios, { type AxiosInstance } from "axios";
import pLimit, { type LimitFunction } from "p-limit";
import { config } from "../../config";
import { toErrorMessage } from "../../utils/errors";
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
    data?: unknown;
    message?: string;
}

/** Safe, typed failure returned by the Lidarr HTTP boundary. */
export class LidarrHttpError extends Error {
    readonly status?: number;
    readonly method: string;
    readonly path: string;
    readonly attempts: number;
    readonly isTransient: boolean;
    readonly response?: { status: number; data: unknown };

    /** Creates a safe Lidarr failure without connection details or bodies. */
    constructor(details: LidarrHttpErrorDetails) {
        super(
            details.message ??
                `Lidarr ${details.method} ${details.path} failed after ${details.attempts} attempt(s)`,
        );
        this.name = "LidarrHttpError";
        this.status = details.status;
        this.method = details.method;
        this.path = details.path;
        this.attempts = details.attempts;
        this.isTransient = details.isTransient;
        this.response =
            details.status === undefined
                ? undefined
                : { status: details.status, data: details.data };
        Error.captureStackTrace?.(this, LidarrHttpError);
    }
}

/** Returns Lidarr's first validation message, or the safe error message. */
export function getLidarrErrorMessage(error: unknown): string {
    if (!(error instanceof LidarrHttpError)) return toErrorMessage(error);
    const data = getResponseData(error);
    if (!Array.isArray(data) || !isRecord(data[0])) {
        return toErrorMessage(error);
    }
    const message = data[0].errorMessage;
    return typeof message === "string" ? message : toErrorMessage(error);
}

/** Returns safe structured fields for logging a Lidarr failure. */
export function lidarrErrorLogFields(error: unknown) {
    return {
        message: error instanceof Error ? toErrorMessage(error) : undefined,
        status: error instanceof LidarrHttpError ? error.status : undefined,
        path: error instanceof LidarrHttpError ? error.path : undefined,
    };
}

/** Runtime bounds and injectable delay behavior for a Lidarr client. */
export interface LidarrHttpClientOptions {
    timeoutMs?: number;
    maxRetries?: number;
    concurrency?: number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Typed request accepted by the consolidated Lidarr HTTP boundary. */
export interface LidarrRequestConfig {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    params?: Record<string, unknown>;
    data?: unknown;
    retryable?: boolean;
    signal?: AbortSignal;
    responseType?: "json" | "stream";
    maxContentLength?: number;
    maxBodyLength?: number;
    timeoutMs?: number;
    maxRetries?: number;
}

/** Axios-compatible response subset used by existing Lidarr service calls. */
export interface LidarrHttpResponse<T> {
    data: T;
    status: number;
}

/** Per-call options that do not own timeout, retry, or concurrency policy. */
export interface LidarrCallConfig {
    params?: Record<string, unknown>;
    signal?: AbortSignal;
    responseType?: "json" | "stream";
    maxContentLength?: number;
    maxBodyLength?: number;
    timeoutMs?: number;
    maxRetries?: number;
}

interface ResolvedOptions {
    timeoutMs: number;
    maxRetries: number;
    concurrency: number;
    baseBackoffMs: number;
    maxBackoffMs: number;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface ErrorResponse {
    status?: unknown;
    headers?: unknown;
    data?: unknown;
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

function getResponseData(error: unknown): unknown {
    return getErrorResponse(error)?.data;
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
        data: getResponseData(error),
        message: toErrorMessage(error),
    });
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
            cleanup();
            reject(signal?.reason);
        };
        const timeout = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

async function sleepUntilRetry(
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
    delayMs: number,
    config: LidarrRequestConfig,
    attempts: number,
): Promise<void> {
    const signal = config.signal;
    if (!signal) {
        await sleep(delayMs);
        return;
    }
    let abortRetry: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        abortRetry = () => reject(signal.reason);
        signal.addEventListener("abort", abortRetry, { once: true });
    });
    try {
        signal.throwIfAborted();
        await Promise.race([sleep(delayMs, signal), aborted]);
    } catch (error: unknown) {
        if (!signal.aborted) throw error;
        logger.error("Lidarr HTTP request canceled during retry backoff", {
            method: config.method,
            path: config.path,
            attempt: attempts,
            isTransient: false,
        });
        throw new LidarrHttpError({
            method: config.method,
            path: config.path,
            attempts,
            isTransient: false,
            message: `Lidarr ${config.method} ${config.path} canceled during retry backoff after ${attempts} attempt(s)`,
        });
    } finally {
        if (abortRetry) signal.removeEventListener("abort", abortRetry);
    }
}

/** Runs async work in bounded batches and preserves input/result ordering. */
export async function allSettledWithConcurrency<T, R>(
    items: readonly T[],
    concurrency: number,
    operation: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
    requireInteger(concurrency, 1, "concurrency");
    const results: PromiseSettledResult<R>[] = [];
    for (let offset = 0; offset < items.length; offset += concurrency) {
        const batch = items.slice(offset, offset + concurrency);
        results.push(...(await Promise.allSettled(batch.map(operation))));
    }
    return results;
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
): Promise<LidarrHttpResponse<T>> {
    return instance.request<T>({
        method: config.method,
        url: config.path,
        params: config.params,
        data: config.data,
        signal: config.signal,
        responseType: config.responseType,
        maxContentLength: config.maxContentLength,
        maxBodyLength: config.maxBodyLength,
        timeout: config.timeoutMs,
    });
}

function isCallConfig(
    value: LidarrCallConfig | Record<string, unknown>,
): value is LidarrCallConfig {
    return [
        "params",
        "signal",
        "responseType",
        "maxContentLength",
        "maxBodyLength",
        "timeoutMs",
        "maxRetries",
    ].some((key) => key in value);
}

function resolveCallConfig(
    configOrParams?: LidarrCallConfig | Record<string, unknown>,
    signal?: AbortSignal,
): LidarrCallConfig {
    if (!configOrParams) return { signal };
    if (isCallConfig(configOrParams)) {
        return { ...configOrParams, signal: signal ?? configOrParams.signal };
    }
    return { params: configOrParams, signal };
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
    async request<T = any>(requestConfig: LidarrRequestConfig): Promise<T> {
        const response = await this.requestWithResponse<T>(requestConfig);
        return response.data;
    }

    private async requestWithResponse<T>(
        requestConfig: LidarrRequestConfig,
    ): Promise<LidarrHttpResponse<T>> {
        assertRelativePath(requestConfig.path);
        requestConfig.signal?.throwIfAborted();
        const maxRetries = requestConfig.maxRetries ?? this.options.maxRetries;
        requireInteger(maxRetries, 0, "maxRetries");
        const maxAttempts = maxRetries + 1;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                requestConfig.signal?.throwIfAborted();
                const response = await this.limit(() =>
                    executeAttempt<T>(this.instance, requestConfig),
                );
                logger.debug("Lidarr HTTP request succeeded", {
                    method: requestConfig.method,
                    path: requestConfig.path,
                    status: response.status,
                    attempt,
                });
                return response;
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
                await sleepUntilRetry(
                    this.options.sleep,
                    delay,
                    requestConfig,
                    attempt,
                );
            }
        }
        throw new Error("Lidarr request attempt bound was violated");
    }

    /** Sends a typed GET request. */
    get<T = any>(
        path: string,
        configOrParams?: LidarrCallConfig | Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<LidarrHttpResponse<T>> {
        const config = resolveCallConfig(configOrParams, signal);
        return this.requestWithResponse<T>({ method: "GET", path, ...config });
    }

    /** Sends a typed POST request. */
    post<T = any>(
        path: string,
        data?: unknown,
        config: LidarrCallConfig = {},
    ): Promise<LidarrHttpResponse<T>> {
        return this.requestWithResponse<T>({
            method: "POST",
            path,
            data,
            ...config,
        });
    }

    /** Sends a typed PUT request. */
    put<T = any>(
        path: string,
        data?: unknown,
        config: LidarrCallConfig = {},
    ): Promise<LidarrHttpResponse<T>> {
        return this.requestWithResponse<T>({
            method: "PUT",
            path,
            data,
            ...config,
        });
    }

    /** Sends a typed DELETE request. */
    delete<T = any>(
        path: string,
        configOrParams?: LidarrCallConfig | Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<LidarrHttpResponse<T>> {
        const config = resolveCallConfig(configOrParams, signal);
        return this.requestWithResponse<T>({
            method: "DELETE",
            path,
            ...config,
        });
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
