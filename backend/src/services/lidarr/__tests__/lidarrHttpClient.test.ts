import axios from "axios";
import { config } from "../../../config";
import { logger } from "../../../utils/logger";
import { getSystemSettings } from "../../../utils/systemSettings";
import {
    LidarrHttpClient,
    LidarrHttpError,
    resolveLidarrConnection,
} from "../lidarrHttpClient";

jest.mock("axios");

jest.mock("../../../config", () => ({
    config: { lidarr: undefined },
}));

jest.mock("../../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const API_KEY = "super-secret-key";
const BASE_URL = "https://lidarr.internal.example";
const mockAxiosCreate = axios.create as jest.Mock;
const mockRequest = jest.fn();
const mockSleep = jest.fn<Promise<void>, [number]>(() => Promise.resolve());
const mockGetSystemSettings = getSystemSettings as jest.Mock;

function createClient(
    options: ConstructorParameters<typeof LidarrHttpClient>[1] = {},
): LidarrHttpClient {
    return new LidarrHttpClient(
        { baseUrl: BASE_URL, apiKey: API_KEY },
        {
            maxRetries: 2,
            baseBackoffMs: 1,
            maxBackoffMs: 10,
            sleep: mockSleep,
            ...options,
        },
    );
}

function httpError(status: number, headers: Record<string, unknown> = {}) {
    return { response: { status, headers } };
}

function allLogOutput(): string {
    return JSON.stringify([
        ...(logger.debug as jest.Mock).mock.calls,
        ...(logger.warn as jest.Mock).mock.calls,
        ...(logger.error as jest.Mock).mock.calls,
    ]);
}

function enumerableGraph(value: unknown): string {
    const pending: unknown[] = [value];
    const seen = new WeakSet<object>();
    const entries: unknown[] = [];
    for (let index = 0; index < 100 && pending.length > 0; index += 1) {
        const current = pending.shift();
        if (
            typeof current !== "object" ||
            current === null ||
            seen.has(current)
        ) {
            entries.push(current);
            continue;
        }
        seen.add(current);
        const currentEntries = Object.entries(current);
        entries.push(...currentEntries);
        pending.push(...currentEntries.map(([, entry]) => entry));
    }
    return JSON.stringify(entries);
}

async function flushPromises(): Promise<void> {
    for (let turn = 0; turn < 10; turn += 1) {
        await Promise.resolve();
    }
}

describe("LidarrHttpClient", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRequest.mockReset();
        mockAxiosCreate.mockReturnValue({ request: mockRequest });
        Object.assign(config, { lidarr: undefined });
    });

    it("returns response data through one configured axios instance", async () => {
        mockRequest.mockResolvedValueOnce({
            data: { records: [1] },
            status: 200,
        });
        const client = createClient();

        await expect(
            client.get<{ records: number[] }>("/api/v1/queue"),
        ).resolves.toEqual({ data: { records: [1] }, status: 200 });

        expect(mockAxiosCreate).toHaveBeenCalledTimes(1);
        expect(mockAxiosCreate).toHaveBeenCalledWith({
            baseURL: BASE_URL,
            timeout: 15_000,
            headers: { "X-Api-Key": API_KEY },
        });
        expect(mockRequest).toHaveBeenCalledWith({
            method: "GET",
            url: "/api/v1/queue",
            params: undefined,
            data: undefined,
            signal: undefined,
            responseType: undefined,
            maxContentLength: undefined,
            maxBodyLength: undefined,
        });
        expect(allLogOutput()).not.toContain(API_KEY);
        expect(allLogOutput()).not.toContain("lidarr.internal.example");
    });

    it("keeps raw DELETE parameters compatible with discovery lifecycle callers", async () => {
        mockRequest.mockResolvedValueOnce({ data: undefined, status: 200 });

        await expect(
            createClient().delete("/api/v1/album/42", { deleteFiles: true }),
        ).resolves.toEqual({ data: undefined, status: 200 });
        expect(mockRequest).toHaveBeenCalledWith(
            expect.objectContaining({
                method: "DELETE",
                url: "/api/v1/album/42",
                params: { deleteFiles: true },
            }),
        );
    });

    it("threads per-request timeout overrides through every HTTP method", async () => {
        mockRequest.mockResolvedValue({ data: undefined, status: 200 });
        const client = createClient();

        await client.get("/api/v1/get", { timeoutMs: 60_000 });
        await client.post("/api/v1/post", {}, { timeoutMs: 50_000 });
        await client.put("/api/v1/put", {}, { timeoutMs: 40_000 });
        await client.delete("/api/v1/delete", { timeoutMs: 10_000 });

        expect(
            mockRequest.mock.calls.map(([request]) => request.timeout),
        ).toEqual([60_000, 50_000, 40_000, 10_000]);
    });

    it("threads caller cancellation through Axios without retrying aborts", async () => {
        const controller = new AbortController();
        mockRequest.mockRejectedValueOnce({ code: "ERR_CANCELED" });

        await expect(
            createClient().get("/api/v1/album", undefined, controller.signal),
        ).rejects.toMatchObject({ attempts: 1, isTransient: false });
        expect(mockRequest).toHaveBeenCalledWith(
            expect.objectContaining({ signal: controller.signal }),
        );
        expect(mockSleep).not.toHaveBeenCalled();
    });

    it("aborts during retry backoff without starting another attempt", async () => {
        const controller = new AbortController();
        let releaseBackoff!: () => void;
        const sleep = jest.fn(
            () =>
                new Promise<void>((resolve) => {
                    releaseBackoff = resolve;
                }),
        );
        mockRequest.mockRejectedValueOnce(httpError(503));
        const request = createClient({ sleep }).get("/api/v1/queue", {
            signal: controller.signal,
        });
        let settled = false;
        void request.catch(() => {
            settled = true;
        });

        await flushPromises();
        expect(sleep).toHaveBeenCalledTimes(1);
        controller.abort(new Error("cleanup deadline exceeded"));
        await flushPromises();

        expect(settled).toBe(true);
        expect(mockRequest).toHaveBeenCalledTimes(1);
        releaseBackoff();
        await expect(request).rejects.toEqual(
            expect.objectContaining({
                message:
                    "Lidarr GET /api/v1/queue canceled during retry backoff after 1 attempt(s)",
                attempts: 1,
                isTransient: false,
            }),
        );
        await request.catch((error: unknown) => {
            expect(error).toBeInstanceOf(LidarrHttpError);
        });
        expect(mockRequest).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(
            "Lidarr HTTP request canceled during retry backoff",
            {
                method: "GET",
                path: "/api/v1/queue",
                attempt: 1,
                isTransient: false,
            },
        );
    });

    it("clears the default retry timer when backoff is aborted", async () => {
        jest.useFakeTimers();
        try {
            const controller = new AbortController();
            mockRequest.mockRejectedValueOnce(httpError(503));
            const request = createClient({ sleep: undefined }).get(
                "/api/v1/queue",
                { signal: controller.signal },
            );

            await flushPromises();
            expect(jest.getTimerCount()).toBe(1);
            controller.abort();
            await expect(request).rejects.toBeInstanceOf(LidarrHttpError);

            expect(jest.getTimerCount()).toBe(0);
            expect(mockRequest).toHaveBeenCalledTimes(1);
        } finally {
            jest.useRealTimers();
        }
    });

    it("honors a per-call zero-retry override", async () => {
        mockRequest.mockRejectedValue(httpError(503));

        await expect(
            createClient().get("/api/v1/release", { maxRetries: 0 }),
        ).rejects.toMatchObject({ attempts: 1, status: 503 });
        expect(mockRequest).toHaveBeenCalledTimes(1);
        expect(mockSleep).not.toHaveBeenCalled();
    });

    it("retries a transient GET failure and returns the second result", async () => {
        mockRequest
            .mockRejectedValueOnce(httpError(503))
            .mockResolvedValueOnce({ data: { ok: true }, status: 200 });

        await expect(
            createClient().get<{ ok: boolean }>("/api/v1/system/status"),
        ).resolves.toEqual({ data: { ok: true }, status: 200 });
        expect(mockRequest).toHaveBeenCalledTimes(2);
        expect(mockSleep).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledTimes(1);
        expect(logger.error).not.toHaveBeenCalled();
    });

    it("throws a safe typed error after retry exhaustion", async () => {
        mockRequest.mockRejectedValue(httpError(503));

        const promise = createClient().get("/api/v1/queue");
        await expect(promise).rejects.toMatchObject({
            name: "LidarrHttpError",
            isTransient: true,
            attempts: 3,
            status: 503,
            method: "GET",
            path: "/api/v1/queue",
        });
        await promise.catch((error: unknown) => {
            expect(error).toBeInstanceOf(LidarrHttpError);
            expect((error as Error).message).not.toContain(API_KEY);
            expect((error as Error).message).not.toContain(
                "lidarr.internal.example",
            );
        });
        expect(mockRequest).toHaveBeenCalledTimes(3);
        expect(logger.warn).toHaveBeenCalledTimes(2);
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it("preserves the Axios message and parsed Lidarr error body", async () => {
        const responseData = [{ errorMessage: "artist already exists" }];
        mockRequest.mockRejectedValueOnce(
            Object.assign(new Error("Request failed with status code 400"), {
                response: { status: 400, data: responseData },
            }),
        );

        await expect(
            createClient().post("/api/v1/artist", {}),
        ).rejects.toMatchObject({
            message: "Request failed with status code 400",
            response: { status: 400, data: responseData },
        });
    });

    it("does not retain API keys from enumerable Axios failure state", async () => {
        const axiosError = Object.assign(new Error("request failed"), {
            code: "ERR_BAD_RESPONSE",
            response: { status: 500, data: [{ errorMessage: "unavailable" }] },
            config: { headers: { "X-Api-Key": API_KEY } },
        });
        mockRequest.mockRejectedValue(axiosError);

        const error = await createClient({ maxRetries: 0 })
            .get("/api/v1/queue")
            .catch((failure: unknown) => failure);

        expect(error).toBeInstanceOf(LidarrHttpError);
        expect(JSON.stringify(error)).not.toContain(API_KEY);
        expect(enumerableGraph(error)).not.toContain(API_KEY);
    });

    it("does not retry a non-transient status", async () => {
        mockRequest.mockRejectedValue(httpError(404));

        await expect(
            createClient().get("/api/v1/artist/1"),
        ).rejects.toMatchObject({
            isTransient: false,
            attempts: 1,
            status: 404,
        });
        expect(mockRequest).toHaveBeenCalledTimes(1);
        expect(mockSleep).not.toHaveBeenCalled();
    });

    it("reports 404 after a lost-response DELETE retry as two attempts", async () => {
        mockRequest
            .mockRejectedValueOnce({ code: "ECONNRESET" })
            .mockRejectedValueOnce(httpError(404));

        await expect(
            createClient({ maxRetries: 1 }).delete("/api/v1/queue/12"),
        ).rejects.toMatchObject({ status: 404, attempts: 2 });
        expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it("does not retry POST unless explicitly overridden", async () => {
        mockRequest.mockRejectedValue(httpError(503));
        const client = createClient({ maxRetries: 1 });

        await expect(
            client.post("/api/v1/command", { name: "scan" }),
        ).rejects.toMatchObject({ attempts: 1, isTransient: true });
        expect(mockRequest).toHaveBeenCalledTimes(1);

        mockRequest.mockClear();
        await expect(
            client.request({
                method: "POST",
                path: "/api/v1/command",
                data: { name: "scan" },
                retryable: true,
            }),
        ).rejects.toMatchObject({ attempts: 2, isTransient: true });
        expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it("retries no-response timeouts and reports no status on exhaustion", async () => {
        mockRequest.mockRejectedValue({ code: "ECONNABORTED" });

        await expect(
            createClient({ maxRetries: 1 }).get("/api/v1/queue"),
        ).rejects.toMatchObject({
            isTransient: true,
            attempts: 2,
            status: undefined,
        });
        expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it("caps numeric Retry-After seconds at maxBackoffMs", async () => {
        mockRequest
            .mockRejectedValueOnce(httpError(429, { "retry-after": "60" }))
            .mockResolvedValueOnce({ data: "ok", status: 200 });

        await expect(
            createClient({ maxBackoffMs: 25 }).get("/api/v1/queue"),
        ).resolves.toEqual({ data: "ok", status: 200 });
        expect(mockSleep).toHaveBeenCalledWith(25);
    });

    it("limits five queued requests to two in flight", async () => {
        let inFlight = 0;
        let maximumInFlight = 0;
        const releases: Array<() => void> = [];
        mockRequest.mockImplementation(
            () =>
                new Promise((resolve) => {
                    inFlight += 1;
                    maximumInFlight = Math.max(maximumInFlight, inFlight);
                    releases.push(() => {
                        inFlight -= 1;
                        resolve({ data: "done", status: 200 });
                    });
                }),
        );
        const client = createClient({ concurrency: 2 });
        const requests = Array.from({ length: 5 }, (_, index) =>
            client.get<string>(`/api/v1/item/${index}`),
        );

        await flushPromises();
        expect(inFlight).toBe(2);
        releases.splice(0, 2).forEach((release) => release());
        await flushPromises();
        expect(inFlight).toBe(2);
        releases.splice(0, 2).forEach((release) => release());
        await flushPromises();
        expect(inFlight).toBe(1);
        releases.splice(0).forEach((release) => release());

        await expect(Promise.all(requests)).resolves.toEqual(
            Array(5).fill({ data: "done", status: 200 }),
        );
        expect(maximumInFlight).toBe(2);
    });

    it("releases its concurrency slot while a retry waits for backoff", async () => {
        let releaseBackoff: (() => void) | undefined;
        const sleep = jest.fn(
            () =>
                new Promise<void>((resolve) => {
                    releaseBackoff = resolve;
                }),
        );
        mockRequest.mockImplementation(({ url }: { url: string }) => {
            const retryAttempts = mockRequest.mock.calls.filter(
                ([request]) => request.url === "/api/v1/retry",
            ).length;
            if (url === "/api/v1/retry" && retryAttempts === 1) {
                return Promise.reject(httpError(503));
            }
            return Promise.resolve({ data: url, status: 200 });
        });
        const client = createClient({ concurrency: 1, maxRetries: 1, sleep });

        const retrying = client.get("/api/v1/retry");
        await flushPromises();
        expect(sleep).toHaveBeenCalledTimes(1);
        const unrelated = client.get("/api/v1/unrelated");
        await flushPromises();

        expect(mockRequest).toHaveBeenCalledWith(
            expect.objectContaining({ url: "/api/v1/unrelated" }),
        );
        releaseBackoff?.();
        await expect(Promise.all([retrying, unrelated])).resolves.toHaveLength(
            2,
        );
    });

    it("rejects invalid connection, options, and paths", async () => {
        expect(
            () => new LidarrHttpClient({ baseUrl: "ftp://x", apiKey: "k" }),
        ).toThrow("Lidarr base URL must use HTTP or HTTPS");
        expect(
            () => new LidarrHttpClient({ baseUrl: "http://h", apiKey: "" }),
        ).toThrow("Lidarr API key must be a non-empty string");
        expect(() => createClient({ maxRetries: -1 })).toThrow();
        expect(() => createClient({ concurrency: 0 })).toThrow();

        await expect(createClient().get("api/v1/queue")).rejects.toThrow(
            "Lidarr request path must start with /",
        );
        await expect(
            createClient().get("//untrusted.example/api/v1/queue"),
        ).rejects.toThrow("Lidarr request path must be relative");
        expect(mockRequest).not.toHaveBeenCalled();
    });
});

describe("resolveLidarrConnection", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        Object.assign(config, { lidarr: undefined });
    });

    it("prefers a complete enabled database connection", async () => {
        mockGetSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "https://db-lidarr.example",
            lidarrApiKey: "opaque-db-key",
        });

        await expect(resolveLidarrConnection()).resolves.toEqual({
            baseUrl: "https://db-lidarr.example",
            apiKey: "opaque-db-key",
        });
    });

    it("returns null when database and environment settings are unavailable", async () => {
        mockGetSystemSettings.mockResolvedValue({
            lidarrEnabled: false,
            lidarrUrl: "https://disabled.example",
            lidarrApiKey: "disabled-key",
        });

        await expect(resolveLidarrConnection()).resolves.toBeNull();
    });

    it("returns null without throwing for an invalid database URL", async () => {
        mockGetSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "not-a-url",
            lidarrApiKey: "opaque-db-key",
        });

        await expect(resolveLidarrConnection()).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(allLogOutput()).not.toContain("opaque-db-key");
        expect(allLogOutput()).not.toContain("not-a-url");
    });

    it("falls back to enabled environment settings after a database read error", async () => {
        mockGetSystemSettings.mockRejectedValue(
            new Error("database unavailable"),
        );
        Object.assign(config, {
            lidarr: {
                enabled: true,
                url: "http://env-lidarr.example",
                apiKey: "opaque-env-key",
            },
        });

        await expect(resolveLidarrConnection()).resolves.toEqual({
            baseUrl: "http://env-lidarr.example",
            apiKey: "opaque-env-key",
        });
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(allLogOutput()).not.toContain("opaque-env-key");
        expect(allLogOutput()).not.toContain("env-lidarr.example");
    });
});
