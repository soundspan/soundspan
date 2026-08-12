import { resolveApiBaseUrl } from "../api-base-url";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

const AUTH_TOKEN_KEY = "auth_token";
const REFRESH_TOKEN_KEY = "refresh_token";
const PLAYBACK_DEVICE_ID_KEY = "soundspan_playback_device_id";
const DEFAULT_API_TIMEOUT_MS = 15_000;
const AUTH_REFRESH_TIMEOUT_MS = 10_000;
export const IMPORT_PREVIEW_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_RETRY_BACKOFF_MS = 350;
const MAX_TIMEOUT_RETRIES = 1;
const PROACTIVE_REFRESH_LIFETIME_RATIO = 0.8;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ApiError extends Error {
    status?: number;
    data?: Record<string, unknown>;
}

export interface ServiceTestResult {
    success?: boolean;
    version?: string;
    error?: string;
}

// API response data type - represents unvalidated JSON from the server.
// Using a single suppression here allows all 100+ API methods to return
// properly loose types without scattering suppressions across the file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ApiData = any;

// Mixin base constructor for domain modules. `any[]` is required by the TS
// mixin pattern; scoped to this single alias.
export type ApiClientConstructor = abstract new (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...args: any[]
) => ApiClientCore;

export function toSearchParams(
    params: Record<string, string | number | boolean | undefined>,
): URLSearchParams {
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
            entries[key] = String(value);
        }
    }
    return new URLSearchParams(entries);
}

const getApiBaseUrl = () => {
    if (typeof window === "undefined") {
        return resolveApiBaseUrl({
            isServer: true,
            backendUrl: process.env.BACKEND_URL,
        });
    }

    return resolveApiBaseUrl({
        isServer: false,
        configuredApiUrl: process.env.NEXT_PUBLIC_API_URL,
        apiPathMode: process.env.NEXT_PUBLIC_API_PATH_MODE,
        browserLocation: window.location,
    });
};

export abstract class ApiClientCore {
    private baseUrl: string;
    protected token: string | null = null;
    protected tokenInitialized: boolean = false;
    private readonly inFlightGetRequests = new Map<string, Promise<unknown>>();
    private refreshPromise: Promise<boolean> | null = null;
    private proactiveRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private proactiveRefreshAtMs: number | null = null;

    private readonly handleVisibilityChange = (): void => {
        if (
            typeof window === "undefined" ||
            typeof document === "undefined" ||
            document.visibilityState !== "visible" ||
            this.proactiveRefreshAtMs === null ||
            Date.now() < this.proactiveRefreshAtMs
        ) {
            return;
        }

        this.cancelProactiveRefreshTimer();
        void this.refreshAccessToken();
    };

    constructor(baseUrl?: string) {
        // Don't set baseUrl in constructor - determine it dynamically on each request
        this.baseUrl = baseUrl || "";

        // Try to load token synchronously
        if (typeof window !== "undefined") {
            this.token = localStorage.getItem(AUTH_TOKEN_KEY);
            if (this.token) {
                this.tokenInitialized = true;
                this.scheduleProactiveTokenRefresh(this.token);
            }
            // Note: Refresh token is loaded on-demand via getRefreshToken()
        }

        if (typeof window !== "undefined" && typeof document !== "undefined") {
            document.addEventListener(
                "visibilitychange",
                this.handleVisibilityChange,
            );
        }
    }

    /**
     * Initialize the auth token from storage
     * Call this early in the app lifecycle to ensure the token is loaded
     */
    async initToken(): Promise<string | null> {
        if (typeof window === "undefined") {
            return null;
        }

        const storedToken = localStorage.getItem(AUTH_TOKEN_KEY);
        if (storedToken) {
            this.token = storedToken;
            this.scheduleProactiveTokenRefresh(storedToken);
        }

        this.tokenInitialized = true;
        return this.token;
    }

    /**
     * Check if token has been initialized
     */
    isTokenInitialized(): boolean {
        return this.tokenInitialized;
    }

    /**
     * Get the current token (may be null)
     */
    getToken(): string | null {
        return this.token;
    }

    // Refresh the base URL from configuration
    refreshBaseUrl(): void {
        this.baseUrl = "";
    }

    // Store JWT token and optionally refresh token
    setToken(token: string, refreshToken?: string) {
        this.token = token;
        if (typeof window !== "undefined") {
            localStorage.setItem(AUTH_TOKEN_KEY, token);
            if (refreshToken) {
                localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
            }
        }
        this.scheduleProactiveTokenRefresh(token);
    }

