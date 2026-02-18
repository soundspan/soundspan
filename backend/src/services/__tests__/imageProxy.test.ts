import {
    fetchExternalImage,
    normalizeExternalImageUrl,
} from "../imageProxy";

describe("imageProxy", () => {
    const originalFetch = global.fetch;
    const makeImmediateSetTimeout = () =>
        jest
            .spyOn(global, "setTimeout")
            .mockImplementation((cb) => {
                cb();
                return 0 as any;
            });

    afterEach(() => {
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    describe("normalizeExternalImageUrl", () => {
        it("allows public https urls", () => {
            expect(
                normalizeExternalImageUrl("https://example.com/covers/a.jpg")
            ).toBe("https://example.com/covers/a.jpg");
        });

        it("blocks private/local destinations", () => {
            expect(normalizeExternalImageUrl("http://127.0.0.1:3000/a.jpg")).toBeNull();
            expect(normalizeExternalImageUrl("http://192.168.1.10/a.jpg")).toBeNull();
            expect(normalizeExternalImageUrl("http://localhost/a.jpg")).toBeNull();
        });

        it("blocks non-http protocols", () => {
            expect(normalizeExternalImageUrl("file:///tmp/a.jpg")).toBeNull();
        });

        it("returns null when URL parsing throws", () => {
            expect(normalizeExternalImageUrl("https://[::1")).toBeNull();
        });
    });

    describe("fetchExternalImage", () => {
        it("returns invalid_url for blocked input", async () => {
            const result = await fetchExternalImage({
                url: "http://127.0.0.1/secret",
            });

            expect(result).toEqual({
                ok: false,
                status: "invalid_url",
                url: "http://127.0.0.1/secret",
                message: "Invalid or private URL",
            });
        });

        it("returns invalid_url when redirect target is private", async () => {
            global.fetch = jest.fn().mockResolvedValue(
                new Response(null, {
                    status: 302,
                    headers: { location: "http://127.0.0.1/internal.jpg" },
                })
            ) as any;

            const result = await fetchExternalImage({
                url: "https://example.com/cover.jpg",
                maxRetries: 1,
            });

            expect(result.ok).toBe(false);
            expect(result).toMatchObject({
                status: "invalid_url",
            });
        });

        it("returns not_found for 404 responses", async () => {
            global.fetch = jest.fn().mockResolvedValue(
                new Response(null, { status: 404 })
            ) as any;

            const result = await fetchExternalImage({
                url: "https://example.com/missing.jpg",
                maxRetries: 1,
            });

            expect(result).toEqual({
                ok: false,
                status: "not_found",
                url: "https://example.com/missing.jpg",
            });
        });

        it("returns image payload + metadata for success responses", async () => {
            global.fetch = jest.fn().mockResolvedValue(
                new Response("image-bytes", {
                    status: 200,
                    headers: { "content-type": "image/jpeg" },
                })
            ) as any;

            const result = await fetchExternalImage({
                url: "https://example.com/cover.jpg",
                maxRetries: 1,
            });

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.contentType).toBe("image/jpeg");
                expect(result.url).toBe("https://example.com/cover.jpg");
                expect(result.buffer.length).toBeGreaterThan(0);
                expect(result.etag).toHaveLength(32);
            }
        });

        it("returns fetch_error when request passes max redirects", async () => {
            global.fetch = jest.fn().mockResolvedValue(
                new Response(null, {
                    status: 302,
                    headers: { location: "https://example.com/redirect" },
                })
            ) as any;

            const result = await fetchExternalImage({
                url: "https://example.com/landing.jpg",
                maxRetries: 1,
                maxRedirects: 1,
            });

            expect(global.fetch).toHaveBeenCalledTimes(2);
            expect(result).toEqual({
                ok: false,
                status: "fetch_error",
                url: "https://example.com/landing.jpg",
                message: "Too many redirects",
            });
        });

        it("returns fetch_error for non-ok non-404 responses", async () => {
            global.fetch = jest.fn().mockResolvedValue(
                new Response("bad", {
                    status: 400,
                    statusText: "Bad Request",
                })
            ) as any;

            const result = await fetchExternalImage({
                url: "https://example.com/bad.jpg",
                maxRetries: 1,
            });

            expect(result).toEqual({
                ok: false,
                status: "fetch_error",
                url: "https://example.com/bad.jpg",
                message: "400 Bad Request",
            });
        });

        it("retries on transient 5xx failures and eventually succeeds", async () => {
            makeImmediateSetTimeout();
            global.fetch = jest.fn()
                .mockResolvedValueOnce(
                    new Response("down", {
                        status: 502,
                        statusText: "Bad Gateway",
                    })
                )
                .mockResolvedValueOnce(
                    new Response("image-bytes", {
                        status: 200,
                        headers: { "content-type": "image/jpeg" },
                    })
                ) as any;

            const result = await fetchExternalImage({
                url: "https://example.com/retry.jpg",
                maxRetries: 2,
            });

            expect(global.fetch).toHaveBeenCalledTimes(2);
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.url).toBe("https://example.com/retry.jpg");
                expect(result.contentType).toBe("image/jpeg");
            }
        });

        it("retries when fetch throws and succeeds on retry", async () => {
            makeImmediateSetTimeout();
            global.fetch = jest.fn()
                .mockRejectedValueOnce(new Error("connection reset"))
                .mockResolvedValueOnce(
                    new Response("image-bytes", {
                        status: 200,
                        headers: { "content-type": "image/png" },
                    })
                ) as any;

            const result = await fetchExternalImage({
                url: "https://example.com/throw-retry.jpg",
                maxRetries: 2,
            });

            expect(global.fetch).toHaveBeenCalledTimes(2);
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.url).toBe("https://example.com/throw-retry.jpg");
                expect(result.contentType).toBe("image/png");
            }
        });

        it("returns final fetch error message from Error after retries", async () => {
            makeImmediateSetTimeout();
            global.fetch = jest.fn().mockRejectedValue(new Error("network down")) as any;

            const result = await fetchExternalImage({
                url: "https://example.com/final-error.jpg",
                maxRetries: 2,
            });

            expect(global.fetch).toHaveBeenCalledTimes(2);
            expect(result).toEqual({
                ok: false,
                status: "fetch_error",
                url: "https://example.com/final-error.jpg",
                message: "network down",
            });
        });

        it("returns final fetch_error message for unknown non-Error throw", async () => {
            global.fetch = jest.fn().mockRejectedValue("kaboom") as any;

            const result = await fetchExternalImage({
                url: "https://example.com/unknown-error.jpg",
                maxRetries: 1,
            });

            expect(global.fetch).toHaveBeenCalledTimes(1);
            expect(result).toEqual({
                ok: false,
                status: "fetch_error",
                url: "https://example.com/unknown-error.jpg",
                message: "Unknown fetch error",
            });
        });
    });
});
