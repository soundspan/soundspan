const AUTH_TOKEN_KEY = "auth_token";
const REFRESH_TOKEN_KEY = "refresh_token";
const PLAYBACK_DEVICE_ID_KEY = "soundspan_playback_device_id";
const DEFAULT_API_TIMEOUT_MS = 15_000;
const AUTH_REFRESH_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_RETRY_BACKOFF_MS = 350;
const MAX_TIMEOUT_RETRIES = 1;

// Mood Mix Types (Legacy - for old presets endpoint)
export interface MoodPreset {
    id: string;
    name: string;
    color: string;
    params: MoodMixParams;
}

export interface MoodMixParams {
    // Basic audio features
    valence?: { min?: number; max?: number };
    energy?: { min?: number; max?: number };
    danceability?: { min?: number; max?: number };
    acousticness?: { min?: number; max?: number };
    instrumentalness?: { min?: number; max?: number };
    arousal?: { min?: number; max?: number };
    bpm?: { min?: number; max?: number };
    keyScale?: "major" | "minor";
    // ML mood predictions (require Enhanced mode analysis)
    moodHappy?: { min?: number; max?: number };
    moodSad?: { min?: number; max?: number };
    moodRelaxed?: { min?: number; max?: number };
    moodAggressive?: { min?: number; max?: number };
    moodParty?: { min?: number; max?: number };
    moodAcoustic?: { min?: number; max?: number };
    moodElectronic?: { min?: number; max?: number };
    limit?: number;
}

export interface AlbumRelease {
    guid: string;
    title: string;
    indexer: string;
    indexerId: number;
    infoUrl: string | null;
    size: number;
    sizeFormatted: string;
    seeders?: number;
    leechers?: number;
    protocol: string;
    quality: string;
    approved: boolean;
    rejected: boolean;
    rejections: string[];
}

// New Mood Bucket Types (simplified mood system)
export type MoodType =
    | "happy"
    | "sad"
    | "chill"
    | "energetic"
    | "party"
    | "focus"
    | "melancholy"
    | "aggressive"
    | "acoustic";

export interface MoodBucketPreset {
    id: MoodType;
    name: string;
    color: string;
    icon: string;
    trackCount: number;
}

export interface MoodBucketMix {
    id: string;
    mood: MoodType;
    name: string;
    description: string;
    trackIds: string[];
    coverUrls: string[];
    trackCount: number;
    color: string;
    tracks?: ApiData[];
}

export interface SavedMoodMixResponse {
    success: boolean;
    mix: MoodBucketMix & { generatedAt: string };
}

// Vibe (CLAP Similarity) Types
export interface SimilarTrack {
    id: string;
    title: string;
    duration: number;
    trackNo: number;
    distance: number;
    album: {
        id: string;
        title: string;
        coverUrl: string | null;
    };
    artist: {
        id: string;
        name: string;
    };
}

export interface SimilarTracksResponse {
    sourceTrackId: string;
    tracks: SimilarTrack[];
}

export interface VibeSearchResponse {
    query: string;
    tracks: SimilarTrack[];
}

export interface VibeStatusResponse {
    totalTracks: number;
    embeddedTracks: number;
    progress: number;
    isComplete: boolean;
}

export type TrackPreferenceSignal = "thumbs_up" | "thumbs_down" | "clear";

export interface TrackPreferenceResponse {
    trackId: string;
    signal: TrackPreferenceSignal;
    state: "liked" | "disliked" | "neutral";
    score: number;
    likedAt: string | null;
    dislikedAt: string | null;
    updatedAt: string | null;
}

interface ApiError extends Error {
    status?: number;
    data?: Record<string, unknown>;
}

interface ServiceTestResult {
    success?: boolean;
    version?: string;
    error?: string;
}

// API response data type - represents unvalidated JSON from the server.
// Using a single suppression here allows all 100+ API methods to return
// properly loose types without scattering suppressions across the file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiData = any;


function toSearchParams(params: Record<string, string | number | boolean | undefined>): URLSearchParams {
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
            entries[key] = String(value);
        }
    }
    return new URLSearchParams(entries);
}

// Dynamically determine API URL based on configuration
const getApiBaseUrl = () => {
    // Server-side rendering
    if (typeof window === "undefined") {
        return process.env.BACKEND_URL || "http://127.0.0.1:3006";
    }

    // Explicit env var takes precedence
    if (process.env.NEXT_PUBLIC_API_URL) {
        return process.env.NEXT_PUBLIC_API_URL;
    }

    // Docker all-in-one mode: Use relative URLs (Next.js rewrites will proxy)
    // This is detected by checking if we're on the same port as the frontend
    const frontendPort =
        window.location.port ||
        (window.location.protocol === "https:" ? "443" : "80");
    if (
        frontendPort === "3030" ||
        frontendPort === "443" ||
        frontendPort === "80"
    ) {
        // Use relative paths - Next.js rewrites will proxy to backend
        return "";
    }

    // Development mode: Backend on separate port
    const currentHost = window.location.hostname;
    const apiPort = "3006";
    return `${window.location.protocol}//${currentHost}:${apiPort}`;
};

class ApiClient {
    private baseUrl: string;
    private token: string | null = null;
    private tokenInitialized: boolean = false;
    private readonly inFlightGetRequests = new Map<string, Promise<unknown>>();