    // Get refresh token from storage
    getRefreshToken(): string | null {
        if (typeof window === "undefined") {
            return null;
        }
        return localStorage.getItem(REFRESH_TOKEN_KEY);
    }

    // Clear both JWT tokens
    clearToken() {
        this.token = null;
        this.clearProactiveRefreshSchedule();
        if (typeof window !== "undefined") {
            localStorage.removeItem(AUTH_TOKEN_KEY);
            localStorage.removeItem(REFRESH_TOKEN_KEY);
        }
    }

    private decodeTokenExpiryMs(token: string): number | null {
        const payloadSegment = token.split(".")[1];
        if (!payloadSegment || typeof atob !== "function") {
            return null;
        }

        try {
            const base64Payload = payloadSegment
                .replace(/-/g, "+")
                .replace(/_/g, "/");
            const paddedPayload = base64Payload.padEnd(
                Math.ceil(base64Payload.length / 4) * 4,
                "=",
            );
            const payload: unknown = JSON.parse(atob(paddedPayload));
            if (!payload || typeof payload !== "object") {
                return null;
            }

            const expiresAtSeconds = (payload as Record<string, unknown>).exp;
            const expiresAtMs = Number(expiresAtSeconds) * 1000;
            return typeof expiresAtSeconds === "number" &&
                Number.isFinite(expiresAtMs) &&
                expiresAtMs > 0
                ? expiresAtMs
                : null;
        } catch {
            return null;
        }
    }

    private scheduleProactiveTokenRefresh(token: string): void {
        this.clearProactiveRefreshSchedule();
        if (typeof window === "undefined") {
            return;
        }

        const expiresAtMs = this.decodeTokenExpiryMs(token);
        if (expiresAtMs === null) {
            return;
        }

        const nowMs = Date.now();
        const remainingLifetimeMs = Math.max(0, expiresAtMs - nowMs);
        const refreshDelayMs = Math.min(
            Math.floor(remainingLifetimeMs * PROACTIVE_REFRESH_LIFETIME_RATIO),
            MAX_TIMER_DELAY_MS,
        );
        this.proactiveRefreshAtMs = nowMs + refreshDelayMs;
        this.proactiveRefreshTimer = setTimeout(() => {
            this.proactiveRefreshTimer = null;
            void this.refreshAccessToken();
        }, refreshDelayMs);
    }

    private cancelProactiveRefreshTimer(): void {
        if (this.proactiveRefreshTimer === null) {
            return;
        }
        clearTimeout(this.proactiveRefreshTimer);
        this.proactiveRefreshTimer = null;
    }

    private clearProactiveRefreshSchedule(): void {
        this.cancelProactiveRefreshTimer();
        this.proactiveRefreshAtMs = null;
    }

    // Get the base URL dynamically to support switching between localhost and IP
    protected getBaseUrl(): string {
        if (this.baseUrl) {
            return this.baseUrl;
        }
        return getApiBaseUrl();
    }

    protected toAbsoluteApiUrl(pathOrUrl: string): string {
        if (/^https?:\/\//i.test(pathOrUrl)) {
            return pathOrUrl;
        }
        const normalizedPath = pathOrUrl.startsWith("/")
            ? pathOrUrl
            : `/${pathOrUrl}`;
        return `${this.getBaseUrl()}${normalizedPath}`;
    }

    private isTimeoutError(error: unknown): boolean {
        return error instanceof Error && (error as ApiError).status === 408;
    }

