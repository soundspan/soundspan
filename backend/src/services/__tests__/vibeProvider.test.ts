const mockGetActiveSpace = jest.fn();
const mockRecordVibeProviderRequest = jest.fn();
const mockConfig = {
    vibeProviderUrl: "http://provider.test/base/",
    internalApiSecret: "internal-secret",
};

jest.mock("../../config", () => ({ config: mockConfig }));
jest.mock("../embeddingSpaces", () => ({
    getActiveSpace: (...args: unknown[]) => mockGetActiveSpace(...args),
    embeddingPreprocessingMatches: (left: unknown, right: unknown) =>
        JSON.stringify(left) === JSON.stringify(right),
}));
jest.mock("../../metrics", () => ({
    recordVibeProviderRequest: (...args: unknown[]) =>
        mockRecordVibeProviderRequest(...args),
}));

import {
    createProviderClient,
    embedAudio,
    embedText,
    fetchProviderSpace,
    PROVIDER_AUDIO_TIMEOUT_MS,
    VibeProviderAuthError,
    VibeProviderBackpressureError,
    VibeProviderContractError,
    VibeProviderServerError,
    VibeProviderSpaceMismatchError,
    VibeProviderTimeoutError,
    VibeProviderUnavailableError,
} from "../vibeProvider";

const mockFetch = jest.fn();

function jsonResponse(
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });
}

function expectMetric(endpoint: string, outcome: string): void {
    expect(mockRecordVibeProviderRequest).toHaveBeenCalledWith(
        endpoint,
        outcome,
        expect.any(Number),
    );
}