    constructor(baseUrl?: string) {
        // Don't set baseUrl in constructor - determine it dynamically on each request
        this.baseUrl = baseUrl || "";

        // Try to load token synchronously
        if (typeof window !== "undefined") {
            this.token = localStorage.getItem(AUTH_TOKEN_KEY);
            if (this.token) {
                this.tokenInitialized = true;
            }
            // Note: Refresh token is loaded on-demand via getRefreshToken()
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
        if (typeof window !== "undefined") {
            localStorage.removeItem(AUTH_TOKEN_KEY);
            localStorage.removeItem(REFRESH_TOKEN_KEY);
        }
    }

    // Get the base URL dynamically to support switching between localhost and IP
    private getBaseUrl(): string {
        if (this.baseUrl) {
            return this.baseUrl;
        }
        return getApiBaseUrl();
    }

    private isTimeoutError(error: unknown): boolean {
        return (
            error instanceof Error &&
            (error as ApiError).status === 408
        );
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
    private async refreshAccessToken(): Promise<boolean> {
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
                        AUTH_REFRESH_TIMEOUT_MS
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
            console.error("[API] Token refresh failed:", error);
            this.clearToken();
            return false;
        }
    }

    /**
     * Make an authenticated API request
     * Public method for components that need custom API calls
     */
    private async fetchWithTimeout(
        url: string,
        options: RequestInit,
        timeoutMs: number
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
                    `Request timed out after ${timeoutMs}ms`
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
                upstreamSignal.removeEventListener(
                    "abort",
                    abortFromUpstream
                );
            }
        }
    }

    private buildInFlightGetKey(
        endpoint: string,
        timeoutMs: number,
        hasSignal: boolean
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
        } = {}
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
            (headers as Record<string, string>)[
                "Authorization"
            ] = `Bearer ${this.token}`;
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
                      Boolean(fetchOptions.signal)
                  )
                : null;

        if (inFlightGetKey) {
            const existingRequest = this.inFlightGetRequests.get(inFlightGetKey);
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
                    timeoutMs
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
                    console.error(`[API] Request failed: ${url}`, error);
                }

                // Handle 401 with token refresh (retry once)
                if (
                    response.status === 401 &&
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

                if (response.status === 401) {
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
                if (this.inFlightGetRequests.get(inFlightGetKey) === requestPromise) {
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

    // Auth
    async login(username: string, password: string, token?: string): Promise<{
        id: string;
        username: string;
        role: string;
        requires2FA?: boolean;
        onboardingComplete?: boolean;
    }> {
        const data = await this.request<{
            token?: string;
            refreshToken?: string;
            user?: {
                id: string;
                username: string;
                role: string;
                requires2FA?: boolean;
                onboardingComplete?: boolean;
            };
            id?: string;
            username?: string;
            role?: string;
            requires2FA?: boolean;
            onboardingComplete?: boolean;
        }>("/auth/login", {
            method: "POST",
            body: JSON.stringify({ username, password, token }),
        });

        // If login returned JWT tokens, store them
        if (data.token) {
            this.setToken(data.token, data.refreshToken);
        }

        // Return user data in consistent format
        if (data.user) {
            return data.user;
        }
        return {
            id: data.id || "",
            username: data.username || "",
            role: data.role || "",
            requires2FA: data.requires2FA,
            onboardingComplete: data.onboardingComplete,
        };
    }

    async register(username: string, password: string, email?: string) {
        const data = await this.request<{
            id: string;
            username: string;
            role: string;
        }>("/auth/register", {
            method: "POST",
            body: JSON.stringify({ username, password, email }),
        });
        return data;
    }

    async logout() {
        await this.request<void>("/auth/logout", {
            method: "POST",
        });
        // Clear the stored JWT token
        this.clearToken();
    }

    async getCurrentUser() {
        return this.request<{
            id: string;
            username: string;
            role: string;
            onboardingComplete?: boolean;
            enrichmentSettings?: { enabled: boolean; lastRun?: string };
            createdAt: string;
        }>("/auth/me");
    }

    async getSubsonicPasswordStatus(): Promise<{ hasPassword: boolean }> {
        return this.request<{ hasPassword: boolean }>("/auth/subsonic-password");
    }

    async setSubsonicPassword(password: string): Promise<{ success: boolean }> {
        return this.request<{ success: boolean }>("/auth/subsonic-password", {
            method: "POST",
            body: JSON.stringify({ password }),
        });
    }

    async clearSubsonicPassword(): Promise<{ success: boolean }> {
        return this.request<{ success: boolean }>("/auth/subsonic-password", {
            method: "DELETE",
        });
    }

    // Library
    async getArtists(params?: {
        limit?: number;
        offset?: number;
        filter?: "owned" | "discovery" | "all";
        sortBy?: string;
    }) {
        return this.request<{
            artists: ApiData[];
            total: number;
            offset: number;
            limit: number;
        }>(`/library/artists?${toSearchParams(params as Record<string, string | number | boolean | undefined>).toString()}`);
    }

    async getRecentlyListened(limit = 10) {
        return this.request<{ items: ApiData[] }>(
            `/library/recently-listened?limit=${limit}`
        );
    }

    async getRecentlyAdded(limit = 10) {
        return this.request<{ artists: ApiData[] }>(
            `/library/recently-added?limit=${limit}`
        );
    }

    async scanLibrary() {
        return this.request<{
            message: string;
            jobId: string;
            musicPath: string;
        }>("/library/scan", {
            method: "POST",
        });
    }

    async getScanStatus(jobId: string) {
        return this.request<{
            status: string;
            progress: number;
            result?: ApiData;
        }>(`/library/scan/status/${jobId}`);
    }

    async organizeLibrary() {
        return this.request<{ message: string }>("/library/organize", {
            method: "POST",
        });
    }

    async getArtist(
        id: string,
        options?: {
            includeDiscography?: boolean;
            includeTopTracks?: boolean;
            includeSimilarArtists?: boolean;
        }
    ) {
        const queryString = options
            ? toSearchParams(options).toString()
            : "";
        const suffix = queryString ? `?${queryString}` : "";
        return this.request<ApiData>(`/library/artists/${id}${suffix}`);
    }

    async getAlbums(params?: {
        artistId?: string;
        limit?: number;
        offset?: number;
        filter?: "owned" | "discovery" | "all";
        sortBy?: string;
    }) {
        return this.request<{
            albums: ApiData[];
            total: number;
            offset: number;
            limit: number;
        }>(`/library/albums?${toSearchParams(params as Record<string, string | number | boolean | undefined>).toString()}`);
    }

    async getAlbum(
        id: string,
        options?: {
            includeTracks?: boolean;
        }
    ) {
        const queryString = options
            ? toSearchParams(options).toString()
            : "";
        const suffix = queryString ? `?${queryString}` : "";
        return this.request<ApiData>(`/library/albums/${id}${suffix}`);
    }

    async getTracks(params?: {
        albumId?: string;
        limit?: number;
        offset?: number;
        sortBy?: string;
    }) {
        return this.request<{
            tracks: ApiData[];
            total: number;
            offset: number;
            limit: number;
        }>(`/library/tracks?${toSearchParams(params as Record<string, string | number | boolean | undefined>).toString()}`);
    }

    async getShuffledTracks(limit?: number) {
        const params = limit ? `?limit=${limit}` : "";
        return this.request<{
            tracks: ApiData[];
            total: number;
        }>(`/library/tracks/shuffle${params}`);
    }

    async getLibraryDeletePolicy() {
        return this.request<{
            isAdmin: boolean;
            libraryDeletionEnabled: boolean;
            canDelete: boolean;
        }>("/library/delete-policy");
    }

    async deleteTrack(trackId: string) {
        return this.request<{ message: string }>(`/library/tracks/${trackId}`, {
            method: "DELETE",
        });
    }

    async deleteAlbum(albumId: string) {
        return this.request<{ message: string; deletedFiles?: number }>(
            `/library/albums/${albumId}`,
            {
                method: "DELETE",
            }
        );
    }

    async deleteArtist(artistId: string) {
        return this.request<{ message: string; deletedFiles?: number }>(
            `/library/artists/${artistId}`,
            {
                method: "DELETE",
            }
        );
    }

    async getTrack(id: string) {
        return this.request<ApiData>(`/library/tracks/${id}`);
    }

    async getTrackPreference(trackId: string) {
        return this.request<TrackPreferenceResponse>(
            `/library/tracks/${encodeURIComponent(trackId)}/preference`
        );
    }

    async setTrackPreference(trackId: string, signal: TrackPreferenceSignal) {
        return this.request<TrackPreferenceResponse>(
            `/library/tracks/${encodeURIComponent(trackId)}/preference`,
            {
                method: "POST",
                body: JSON.stringify({ signal }),
            }
        );
    }

    // Lyrics
    async getLyrics(
        trackId: string,
        metadata?: {
            artist?: string;
            title?: string;
            album?: string;
            duration?: number;
        }
    ) {
        const encodedTrackId = encodeURIComponent(trackId);
        const params = new URLSearchParams();

        if (metadata?.artist) params.set("artist", metadata.artist);
        if (metadata?.title) params.set("title", metadata.title);
        if (metadata?.album) params.set("album", metadata.album);
        if (
            typeof metadata?.duration === "number" &&
            Number.isFinite(metadata.duration) &&
            metadata.duration > 0
        ) {
            params.set("duration", String(Math.round(metadata.duration)));
        }

        const query = params.toString();
        return this.request<{
            syncedLyrics: string | null;
            plainLyrics: string | null;
            source: string;
            synced: boolean;
        }>(`/lyrics/${encodedTrackId}${query ? `?${query}` : ""}`);
    }

    async clearLyricsCache(trackId: string) {
        return this.request<{ message: string }>(
            `/lyrics/${encodeURIComponent(trackId)}`,
            {
                method: "DELETE",
            }
        );
    }

    async getRadioTracks(type: string, value?: string, limit = 50) {
        const params = new URLSearchParams({ type, limit: String(limit) });
        if (value) params.append("value", value);
        return this.request<{ tracks: ApiData[] }>(
            `/library/radio?${params.toString()}`
        );
    }

    // Streaming
    getStreamUrl(trackId: string): string {
        const baseUrl = `${this.getBaseUrl()}/api/library/tracks/${trackId}/stream`;
        // For audio element requests, cookies may not be sent cross-origin in development
        // Add token as query param for authentication (supported by requireAuthOrToken)
        const token = this.getCurrentToken();
        if (token) {
            return `${baseUrl}?token=${encodeURIComponent(token)}`;
        }
        return baseUrl;
    }

    /**
     * Get the current token, lazily loading from localStorage if needed.
     * This handles the case where the singleton was created during SSR
     * and this.token wasn't set from localStorage.
     */
    private getCurrentToken(): string | null {
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
                return storedToken;
            }
        }
        return null;
    }

    private getPlaybackDeviceId(): string {
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

    /**
     * Get the URL for cover art.
     * @param coverId - The cover ID, URL, or path
     * @param size - Optional size in pixels
     * @param includeToken - Include auth token in URL (needed for canvas color extraction)
     */
    getCoverArtUrl(coverId: string, size?: number, includeToken = true): string {
        const baseUrl = this.getBaseUrl();
        const token = includeToken ? this.getCurrentToken() : null;

        // Check if this is an audiobook cover path (served by audiobooks endpoint, not proxied)
        if (coverId && coverId.startsWith("/audiobooks/")) {
            const url = `${baseUrl}/api${coverId}`;
            if (token) {
                return `${url}?token=${encodeURIComponent(token)}`;
            }
            return url;
        }

        // Check if this is a podcast cover path (served by podcasts endpoint, not proxied)
        if (coverId && coverId.startsWith("/podcasts/")) {
            const url = `${baseUrl}/api${coverId}`;
            if (token) {
                return `${url}?token=${encodeURIComponent(token)}`;
            }
            return url;
        }

        // Check if coverId is an external URL (needs to be proxied)
        // Also handle native: paths which need URL encoding
        if (
            coverId &&
            (coverId.startsWith("http://") ||
                coverId.startsWith("https://") ||
                coverId.startsWith("native:"))
        ) {
            // Pass as query parameter to avoid URL encoding issues
            const params = new URLSearchParams({ url: coverId });
            if (size) params.append("size", size.toString());
            if (token) params.append("token", token);
            return `${baseUrl}/api/library/cover-art?${params.toString()}`;
        }

        // Otherwise use as path parameter (cover ID - typically a hash)
        const params = new URLSearchParams();
        if (size) params.append("size", size.toString());
        if (token) params.append("token", token);
        const queryString = params.toString();
        return `${baseUrl}/api/library/cover-art/${encodeURIComponent(coverId)}${
            queryString ? "?" + queryString : ""
        }`;
    }

    // Recommendations
    async getRecommendationsForYou(limit = 10) {
        return this.request<{ artists: ApiData[] }>(
            `/recommendations/for-you?limit=${limit}`
        );
    }

    async getSimilarArtists(seedArtistId: string, limit = 20) {
        return this.request<{ recommendations: ApiData[] }>(
            `/recommendations?seedArtistId=${seedArtistId}&limit=${limit}`
        );
    }

    async getSimilarAlbums(seedAlbumId: string, limit = 20) {
        return this.request<{ recommendations: ApiData[] }>(
            `/recommendations/albums?seedAlbumId=${seedAlbumId}&limit=${limit}`
        );
    }

    async getSimilarTracks(seedTrackId: string, limit = 20) {
        return this.request<{ recommendations: ApiData[] }>(
            `/recommendations/tracks?seedTrackId=${seedTrackId}&limit=${limit}`
        );
    }

    // Playlists
    async getPlaylists() {
        return this.request<ApiData[]>("/playlists");
    }

    async getPlaylist(id: string) {
        return this.request<ApiData>(`/playlists/${id}`);
    }

    async createPlaylist(name: string, isPublic = false) {
        return this.request<ApiData>("/playlists", {
            method: "POST",
            body: JSON.stringify({ name, isPublic }),
        });
    }

    async updatePlaylist(
        id: string,
        data: { name?: string; isPublic?: boolean }
    ) {
        return this.request<ApiData>(`/playlists/${id}`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async deletePlaylist(id: string) {
        return this.request<void>(`/playlists/${id}`, {
            method: "DELETE",
        });
    }

    async addTrackToPlaylist(playlistId: string, trackId: string) {
        return this.request<ApiData>(`/playlists/${playlistId}/items`, {
            method: "POST",
            body: JSON.stringify({ trackId }),
        });
    }

    async removeTrackFromPlaylist(playlistId: string, trackId: string) {
        return this.request<void>(`/playlists/${playlistId}/items/${trackId}`, {
            method: "DELETE",
        });
    }

    async hidePlaylist(playlistId: string) {
        return this.request<{ message: string; isHidden: boolean }>(
            `/playlists/${playlistId}/hide`,
            { method: "POST" }
        );
    }

    async unhidePlaylist(playlistId: string) {
        return this.request<{ message: string; isHidden: boolean }>(
            `/playlists/${playlistId}/hide`,
            { method: "DELETE" }
        );
    }

    async retryPendingTrack(playlistId: string, pendingTrackId: string) {
        return this.request<{
            success: boolean;
            message: string;
            error?: string;
            filePath?: string;
        }>(`/playlists/${playlistId}/pending/${pendingTrackId}/retry`, {
            method: "POST",
        });
    }

    async removePendingTrack(playlistId: string, pendingTrackId: string) {
        return this.request<{ message: string }>(
            `/playlists/${playlistId}/pending/${pendingTrackId}`,
            { method: "DELETE" }
        );
    }

    async getFreshPreviewUrl(playlistId: string, pendingTrackId: string) {
        return this.request<{ previewUrl: string }>(
            `/playlists/${playlistId}/pending/${pendingTrackId}/preview`
        );
    }

    // Playback tracking
    async trackPlayback(trackId: string, progress?: number) {
        return this.request<void>("/playback/track", {
            method: "POST",
            body: JSON.stringify({ trackId, progress }),
        });
    }

    // Play tracking
    async logPlay(trackId: string) {
        return this.request<ApiData>("/plays", {
            method: "POST",
            body: JSON.stringify({ trackId }),
        });
    }

    async getRecentPlays(limit = 50) {
        return this.request<ApiData[]>(`/plays?limit=${limit}`);
    }

    async getPlayHistorySummary() {
        return this.request<{
            allTime: number;
            last7Days: number;
            last30Days: number;
            last365Days: number;
        }>("/plays/summary");
    }

    async clearPlayHistory(range: "7d" | "30d" | "365d" | "all") {
        return this.request<{
            success: boolean;
            range: "7d" | "30d" | "365d" | "all";
            deletedCount: number;
        }>(`/plays/history?range=${range}`, {
            method: "DELETE",
        });
    }

    // Settings
    async getSettings() {
        return this.request<ApiData>("/settings");
    }

    async updateSettings(settings: ApiData) {
        return this.request<ApiData>("/settings", {
            method: "POST",
            body: JSON.stringify(settings),
        });
    }

    // System Features
    async getFeatures(): Promise<{ musicCNN: boolean; vibeEmbeddings: boolean }> {
        return this.request<{ musicCNN: boolean; vibeEmbeddings: boolean }>(
            "/system/features"
        );
    }

    // System Settings
    async getSystemSettings() {
        return this.request<ApiData>("/system-settings");
    }

    async updateSystemSettings(settings: ApiData) {
        return this.request<ApiData>("/system-settings", {
            method: "POST",
            body: JSON.stringify(settings),
        });
    }

    async clearAllCaches() {
        return this.request<ApiData>("/system-settings/clear-caches", {
            method: "POST",
        });
    }

    async cleanupStaleJobs() {
        return this.request<{
            success: boolean;
            cleaned: {
                discoveryBatches: { cleaned: number; ids: string[] };
                downloadJobs: { cleaned: number; ids: string[] };
                spotifyImportJobs: { cleaned: number; ids: string[] };
                bullQueues: { cleaned: number; queues: string[] };
            };
            totalCleaned: number;
        }>("/settings/cleanup-stale-jobs", {
            method: "POST",
        });
    }

    // System Settings Tests
    async testLidarr(url: string, apiKey: string) {
        return this.request<ServiceTestResult>("/system-settings/test-lidarr", {
            method: "POST",
            body: JSON.stringify({ url, apiKey }),
        });
    }

    async testNzbget(url: string, username: string, password: string) {
        return this.request<ServiceTestResult>("/system-settings/test-nzbget", {
            method: "POST",
            body: JSON.stringify({ url, username, password }),
        });
    }

    async testQbittorrent(url: string, username: string, password: string) {
        return this.request<ServiceTestResult>("/system-settings/test-qbittorrent", {
            method: "POST",
            body: JSON.stringify({ url, username, password }),
        });
    }

    async testLastfm(apiKey: string) {
        return this.request<ServiceTestResult>("/system-settings/test-lastfm", {
            method: "POST",
            body: JSON.stringify({ lastfmApiKey: apiKey }),
        });
    }

    async testOpenai(apiKey: string, model: string) {
        return this.request<ServiceTestResult>("/system-settings/test-openai", {
            method: "POST",
            body: JSON.stringify({ apiKey, model }),
        });
    }

    async testFanart(apiKey: string) {
        return this.request<ServiceTestResult>("/system-settings/test-fanart", {
            method: "POST",
            body: JSON.stringify({ fanartApiKey: apiKey }),
        });
    }

    async testAudiobookshelf(url: string, apiKey: string) {
        return this.request<ServiceTestResult>("/system-settings/test-audiobookshelf", {
            method: "POST",
            body: JSON.stringify({ url, apiKey }),
        });
    }

    async testSoulseek(username: string, password: string) {
        return this.request<ServiceTestResult>("/system-settings/test-soulseek", {
            method: "POST",
            body: JSON.stringify({ username, password }),
        });
    }

    async testSpotify(clientId: string, clientSecret: string) {
        return this.request<ServiceTestResult>("/system-settings/test-spotify", {
            method: "POST",
            body: JSON.stringify({ clientId, clientSecret }),
        });
    }

    async testTidal() {
        return this.request<ServiceTestResult>("/system-settings/test-tidal", {
            method: "POST",
        });
    }

    async tidalDeviceAuth() {
        return this.request<{
            device_code: string;
            user_code: string;
            verification_uri: string;
            verification_uri_complete: string;
            expires_in: number;
            interval: number;
        }>("/system-settings/tidal-auth/device", {
            method: "POST",
        });
    }

    async tidalPollAuth(deviceCode: string) {
        return this.request<{
            status?: "pending";
            success?: boolean;
            user_id?: string;
            country_code?: string;
            username?: string;
        }>("/system-settings/tidal-auth/token", {
            method: "POST",
            body: JSON.stringify({ device_code: deviceCode }),
        });
    }

    async testListenNotes(apiKey: string) {
        return this.request<ServiceTestResult>("/system-settings/test-listennotes", {
            method: "POST",
            body: JSON.stringify({ apiKey }),
        });
    }

    // Downloads (Lidarr)
    async downloadAlbum(
        artistName: string,
        albumTitle: string,
        rgMbid?: string,
        downloadType: "library" | "discovery" = "library"
    ) {
        return this.request<ApiData>("/downloads", {
            method: "POST",
            body: JSON.stringify({
                type: "album",
                subject: `${artistName} - ${albumTitle}`,
                mbid: rgMbid,
                artistName,
                albumTitle,
                downloadType,
            }),
        });
    }

    async downloadArtist(
        artistName: string,
        mbid: string,
        downloadType: "library" | "discovery" = "library"
    ) {
        return this.request<ApiData>("/downloads", {
            method: "POST",
            body: JSON.stringify({
                type: "artist",
                subject: artistName,
                mbid,
                downloadType,
            }),
        });
    }

    async getDownloadStatus(id: string) {
        return this.request<ApiData>(`/downloads/${id}`);
    }

    async getDownloads(limit?: number, includeDiscovery: boolean = false) {
        const params = new URLSearchParams();
        if (limit) params.set("limit", String(limit));
        params.set("includeDiscovery", String(includeDiscovery));
        const query = params.toString() ? `?${params.toString()}` : "";
        return this.request<ApiData[]>(`/downloads${query}`);
    }

    async getDownloadAvailability() {
        return this.request<{
            enabled: boolean;
            lidarr: boolean;
            soulseek: boolean;
            tidal: boolean;
        }>("/downloads/availability");
    }

    async deleteDownload(id: string) {
        return this.request<{ success: boolean }>(`/downloads/${id}`, {
            method: "DELETE",
        });
    }

    async getAlbumReleases(
        albumMbid: string,
        artistName: string,
        albumTitle: string
    ): Promise<{
        albumMbid: string;
        lidarrAlbumId: number;
        releases: AlbumRelease[];
        total: number;
    }> {
        const params = new URLSearchParams({ artistName, albumTitle });
        return this.request(
            `/downloads/releases/${albumMbid}?${params.toString()}`
        );
    }

    async grabRelease(options: {
        guid: string;
        indexerId: number;
        albumMbid: string;
        lidarrAlbumId: number;
        artistName: string;
        albumTitle: string;
        title: string;
    }): Promise<{
        success: boolean;
        jobId: string;
        message: string;
        duplicate?: boolean;
    }> {
        return this.request("/downloads/grab", {
            method: "POST",
            body: JSON.stringify(options),
        });
    }

    // Discover Weekly
    async generateDiscoverWeekly() {
        return this.request<{ message: string; jobId: string }>(
            "/discover/generate",
            {
                method: "POST",
            }
        );
    }

    async getDiscoverGenerationStatus(jobId: string) {
        return this.request<{
            status: string;
            progress: number;
            result?: {
                success: boolean;
                playlistName: string;
                songCount: number;
                error?: string;
            };
        }>(`/discover/generate/status/${jobId}`);
    }

    async getCurrentDiscoverWeekly() {
        return this.request<{
            weekStart: string;
            weekEnd: string;
            tracks: ApiData[];
            unavailable: ApiData[];
            totalCount: number;
            unavailableCount: number;
        }>("/discover/current");
    }

    async getDiscoverBatchStatus() {
        return this.request<{
            active: boolean;
            status: "downloading" | "scanning" | "generating" | null;
            batchId?: string;
            progress?: number;
            completed?: number;
            failed?: number;
            total?: number;
        }>("/discover/batch-status");
    }

    async likeDiscoverAlbum(albumId: string) {
        return this.request<{ success: boolean }>("/discover/like", {
            method: "POST",
            body: JSON.stringify({ albumId }),
        });
    }

    async unlikeDiscoverAlbum(albumId: string) {
        return this.request<{ success: boolean }>("/discover/unlike", {
            method: "DELETE",
            body: JSON.stringify({ albumId }),
        });
    }

    async getDiscoverConfig() {
        return this.request<{
            id: string;
            userId: string;
            playlistSize: number;
            enabled: boolean;
            lastGeneratedAt: string | null;
        }>("/discover/config");
    }

    async updateDiscoverConfig(config: {
        playlistSize?: number;
        enabled?: boolean;
    }) {
        return this.request<{
            id: string;
            userId: string;
            playlistSize: number;
            enabled: boolean;
            lastGeneratedAt: string | null;
        }>("/discover/config", {
            method: "PATCH",
            body: JSON.stringify(config),
        });
    }

    async clearDiscoverPlaylist() {
        return this.request<{
            success: boolean;
            message: string;
            likedMoved: number;
            activeDeleted: number;
        }>("/discover/clear", {
            method: "DELETE",
        });
    }

    // Discovery Exclusions
    async getDiscoverExclusions() {
        return this.request<{
            exclusions: Array<{
                id: string;
                albumMbid: string;
                artistName: string;
                albumTitle: string;
                lastSuggestedAt: string;
                expiresAt: string;
            }>;
            count: number;
        }>("/discover/exclusions");
    }

    async clearDiscoverExclusions() {
        return this.request<{
            success: boolean;
            message: string;
            clearedCount: number;
        }>("/discover/exclusions", {
            method: "DELETE",
        });
    }

    async removeDiscoverExclusion(id: string) {
        return this.request<{
            success: boolean;
            message: string;
        }>(`/discover/exclusions/${id}`, {
            method: "DELETE",
        });
    }

    // Artists (Discovery)
    async getArtistDiscovery(
        nameOrMbid: string,
        options?: {
            includeDiscography?: boolean;
            includeTopTracks?: boolean;
            includeSimilarArtists?: boolean;
        }
    ) {
        const queryString = options
            ? toSearchParams(options).toString()
            : "";
        const suffix = queryString ? `?${queryString}` : "";
        return this.request<ApiData>(
            `/artists/discover/${encodeURIComponent(nameOrMbid)}${suffix}`
        );
    }

    async getAlbumDiscovery(
        rgMbid: string,
        options?: {
            includeTracks?: boolean;
        }
    ) {
        const queryString = options
            ? toSearchParams(options).toString()
            : "";
        const suffix = queryString ? `?${queryString}` : "";
        return this.request<ApiData>(
            `/artists/album/${encodeURIComponent(rgMbid)}${suffix}`
        );
    }

    async getTrackPreview(artistName: string, trackTitle: string) {
        return this.request<{ previewUrl: string }>(
            `/artists/preview/${encodeURIComponent(
                artistName
            )}/${encodeURIComponent(trackTitle)}`
        );
    }

    async testDeezer(apiKey?: string) {
        return this.request<ServiceTestResult>("/system-settings/test-deezer", {
            method: "POST",
            body: JSON.stringify({ apiKey }),
        });
    }

    // Audiobooks
    async getAudiobooks() {
        return this.request<ApiData[]>("/audiobooks");
    }

    async getAudiobook(id: string) {
        return this.request<ApiData>(`/audiobooks/${id}`);
    }

    async getAudiobookSeries(seriesName: string) {
        return this.request<ApiData[]>(
            `/audiobooks/series/${encodeURIComponent(seriesName)}`
        );
    }

    getAudiobookStreamUrl(id: string): string {
        const baseUrl = `${this.getBaseUrl()}/api/audiobooks/${id}/stream`;
        // For audio element requests, cookies may not be sent cross-origin in development
        // Add token as query param for authentication (supported by requireAuthOrToken)
        const token = this.getCurrentToken();
        if (token) {
            return `${baseUrl}?token=${encodeURIComponent(token)}`;
        }
        return baseUrl;
    }

    async updateAudiobookProgress(
        id: string,
        currentTime: number,
        duration: number,
        isFinished: boolean = false
    ) {
        return this.request<ApiData>(`/audiobooks/${id}/progress`, {
            method: "POST",
            body: JSON.stringify({ currentTime, duration, isFinished }),
        });
    }

    async deleteAudiobookProgress(id: string) {
        return this.request<ApiData>(`/audiobooks/${id}/progress`, {
            method: "DELETE",
        });
    }

    async getContinueListening() {
        return this.request<ApiData[]>("/audiobooks/continue-listening");
    }

    async searchAudiobooks(query: string) {
        return this.request<ApiData[]>(
            `/audiobooks/search?q=${encodeURIComponent(query)}`
        );
    }

    // Podcasts
    async getPodcasts() {
        return this.request<ApiData[]>("/podcasts");
    }

    async getPodcast(id: string) {
        return this.request<ApiData>(`/podcasts/${id}`, { silent404: true });
    }

    async previewPodcast(itunesId: string) {
        return this.request<ApiData>(`/podcasts/preview/${itunesId}`);
    }

    async getPodcastEpisode(podcastId: string, episodeId: string) {
        return this.request<ApiData>(
            `/podcasts/${podcastId}/episodes/${episodeId}`
        );
    }

    getPodcastEpisodeStreamUrl(podcastId: string, episodeId: string): string {
        const baseUrl = `${this.getBaseUrl()}/api/podcasts/${podcastId}/episodes/${episodeId}/stream`;
        // For audio element requests, cookies may not be sent cross-origin in development
        // Add token as query param for authentication (supported by requireAuthOrToken)
        const token = this.getCurrentToken();
        if (token) {
            return `${baseUrl}?token=${encodeURIComponent(token)}`;
        }
        return baseUrl;
    }

    /**
     * Check if a podcast episode is cached locally
     * Returns { cached: boolean, downloading: boolean, downloadProgress: number | null }
     */
    async getPodcastEpisodeCacheStatus(
        podcastId: string,
        episodeId: string
    ): Promise<{
        cached: boolean;
        downloading: boolean;
        downloadProgress: number | null;
    }> {
        return this.request<{
            cached: boolean;
            downloading: boolean;
            downloadProgress: number | null;
        }>(`/podcasts/${podcastId}/episodes/${episodeId}/cache-status`);
    }

    async updatePodcastEpisodeProgress(
        podcastId: string,
        episodeId: string,
        currentTime: number,
        duration: number,
        isFinished: boolean = false
    ) {
        return this.request<ApiData>(
            `/podcasts/${podcastId}/episodes/${episodeId}/progress`,
            {
                method: "POST",
                body: JSON.stringify({ currentTime, duration, isFinished }),
            }
        );
    }

    // Alias for compatibility with AudioElement
    async updatePodcastProgress(
        podcastId: string,
        episodeId: string,
        currentTime: number,
        duration: number,
        isFinished: boolean = false
    ) {
        return this.updatePodcastEpisodeProgress(
            podcastId,
            episodeId,
            currentTime,
            duration,
            isFinished
        );
    }

    async deletePodcastEpisodeProgress(podcastId: string, episodeId: string) {
        return this.request<ApiData>(
            `/podcasts/${podcastId}/episodes/${episodeId}/progress`,
            {
                method: "DELETE",
            }
        );
    }

    async getSimilarPodcasts(podcastId: string) {
        return this.request<ApiData[]>(`/podcasts/${podcastId}/similar`);
    }

    async getTopPodcasts(limit = 20, genreId?: number) {
        const params = new URLSearchParams({ limit: limit.toString() });
        if (genreId) params.append("genreId", genreId.toString());
        return this.request<ApiData[]>(
            `/podcasts/discover/top?${params.toString()}`
        );
    }

    async getPodcastsByGenre(genreIds: number[]) {
        return this.request<ApiData>(
            `/podcasts/discover/genres?genres=${genreIds.join(",")}`
        );
    }

    async getPodcastsByGenrePaginated(genreId: number, limit = 20, offset = 0) {
        return this.request<ApiData[]>(
            `/podcasts/discover/genre/${genreId}?limit=${limit}&offset=${offset}`
        );
    }

    async subscribePodcast(feedUrl: string, itunesId?: string) {
        return this.request<{ success: boolean; podcast?: ApiData }>("/podcasts/subscribe", {
            method: "POST",
            body: JSON.stringify({ feedUrl, itunesId }),
        });
    }

    async removePodcast(podcastId: string) {
        return this.request<{ success: boolean; message: string }>(
            `/podcasts/${podcastId}/unsubscribe`,
            {
                method: "DELETE",
            }
        );
    }

    // Playback State (cross-device sync)
    async getPlaybackState() {
        return this.request<ApiData>("/playback-state", {
            headers: {
                "X-Playback-Device-Id": this.getPlaybackDeviceId(),
            },
        });
    }

    async savePlaybackState(state: {
        playbackType: string;
        trackId?: string;
        audiobookId?: string;
        podcastId?: string;
        queue?: ApiData[];
        currentIndex?: number;
        isShuffle?: boolean;
        currentTime?: number;
    }) {
        return this.request<ApiData>("/playback-state", {
            method: "POST",
            headers: {
                "X-Playback-Device-Id": this.getPlaybackDeviceId(),
            },
            body: JSON.stringify(state),
        });
    }

    async clearPlaybackState() {
        return this.request<void>("/playback-state", {
            method: "DELETE",
            headers: {
                "X-Playback-Device-Id": this.getPlaybackDeviceId(),
            },
        });
    }

    // Search
    async search(
        query: string,
        type:
            | "all"
            | "artists"
            | "albums"
            | "tracks"
            | "audiobooks"
            | "podcasts" = "all",
        limit: number = 20,
        signal?: AbortSignal
    ) {
        return this.request<ApiData>(
            `/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`,
            { signal }
        );
    }

    async discoverSearch(
        query: string,
        type: "music" | "podcasts" | "all" = "music",
        limit: number = 20,
        signal?: AbortSignal
    ) {
        return this.request<{
            results: ApiData[];
            aliasInfo: { original: string; canonical: string; mbid?: string } | null;
        }>(
            `/search/discover?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`,
            { signal }
        );
    }

    async discoverSimilarArtists(
        artist: string,
        mbid: string = "",
        limit: number = 6,
        signal?: AbortSignal
    ) {
        return this.request<{ similarArtists: ApiData[] }>(
            `/search/discover/similar?artist=${encodeURIComponent(artist)}&mbid=${encodeURIComponent(mbid)}&limit=${limit}`,
            { signal }
        );
    }

    // Soulseek - P2P Music Search & Download
    async getSlskdStatus() {
        return this.request<{
            enabled: boolean;
            connected: boolean;
            username?: string;
            message?: string;
        }>("/soulseek/status");
    }

    async searchSoulseek(query: string) {
        return this.request<{ searchId: string; message: string }>(
            "/soulseek/search",
            {
                method: "POST",
                body: JSON.stringify({ query }),
            }
        );
    }

    async getSoulseekResults(searchId: string) {
        return this.request<{ results: ApiData[]; count: number }>(
            `/soulseek/search/${searchId}`
        );
    }

    async downloadFromSoulseek(
        username: string,
        filepath: string,
        filename?: string,
        size?: number,
        artist?: string,
        album?: string,
        title?: string
    ) {
        return this.request<{
            success: boolean;
            message: string;
            filename: string;
        }>("/soulseek/download", {
            method: "POST",
            body: JSON.stringify({
                username,
                filepath,
                filename,
                size,
                artist,
                album,
                title,
            }),
        });
    }

    async getSlskdDownloads() {
        return this.request<{ downloads: ApiData[]; count: number }>(
            "/soulseek/downloads"
        );
    }

    // Programmatic Mixes
    async getMixes() {
        return this.request<ApiData[]>("/mixes");
    }

    async getMix(id: string) {
        return this.request<ApiData>(`/mixes/${id}`);
    }

    async refreshMixes() {
        return this.request<{ message: string; mixes: ApiData[] }>(
            "/mixes/refresh",
            {
                method: "POST",
            }
        );
    }

    async saveMixAsPlaylist(mixId: string, customName?: string) {
        return this.request<{ id: string; name: string; trackCount: number }>(
            `/mixes/${mixId}/save`,
            {
                method: "POST",
                body: customName
                    ? JSON.stringify({ name: customName })
                    : undefined,
            }
        );
    }

    // Mood on Demand (Legacy)
    async getMoodPresets() {
        return this.request<MoodPreset[]>("/mixes/mood/presets");
    }

    async generateMoodMix(params: MoodMixParams) {
        return this.request<ApiData>("/mixes/mood", {
            method: "POST",
            body: JSON.stringify(params),
        });
    }

    // New Mood Bucket System (simplified, pre-computed)
    async getMoodBucketPresets() {
        return this.request<MoodBucketPreset[]>("/mixes/mood/buckets/presets");
    }

    async getMoodBucketMix(mood: MoodType) {
        return this.request<MoodBucketMix>(`/mixes/mood/buckets/${mood}`);
    }

    async saveMoodBucketMix(mood: MoodType) {
        return this.request<SavedMoodMixResponse>(
            `/mixes/mood/buckets/${mood}/save`,
            { method: "POST" }
        );
    }

    async backfillMoodBuckets() {
        return this.request<{
            success: boolean;
            processed: number;
            assigned: number;
        }>("/mixes/mood/buckets/backfill", { method: "POST" });
    }

    // Enrichment
    async getEnrichmentSettings() {
        return this.request<ApiData>("/enrichment/settings");
    }

    async updateEnrichmentSettings(settings: ApiData) {
        return this.request<ApiData>("/enrichment/settings", {
            method: "PUT",
            body: JSON.stringify(settings),
        });
    }

    async enrichArtist(artistId: string) {
        return this.request<{
            success: boolean;
            confidence: number;
            data: ApiData;
        }>(`/enrichment/artist/${artistId}`, {
            method: "POST",
        });
    }

    async enrichAlbum(albumId: string) {
        return this.request<{
            success: boolean;
            confidence: number;
            data: ApiData;
        }>(`/enrichment/album/${albumId}`, {
            method: "POST",
        });
    }

    async startLibraryEnrichment() {
        return this.request<{ success: boolean; message: string }>(
            "/enrichment/start",
            {
                method: "POST",
            }
        );
    }

    async syncLibraryEnrichment() {
        return this.request<{
            message: string;
            description: string;
            result: {
                artists: number;
                tracks: number;
                audioQueued: number;
            };
        }>("/enrichment/sync", {
            method: "POST",
        });
    }

    async getEnrichmentProgress() {
        return this.request<{
            artists: {
                total: number;
                completed: number;
                pending: number;
                failed: number;
                progress: number;
            };
            trackTags: {
                total: number;
                enriched: number;
                pending: number;
                progress: number;
            };
            audioAnalysis: {
                total: number;
                completed: number;
                pending: number;
                processing: number;
                failed: number;
                progress: number;
                isBackground: boolean;
            };
            clapEmbeddings: {
                total: number;
                completed: number;
                pending: number;
                processing: number;
                failed: number;
                progress: number;
                isBackground: boolean;
            };
            coreComplete: boolean;
            isFullyComplete: boolean;
        }>("/enrichment/progress");
    }

    async triggerFullEnrichment(options?: {
        forceVibeRebuild?: boolean;
        forceMoodBucketBackfill?: boolean;
    }) {
        return this.request<{
            message: string;
            description: string;
            forceVibeRebuild?: boolean;
            forceMoodBucketBackfill?: boolean;
        }>(
            "/enrichment/full",
            {
                method: "POST",
                body: JSON.stringify({
                    forceVibeRebuild: options?.forceVibeRebuild === true,
                    forceMoodBucketBackfill:
                        options?.forceMoodBucketBackfill === true,
                }),
            }
        );
    }

    async resetArtistsOnly() {
        return this.request<{
            message: string;
            description: string;
            count: number;
        }>("/enrichment/reset-artists", { method: "POST" });
    }

    async resetMoodTagsOnly() {
        return this.request<{
            message: string;
            description: string;
            count: number;
        }>("/enrichment/reset-mood-tags", { method: "POST" });
    }

    async resetAudioAnalysisOnly() {
        return this.request<{
            message: string;
            description: string;
            count: number;
        }>("/enrichment/reset-audio-analysis", { method: "POST" });
    }

    async retryFailedAnalysis() {
        return this.request<{ message: string; reset: number }>("/analysis/retry-failed", {
            method: "POST",
        });
    }

    async updateArtistMetadata(
        artistId: string,
        data: {
            name?: string;
            bio?: string;
            genres?: string[];
            mbid?: string;
            heroUrl?: string;
        }
    ) {
        return this.request<ApiData>(`/enrichment/artists/${artistId}/metadata`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async updateAlbumMetadata(
        albumId: string,
        data: {
            title?: string;
            year?: number;
            genres?: string[];
            rgMbid?: string;
            coverUrl?: string;
        }
    ) {
        return this.request<ApiData>(`/enrichment/albums/${albumId}/metadata`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async updateTrackMetadata(trackId: string, data: ApiData) {
        return this.request<ApiData>(`/enrichment/tracks/${trackId}/metadata`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async resetArtistMetadata(artistId: string) {
        return this.request<{ message: string; artist: ApiData }>(
            `/enrichment/artists/${artistId}/reset`,
            { method: "POST" }
        );
    }

    async resetAlbumMetadata(albumId: string) {
        return this.request<{ message: string; album: ApiData }>(
            `/enrichment/albums/${albumId}/reset`,
            { method: "POST" }
        );
    }

    async resetTrackMetadata(trackId: string) {
        return this.request<{ message: string; track: ApiData }>(
            `/enrichment/tracks/${trackId}/reset`,
            { method: "POST" }
        );
    }

    async searchMusicBrainzArtists(query: string): Promise<{
        artists: Array<{
            mbid: string;
            name: string;
            disambiguation: string | null;
            country: string | null;
            type: string | null;
            score: number;
        }>;
    }> {
        return this.request(
            `/enrichment/search/musicbrainz/artists?q=${encodeURIComponent(query)}`
        );
    }

    async searchMusicBrainzReleaseGroups(
        query: string,
        artistName?: string
    ): Promise<{
        albums: Array<{
            rgMbid: string;
            title: string;
            primaryType: string;
            secondaryTypes: string[];
            firstReleaseDate: string | null;
            artistCredit: string;
            score: number;
        }>;
    }> {
        let url = `/enrichment/search/musicbrainz/release-groups?q=${encodeURIComponent(query)}`;
        if (artistName) {
            url += `&artist=${encodeURIComponent(artistName)}`;
        }
        return this.request(url);
    }

    // Homepage
    async getHomepageGenres(limit = 4) {
        return this.request<ApiData[]>(`/homepage/genres?limit=${limit}`);
    }

    async getHomepageTopPodcasts(limit = 6) {
        return this.request<ApiData[]>(`/homepage/top-podcasts?limit=${limit}`);
    }

    async getPopularArtists(limit = 20) {
        return this.request<{ artists: ApiData[] }>(
            `/discover/popular-artists?limit=${limit}`
        );
    }

    // API Keys Management
    async createApiKey(deviceName: string): Promise<{
        apiKey: string;
        name: string;
        createdAt: string;
        message: string;
    }> {
        return this.post("/api-keys", { deviceName });
    }

    async listApiKeys(): Promise<{
        apiKeys: Array<{
            id: string;
            name: string;
            createdAt: string;
            lastUsed: string | null;
        }>;
    }> {
        return this.get("/api-keys");
    }

    async revokeApiKey(id: string): Promise<{ message: string }> {
        return this.delete(`/api-keys/${id}`);
    }

    async getNotifications(): Promise<
        Array<{
            id: string;
            type: string;
            title: string;
            message: string | null;
            metadata: ApiData | null;
            read: boolean;
            cleared: boolean;
            createdAt: string;
        }>
    > {
        return this.get("/notifications");
    }

    async getUnreadNotificationCount(): Promise<{ count: number }> {
        return this.get("/notifications/unread-count");
    }

    async markNotificationAsRead(id: string): Promise<{ success: boolean }> {
        return this.post(`/notifications/${id}/read`);
    }

    async markAllNotificationsAsRead(): Promise<{ success: boolean }> {
        return this.post("/notifications/read-all");
    }

    async clearNotification(id: string): Promise<{ success: boolean }> {
        return this.post(`/notifications/${id}/clear`);
    }

    async clearAllNotifications(): Promise<{ success: boolean }> {
        return this.post("/notifications/clear-all");
    }

    // Download Activity
    async getActiveDownloads(): Promise<
        Array<{
            id: string;
            subject: string;
            type: string;
            status: string;
            createdAt: string;
            error?: string;
        }>
    > {
        return this.get("/notifications/downloads/active");
    }

    async getDownloadHistory(): Promise<
        Array<{
            id: string;
            subject: string;
            type: string;
            status: string;
            error?: string;
            createdAt: string;
            completedAt?: string;
        }>
    > {
        return this.get("/notifications/downloads/history");
    }

    async clearDownloadFromHistory(id: string): Promise<{ success: boolean }> {
        return this.post(`/notifications/downloads/${id}/clear`);
    }

    async clearAllDownloadHistory(): Promise<{ success: boolean }> {
        return this.post("/notifications/downloads/clear-all");
    }

    // Vibe (CLAP Similarity) API
    async getVibeSimilarTracks(trackId: string, limit = 20) {
        return this.request<{
            sourceTrackId: string;
            tracks: Array<{
                id: string;
                title: string;
                duration: number;
                trackNo: number;
                distance: number;
                album: {
                    id: string;
                    title: string;
                    coverUrl: string | null;
                };
                artist: {
                    id: string;
                    name: string;
                };
            }>;
        }>(`/vibe/similar/${trackId}?limit=${limit}`);
    }

    async vibeSearch(query: string, limit = 20) {
        return this.request<{
            query: string;
            tracks: Array<{
                id: string;
                title: string;
                duration: number;
                trackNo: number;
                distance: number;
                similarity: number;
                album: {
                    id: string;
                    title: string;
                    coverUrl: string | null;
                };
                artist: {
                    id: string;
                    name: string;
                };
            }>;
            minSimilarity: number;
            totalAboveThreshold: number;
            debug?: {
                matchedTerms: string[];
                genreConfidence: number;
                featureWeight: number;
            };
        }>("/vibe/search", {
            method: "POST",
            body: JSON.stringify({ query, limit }),
        });
    }

    async getVibeStatus() {
        return this.request<{
            totalTracks: number;
            embeddedTracks: number;
            progress: number;
            isComplete: boolean;
        }>("/vibe/status");
    }

    async getTrackAnalysis(trackId: string) {
        return this.request<{
            id: string;
            title: string;
            analysisStatus: string;
            analysisError: string | null;
            analyzedAt: string | null;
            analysisVersion: string | null;
            analysisMode: string | null;
            bpm: number | null;
            beatsCount: number | null;
            key: string | null;
            keyScale: string | null;
            keyStrength: number | null;
            energy: number | null;
            loudness: number | null;
            dynamicRange: number | null;
            danceability: number | null;
            valence: number | null;
            arousal: number | null;
            instrumentalness: number | null;
            acousticness: number | null;
            speechiness: number | null;
            // MusiCNN mood predictions
            moodHappy: number | null;
            moodSad: number | null;
            moodRelaxed: number | null;
            moodAggressive: number | null;
            moodParty: number | null;
            moodAcoustic: number | null;
            moodElectronic: number | null;
            moodTags: string[] | null;
            essentiaGenres: string[] | null;
            lastfmTags: string[] | null;
        }>(`/analysis/track/${trackId}`);
    }

    async retryFailedDownload(
        id: string
    ): Promise<{ success: boolean; newJobId?: string }> {
        return this.post(`/notifications/downloads/${id}/retry`);
    }

    // ── YouTube Music ──────────────────────────────────────────────

    async getYtMusicStatus(): Promise<{
        enabled: boolean;
        available: boolean;
        authenticated: boolean;
        credentialsConfigured: boolean;
    }> {
        return this.request(`/ytmusic/status`);
    }

    async initiateYtMusicAuth(): Promise<{
        device_code: string;
        user_code: string;
        verification_url: string;
        expires_in: number;
        interval: number;
    }> {
        return this.post(`/ytmusic/auth/device-code`);
    }

    async pollYtMusicAuth(deviceCode: string): Promise<{
        status: "pending" | "success" | "error";
        error?: string;
    }> {
        return this.post(`/ytmusic/auth/device-code/poll`, { deviceCode });
    }

    async saveYtMusicOAuthToken(oauthJson: string): Promise<{ success: boolean }> {
        return this.post(`/ytmusic/auth/save-token`, { oauthJson });
    }

    async clearYtMusicAuth(): Promise<{ success: boolean }> {
        return this.post(`/ytmusic/auth/clear`);
    }

    async searchYtMusic(
        query: string,
        filter?: "songs" | "albums" | "artists" | "videos"
    ): Promise<{ results: any[]; filter: string | null }> {
        return this.post(`/ytmusic/search`, { query, filter });
    }

    async getYtMusicAlbum(browseId: string): Promise<any> {
        return this.request(`/ytmusic/album/${browseId}`);
    }

    async getYtMusicArtist(channelId: string): Promise<any> {
        return this.request(`/ytmusic/artist/${channelId}`);
    }

    async getYtMusicSong(videoId: string): Promise<any> {
        return this.request(`/ytmusic/song/${videoId}`);
    }

    async matchYtMusicTrack(
        artist: string,
        title: string,
        albumTitle?: string,
        duration?: number,
        isrc?: string
    ): Promise<{
        match: { videoId: string; title: string; duration: number } | null;
    }> {
        return this.post(`/ytmusic/match`, {
            artist,
            title,
            albumTitle,
            duration,
            isrc,
        });
    }

    /**
     * Batch-match multiple tracks against YouTube Music in a single request.
     * Far faster than calling matchYtMusicTrack() N times because the
     * sidecar runs all searches concurrently via asyncio.gather.
     */
    async matchYtMusicBatch(
        tracks: Array<{
            artist: string;
            title: string;
            albumTitle?: string;
            duration?: number;
            isrc?: string;
        }>
    ): Promise<{
        matches: Array<{ videoId: string; title: string; duration: number } | null>;
    }> {
        return this.post(`/ytmusic/match-batch`, { tracks });
    }

    /**
     * Build a stream URL for YouTube Music playback.
     * Like getStreamUrl(), this returns a synchronous URL string
     * that the audio engine can load directly.
     */
    getYtMusicStreamUrl(videoId: string, quality?: string): string {
        let url = `${this.getBaseUrl()}/api/ytmusic/stream/${videoId}`;
        const params = new URLSearchParams();
        if (quality) params.set("quality", quality);
        const token = this.getCurrentToken();
        if (token) params.set("token", token);
        const qs = params.toString();
        if (qs) url += `?${qs}`;
        return url;
    }

    /**
     * Fetch stream metadata (bitrate, codec, etc.) for a YouTube Music
     * video. Used by the player UI to display quality information.
     */
    async getYtMusicStreamInfo(
        videoId: string,
        quality?: string
    ): Promise<{
        videoId: string;
        abr: number;
        acodec: string;
        duration: number;
        content_type: string;
    }> {
        const params = new URLSearchParams();
        if (quality) params.set("quality", quality);
        const qs = params.toString();
        const suffix = qs ? `?${qs}` : "";
        return this.get(`/ytmusic/stream-info/${videoId}${suffix}`);
    }

    // ── TIDAL Streaming ────────────────────────────────────────────

    async getTidalStreamingStatus(): Promise<{
        enabled: boolean;
        available: boolean;
        authenticated: boolean;
        credentialsConfigured: boolean;
    }> {
        return this.request(`/tidal-streaming/status`);
    }

    async initiateTidalAuth(): Promise<{
        device_code: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete: string;
        expires_in: number;
        interval: number;
    }> {
        return this.post(`/tidal-streaming/auth/device-code`);
    }

    async pollTidalAuth(deviceCode: string): Promise<{
        status: "pending" | "success" | "error";
        username?: string;
        country_code?: string;
        error?: string;
    }> {
        return this.post(`/tidal-streaming/auth/device-code/poll`, { deviceCode });
    }

    async clearTidalStreamingAuth(): Promise<{ success: boolean }> {
        return this.post(`/tidal-streaming/auth/clear`);
    }

    async searchTidalStreaming(query: string): Promise<{
        tracks: any[];
        albums: any[];
        artists: any[];
    }> {
        return this.post(`/tidal-streaming/search`, { query });
    }

    async matchTidalTrack(
        artist: string,
        title: string,
        albumTitle?: string,
        duration?: number,
        isrc?: string
    ): Promise<{
        match: { id: number; title: string; artist: string; duration: number; isrc?: string } | null;
    }> {
        return this.post(`/tidal-streaming/match`, {
            artist,
            title,
            albumTitle,
            duration,
            isrc,
        });
    }

    /**
     * Batch-match multiple tracks against TIDAL in a single request.
     * Used for gap-fill on album and artist pages.
     */
    async matchTidalBatch(
        tracks: Array<{
            artist: string;
            title: string;
            albumTitle?: string;
            duration?: number;
            isrc?: string;
        }>
    ): Promise<{
        matches: Array<{ id: number; title: string; artist: string; duration: number; isrc?: string } | null>;
    }> {
        return this.post(`/tidal-streaming/match-batch`, { tracks });
    }

    /**
     * Build a stream URL for TIDAL playback.
     * Returns a synchronous URL string that the audio engine can load.
     */
    getTidalStreamUrl(trackId: number, quality?: string): string {
        let url = `${this.getBaseUrl()}/api/tidal-streaming/stream/${trackId}`;
        const params = new URLSearchParams();
        if (quality) params.set("quality", quality);
        const token = this.getCurrentToken();
        if (token) params.set("token", token);
        const qs = params.toString();
        if (qs) url += `?${qs}`;
        return url;
    }

    /**
     * Fetch stream metadata (quality, codec) for a TIDAL track.
     */
    async getTidalStreamInfo(
        trackId: number,
        quality?: string
    ): Promise<{
        trackId: number;
        quality: string;
        acodec: string;
        content_type: string;
        bit_depth?: number;
        sample_rate?: number;
    }> {
        const params = new URLSearchParams();
        if (quality) params.set("quality", quality);
        const qs = params.toString();
        const suffix = qs ? `?${qs}` : "";
        return this.get(`/tidal-streaming/stream-info/${trackId}${suffix}`);
    }

    // ── Local Track Quality ────────────────────────────────────────

    /**
     * Fetch audio quality metadata for a local (owned) track by probing
     * the file on disk. Used by the player UI to display quality info.
     */
    async getLocalTrackAudioInfo(trackId: string): Promise<{
        codec: string | null;
        bitrate: number | null;
        sampleRate: number | null;
        bitDepth: number | null;
        lossless: boolean | null;
        channels: number | null;
    }> {
        return this.get(`/library/tracks/${trackId}/audio-info`);
    }

    // -----------------------------------------------------------------------
    // Listen Together (cold path — create, join, discover, leave, end)
    // -----------------------------------------------------------------------

    async createListenGroup(options: {
        name?: string;
        visibility?: "public" | "private";
        queueTrackIds?: string[];
        currentTrackId?: string;
        currentTimeMs?: number;
        isPlaying?: boolean;
    } = {}): Promise<ApiData> {
        return this.post("/listen-together", options);
    }

    async joinListenGroup(joinCode: string): Promise<ApiData> {
        return this.post("/listen-together/join", { joinCode });
    }

    async discoverListenGroups(): Promise<ApiData> {
        return this.get("/listen-together/discover");
    }

    async getActiveListenGroupCount(): Promise<{ count: number }> {
        return this.get("/listen-together/active-count");
    }

    async getMyListenGroup(): Promise<ApiData> {
        return this.get("/listen-together/mine");
    }

    async leaveListenGroup(groupId: string): Promise<ApiData> {
        return this.post(`/listen-together/${groupId}/leave`);
    }

    async endListenGroup(groupId: string): Promise<ApiData> {
        return this.post(`/listen-together/${groupId}/end`);
    }
}

// Create a singleton instance without passing baseUrl - it will be determined dynamically
export const api = new ApiClient();