    private async delay(ms: number): Promise<void> {
        await new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    /**
     * Refresh the access token using the refresh token
     * @returns true if refresh succeeded, false otherwise
     */
    private async performTokenRefresh(): Promise<boolean> {
        const refreshToken = this.getRefreshToken();
        if (!refreshToken) {
            return false;
        }

        try {
            let response: Response | null = null;
            for (let attempt = 0; attempt <= MAX_TIMEOUT_RETRIES; attempt++) {
                try {
                    response = await this.fetchWithTimeout(
                        `${this.getBaseUrl()}/api/auth/refresh`,
                        {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ refreshToken }),
                            credentials: "include",
                        },
                        AUTH_REFRESH_TIMEOUT_MS,
                    );
                    break;
                } catch (error) {
                    if (
                        this.isTimeoutError(error) &&
                        attempt < MAX_TIMEOUT_RETRIES
                    ) {
                        await this.delay(DEFAULT_TIMEOUT_RETRY_BACKOFF_MS);
                        continue;
                    }
                    throw error;
                }
            }

            if (!response) {
                return false;
            }

            if (!response.ok) {
                // Refresh token invalid or expired - clear tokens
                this.clearToken();
                return false;
            }

            const data = await response.json();

            // Store new tokens
            if (data.token) {
                this.setToken(data.token, data.refreshToken);
                return true;
            }

            this.clearToken();
            return false;
        } catch (error) {
            sharedFrontendLogger.error("[API] Token refresh failed:", error);
            this.clearToken();
            return false;
        }
    }

    /**
     * Refresh the access token using the refresh token.
     * Single-flight: concurrent callers share one in-flight refresh so N
     * simultaneous 401s trigger exactly one POST /api/auth/refresh (mirrors the
     * inFlightGetRequests dedup pattern). The shared promise is always cleared
     * in `finally`, on both success and failure.
     * @returns true if refresh succeeded, false otherwise
     */
    private async refreshAccessToken(): Promise<boolean> {
        if (this.refreshPromise) {
            return this.refreshPromise;
        }
        this.refreshPromise = this.performTokenRefresh();
        try {
            return await this.refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
    }

    /**
     * Make an authenticated API request
     * Public method for components that need custom API calls
     */
    private async fetchWithTimeout(
        url: string,
        options: RequestInit,
        timeoutMs: number,
    ): Promise<Response> {
        const controller = new AbortController();
        const upstreamSignal = options.signal;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let timedOut = false;

        const abortFromUpstream = () => {
            controller.abort((upstreamSignal as AbortSignal).reason);
        };

        if (upstreamSignal) {
            if (upstreamSignal.aborted) {
                abortFromUpstream();
            } else {
                upstreamSignal.addEventListener("abort", abortFromUpstream, {
                    once: true,
                });
            }
        }

        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
            timeoutId = setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, timeoutMs);
        }

        try {
            return await fetch(url, {
                ...options,
                signal: controller.signal,
            });
        } catch (error) {
            if (timedOut) {
                const timeoutError = new Error(
                    `Request timed out after ${timeoutMs}ms`,
                );
                (timeoutError as ApiError).status = 408;
                (timeoutError as ApiError).data = {
                    error: "Request timeout",
                    timeoutMs,
                };
                throw timeoutError;
            }
            throw error;
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            if (upstreamSignal) {
                upstreamSignal.removeEventListener("abort", abortFromUpstream);
            }
        }
    }

    private buildInFlightGetKey(
        endpoint: string,
        timeoutMs: number,
        hasSignal: boolean,
    ): string | null {
        if (hasSignal) return null;
        return `${endpoint}|timeout=${timeoutMs}|token=${this.token ?? ""}`;
    }

    async request<T>(
        endpoint: string,
        options: RequestInit & {
            silent404?: boolean;
            _retryCount?: number;
            _timeoutRetryCount?: number;
            timeoutMs?: number;
        } = {},
    ): Promise<T> {
        const {
            silent404,
            _retryCount = 0,
            _timeoutRetryCount = 0,
            timeoutMs = DEFAULT_API_TIMEOUT_MS,
            ...fetchOptions
        } = options;
        const headers: HeadersInit = {
            "Content-Type": "application/json",
            ...fetchOptions.headers,
        };

        // Add Authorization header if token exists
        if (this.token) {
            (headers as Record<string, string>)["Authorization"] =
                `Bearer ${this.token}`;
        }

        // All API endpoints are prefixed with /api
        const url = `${this.getBaseUrl()}/api${endpoint}`;
        const method = (fetchOptions.method || "GET").toUpperCase();
        const isIdempotentMethod = method === "GET" || method === "HEAD";
        const isRetryAttempt = _retryCount > 0 || _timeoutRetryCount > 0;
        const inFlightGetKey =
            method === "GET" && !isRetryAttempt
                ? this.buildInFlightGetKey(
                      endpoint,
                      timeoutMs,
                      Boolean(fetchOptions.signal),
                  )
                : null;

        if (inFlightGetKey) {
            const existingRequest =
                this.inFlightGetRequests.get(inFlightGetKey);
            if (existingRequest) {
                return existingRequest as Promise<T>;
            }
        }

        const performRequest = async (): Promise<T> => {
            let response: Response;
            try {
                response = await this.fetchWithTimeout(
                    url,
                    {
                        ...fetchOptions,
                        headers,
                        credentials: "include", // Still send cookies for backward compatibility
                    },
                    timeoutMs,
                );
            } catch (error) {
                if (
                    this.isTimeoutError(error) &&
                    isIdempotentMethod &&
                    _timeoutRetryCount < MAX_TIMEOUT_RETRIES
                ) {
                    await this.delay(DEFAULT_TIMEOUT_RETRY_BACKOFF_MS);
                    return this.request<T>(endpoint, {
                        ...options,
                        _timeoutRetryCount: _timeoutRetryCount + 1,
                    });
                }
                throw error;
            }

            if (!response.ok) {
                const error = await response.json().catch(() => ({
                    error: response.statusText,
                }));

                // Only log non-404 errors (404s are often expected)
                if (!(silent404 && response.status === 404)) {
                    sharedFrontendLogger.error(
                        `[API] Request failed: ${url}`,
                        error,
                    );
                }

                const isAuthRequired =
                    response.status === 401 && error.code === "AUTH_REQUIRED";

                // Handle marked session-auth failures with token refresh (retry once)
                if (
                    isAuthRequired &&
                    _retryCount === 0 &&
                    endpoint !== "/auth/refresh"
                ) {
                    const refreshed = await this.refreshAccessToken();

                    if (refreshed) {
                        // Retry the request with new token
                        return this.request<T>(endpoint, {
                            ...options,
                            _retryCount: 1, // Prevent infinite loops
                        });
                    }
                }

                if (
                    isAuthRequired ||
                    (response.status === 401 && endpoint === "/auth/refresh")
                ) {
                    // Token is invalid and refresh failed — clear stale credentials
                    // and notify the app so the auth context can redirect to login.
                    this.clearToken();
                    if (typeof window !== "undefined") {
                        window.dispatchEvent(new Event("auth:session-expired"));
                    }
                    const err = new Error("Not authenticated");
                    (err as ApiError).status = response.status;
                    (err as ApiError).data = error;
                    throw err;
                }

                const err = new Error(error.error || "An error occurred");
                (err as ApiError).status = response.status;
                (err as ApiError).data = error;
                throw err;
            }

            const data = await response.json();
            return data;
        };

        if (!inFlightGetKey) {
            return performRequest();
        }

        const requestPromise = performRequest();
        this.inFlightGetRequests.set(inFlightGetKey, requestPromise);
        void requestPromise
            .finally(() => {
                if (
                    this.inFlightGetRequests.get(inFlightGetKey) ===
                    requestPromise
                ) {
                    this.inFlightGetRequests.delete(inFlightGetKey);
                }
            })
            .catch(() => undefined);
        return requestPromise;
    }

    // Generic POST method for convenience
    async post<T = unknown>(endpoint: string, data?: unknown): Promise<T> {
        return this.request<T>(endpoint, {
            method: "POST",
            body: data ? JSON.stringify(data) : undefined,
        });
    }

    // Generic GET method for convenience
    async get<T = unknown>(endpoint: string): Promise<T> {
        return this.request<T>(endpoint, {
            method: "GET",
        });
    }

    // Generic DELETE method for convenience
    async delete<T = unknown>(endpoint: string): Promise<T> {
        return this.request<T>(endpoint, {
            method: "DELETE",
        });
    }

    // Generic PATCH method for convenience
    async patch<T = unknown>(endpoint: string, data?: unknown): Promise<T> {
        return this.request<T>(endpoint, {
            method: "PATCH",
            body: data ? JSON.stringify(data) : undefined,
        });
    }

    /**
     * Get the current token, lazily loading from localStorage if needed.
     * This handles the case where the singleton was created during SSR
     * and this.token wasn't set from localStorage.
     */
    protected getCurrentToken(): string | null {
        // If we already have a token, use it
        if (this.token) {
            return this.token;
        }
        // Try to load from localStorage if on client
        if (typeof window !== "undefined") {
            const storedToken = localStorage.getItem(AUTH_TOKEN_KEY);
            if (storedToken) {
                this.token = storedToken;
                this.tokenInitialized = true;
                this.scheduleProactiveTokenRefresh(storedToken);
                return storedToken;
            }
        }
        return null;
    }

    protected getPlaybackDeviceId(): string {
        if (typeof window === "undefined") {
            return "server";
        }

        try {
            const existing = localStorage.getItem(PLAYBACK_DEVICE_ID_KEY);
            if (existing) {
                return existing;
            }

            const generated =
                typeof crypto !== "undefined" && crypto.randomUUID
                    ? crypto.randomUUID()
                    : `device-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            localStorage.setItem(PLAYBACK_DEVICE_ID_KEY, generated);
            return generated;
        } catch {
            return "unknown-device";
        }
    }
}