describe("vibe provider client", () => {
    beforeAll(() => {
        jest.spyOn(global, "fetch").mockImplementation(mockFetch);
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetActiveSpace.mockResolvedValue({
            id: "space-active",
            family: "clap-music-audioset",
            checkpointHash: "sha256:fixture",
            dim: 2,
            preprocessing: { sampleRateHz: 48_000 },
        });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    afterAll(() => {
        jest.restoreAllMocks();
    });

    it("fetches and validates the active provider space", async () => {
        mockFetch.mockResolvedValueOnce(
            jsonResponse({
                family: "clap-music-audioset",
                checkpointHash: "sha256:fixture",
                dim: 2,
                sampleRateHz: 48_000,
                preprocessing: { mono: true },
                revision: "2026-08-16",
                textTower: true,
            }),
        );

        await expect(fetchProviderSpace()).resolves.toEqual(
            expect.objectContaining({
                family: "clap-music-audioset",
                checkpointHash: "sha256:fixture",
                dim: 2,
                textTower: true,
            }),
        );
        expect(mockFetch).toHaveBeenCalledWith(
            "http://provider.test/base/v1/space",
            expect.objectContaining({
                method: "GET",
                headers: expect.objectContaining({
                    "X-Internal-Secret": "internal-secret",
                }),
            }),
        );
        expectMetric("space", "ok");
    });

    it("accepts additive provider space fields", async () => {
        mockFetch.mockResolvedValueOnce(
            jsonResponse({
                family: "clap-music-audioset",
                checkpointHash: "sha256:fixture",
                dim: 2,
                sampleRateHz: 48_000,
                preprocessing: { mono: true },
                revision: "2026-08-16",
                textTower: true,
                futureCapability: "supported",
            }),
        );

        const providerSpace = await fetchProviderSpace();

        expect(providerSpace).toEqual({
            family: "clap-music-audioset",
            checkpointHash: "sha256:fixture",
            dim: 2,
            sampleRateHz: 48_000,
            preprocessing: { mono: true },
            revision: "2026-08-16",
            textTower: true,
        });
        expectMetric("space", "ok");
    });

    it("embeds text and audio through their bounded endpoints", async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ vector: [0.6, 0.8] }))
            .mockResolvedValueOnce(jsonResponse({ vector: [0, 1] }));

        await expect(embedText("quiet focus")).resolves.toEqual([0.6, 0.8]);
        await expect(
            embedAudio("track-123", {
                id: "space-active",
                dim: 2,
            }),
        ).resolves.toEqual([0, 1]);

        expect(mockFetch).toHaveBeenNthCalledWith(
            1,
            "http://provider.test/base/v1/embed/text",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ text: "quiet focus" }),
            }),
        );
        expect(mockFetch).toHaveBeenNthCalledWith(
            2,
            "http://provider.test/base/v1/embed/audio",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ trackRef: "track-123" }),
            }),
        );
        expectMetric("text", "ok");
        expectMetric("audio", "ok");
    });

    it("aborts a text request at its timeout", async () => {
        jest.useFakeTimers();
        mockFetch.mockImplementationOnce(
            (_url: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener("abort", () => {
                        reject(new DOMException("aborted", "AbortError"));
                    });
                }),
        );

        const request = embedText("slow query");
        const rejection = expect(request).rejects.toBeInstanceOf(
            VibeProviderTimeoutError,
        );
        await jest.advanceTimersByTimeAsync(30_000);

        await rejection;
        expectMetric("text", "timeout");
    });

    it("classifies a deadline during response body reading as a timeout", async () => {
        jest.useFakeTimers();
        mockFetch.mockImplementationOnce((_url: string, init: RequestInit) =>
            Promise.resolve(
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(
                                new TextEncoder().encode('{"vector":'),
                            );
                            init.signal?.addEventListener("abort", () => {
                                controller.error(
                                    new DOMException("aborted", "AbortError"),
                                );
                            });
                        },
                    }),
                    {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    },
                ),
            ),
        );

        const request = embedText("slow body");
        const rejection = expect(request).rejects.toBeInstanceOf(
            VibeProviderTimeoutError,
        );
        await jest.advanceTimersByTimeAsync(30_000);

        await rejection;
        expectMetric("text", "timeout");
    });

    it("maps an authentication rejection", async () => {
        mockFetch.mockResolvedValueOnce(
            jsonResponse({ error: "unauthorized" }, 401),
        );

        const request = embedText("quiet focus");
        await expect(request).rejects.toBeInstanceOf(VibeProviderAuthError);
        await expect(request).rejects.toMatchObject({
            message: "unauthorized",
        });
        expectMetric("text", "auth");
    });

    it("classifies authentication by status when the error body is non-conforming", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ message: "x" }, 401));

        const request = embedText("quiet focus");
        await expect(request).rejects.toBeInstanceOf(VibeProviderAuthError);
        await expect(request).rejects.toMatchObject({
            message: "Vibe provider authentication failed",
        });
        expectMetric("text", "auth");
    });

    it("maps a forbidden authentication rejection", async () => {
        mockFetch.mockResolvedValueOnce(
            jsonResponse({ error: "Forbidden" }, 403),
        );

        const request = embedText("quiet focus");
        await expect(request).rejects.toBeInstanceOf(VibeProviderAuthError);
        await expect(request).rejects.toMatchObject({
            message: "Forbidden",
        });
        expectMetric("text", "auth");
    });

    it("classifies provider failures by status when the error body is not JSON", async () => {
        mockFetch.mockResolvedValueOnce(
            new Response("<html>bad gateway</html>", {
                status: 502,
                headers: { "content-type": "text/html" },
            }),
        );

        const request = embedText("quiet focus");
        await expect(request).rejects.toBeInstanceOf(VibeProviderServerError);
        await expect(request).rejects.toMatchObject({
            message: "Vibe provider returned 502",
        });
        expectMetric("text", "error");
    });

    it.each([
        [
            408,
            { error: "Inference deadline exceeded" },
            VibeProviderTimeoutError,
        ],
        [
            429,
            { error: "Inference queue is full" },
            VibeProviderBackpressureError,
        ],
        [503, { error: "Inference cancelled" }, VibeProviderServerError],
    ])(
        "classifies retryable provider response %i",
        async (status, body, expectedError) => {
            mockFetch.mockResolvedValueOnce(jsonResponse(body, status));

            await expect(embedText("quiet focus")).rejects.toBeInstanceOf(
                expectedError,
            );
            expectMetric("text", status === 408 ? "timeout" : "error");
        },
    );

    it.each([
        ["120", 120_000],
        ["9999", 300_000],
    ])(
        "honors and caps Retry-After %s for backpressure",
        async (retryAfter, expectedMs) => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse({ error: "Inference queue is full" }, 429, {
                    "retry-after": retryAfter,
                }),
            );

            await expect(embedText("quiet focus")).rejects.toMatchObject({
                name: "VibeProviderBackpressureError",
                retryAfterMs: expectedMs,
            });
        },
    );

    it("keeps the audio client deadline above the sidecar budget", () => {
        expect(PROVIDER_AUDIO_TIMEOUT_MS).toBe(115_000);
    });

    it("aborts audio inference after the aligned client deadline", async () => {
        jest.useFakeTimers();
        mockFetch.mockImplementationOnce(
            (_url: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener("abort", () => {
                        reject(new DOMException("aborted", "AbortError"));
                    });
                }),
        );

        const request = embedAudio("track.flac", {
            id: "space-active",
            dim: 2,
        });
        const rejection = expect(request).rejects.toBeInstanceOf(
            VibeProviderTimeoutError,
        );
        await jest.advanceTimersByTimeAsync(PROVIDER_AUDIO_TIMEOUT_MS);

        await rejection;
        expectMetric("audio", "timeout");
    });

    it("keeps a non-JSON success body classified as a contract failure", async () => {
        mockFetch.mockResolvedValueOnce(
            new Response("<html>unexpected success</html>", {
                status: 200,
                headers: { "content-type": "text/html" },
            }),
        );

        await expect(embedText("quiet focus")).rejects.toBeInstanceOf(
            VibeProviderContractError,
        );
        expectMetric("text", "contract");
    });

    it("rejects malformed success bodies", async () => {
        mockFetch.mockResolvedValueOnce(
            jsonResponse({ vector: "not-a-vector" }),
        );

        await expect(embedText("quiet focus")).rejects.toBeInstanceOf(
            VibeProviderContractError,
        );
        expectMetric("text", "contract");
    });

    it("rejects vectors with the wrong active-space dimension", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ vector: [1] }));

        await expect(embedText("quiet focus")).rejects.toBeInstanceOf(
            VibeProviderContractError,
        );
        expectMetric("text", "contract");
    });

    it("validates audio vectors against the worker target dimension", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ vector: [1] }));

        await expect(
            embedAudio("track-123", {
                id: "space-migrating",
                dim: 1,
            }),
        ).resolves.toEqual([1]);
        expect(mockGetActiveSpace).not.toHaveBeenCalled();
        expectMetric("audio", "ok");
    });

    it("rejects vectors outside the unit-norm tolerance", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ vector: [0.5, 0.5] }));

        await expect(embedText("quiet focus")).rejects.toBeInstanceOf(
            VibeProviderContractError,
        );
        expectMetric("text", "contract");
    });

    it("returns a distinct provider identity for worker registry resolution", async () => {
        mockFetch.mockResolvedValueOnce(
            jsonResponse({
                family: "other-family",
                checkpointHash: "sha256:fixture",
                dim: 2,
                sampleRateHz: 48_000,
                preprocessing: { mono: true },
                revision: "2026-08-16",
                textTower: true,
            }),
        );

        await expect(fetchProviderSpace()).resolves.toMatchObject({
            family: "other-family",
            checkpointHash: "sha256:fixture",
        });
        expectMetric("space", "ok");
    });

    it("distinguishes provider 5xx from an unreachable provider", async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ error: "not ready" }, 503))
            .mockRejectedValueOnce(new TypeError("fetch failed"));

        await expect(embedText("first query")).rejects.toBeInstanceOf(
            VibeProviderServerError,
        );
        expectMetric("text", "error");

        mockRecordVibeProviderRequest.mockClear();
        await expect(embedText("second query")).rejects.toBeInstanceOf(
            VibeProviderUnavailableError,
        );
        expectMetric("text", "error");
    });

    it("validates explicit clients against each provider's declared space", async () => {
        mockFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    family: "candidate-space",
                    checkpointHash: "sha256:candidate",
                    dim: 3,
                    sampleRateHz: 48_000,
                    preprocessing: { mono: true },
                    revision: "candidate",
                    textTower: true,
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ vector: [1, 0, 0] }));
        const client = createProviderClient("http://candidate.test/root/");

        await expect(client.fetchSpace()).resolves.toMatchObject({ dim: 3 });
        await expect(client.embedText("query")).resolves.toEqual([1, 0, 0]);
        expect(mockGetActiveSpace).not.toHaveBeenCalled();
        expect(mockFetch).toHaveBeenNthCalledWith(
            2,
            "http://candidate.test/root/v1/embed/text",
            expect.any(Object),
        );
    });

    it("rejects an explicit client's malformed vector using its declared dimension", async () => {
        mockFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    family: "candidate-space",
                    checkpointHash: "sha256:candidate",
                    dim: 3,
                    sampleRateHz: 48_000,
                    preprocessing: { mono: true },
                    revision: "candidate",
                    textTower: true,
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ vector: [1, 0] }));
        const client = createProviderClient("http://candidate.test");

        await client.fetchSpace();
        await expect(client.embedAudio("track.flac")).rejects.toBeInstanceOf(
            VibeProviderContractError,
        );
    });
});
