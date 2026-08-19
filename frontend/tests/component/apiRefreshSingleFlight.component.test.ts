import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

const originalFetch = globalThis.fetch;

afterEach(async () => {
    const { api } = await import("../../lib/api");
    api.clearToken();
    if (originalFetch) {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    } else {
        delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
});

after(() => {
    if (originalFetch) {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    } else {
        delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
    GlobalRegistrator.unregister();
});

test("shares one token refresh across concurrent 401 responses", async () => {
    const { api } = await import("../../lib/api");
    const requestedUrls: string[] = [];
    let refreshCount = 0;

    api.setToken("access-old", "refresh-old");
    (globalThis as { fetch: typeof fetch }).fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
    ) => {
        const url = String(input);
        requestedUrls.push(url);

        if (url.endsWith("/api/auth/refresh")) {
            refreshCount += 1;
            return new Promise<Response>((resolve) => {
                setTimeout(() => {
                    resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            token: "access-new",
                            refreshToken: "refresh-new",
                        }),
                    } as Response);
                }, 5);
            });
        }

        const authorization = new Headers(init?.headers).get("Authorization");
        if (authorization === "Bearer access-old") {
            return {
                ok: false,
                status: 401,
                statusText: "Unauthorized",
                json: async () => ({
                    error: "Not authenticated",
                    code: "AUTH_REQUIRED",
                }),
            } as Response;
        }
        if (authorization === "Bearer access-new") {
            return {
                ok: true,
                status: 200,
                json: async () => ({ ok: true }),
            } as Response;
        }

        throw new Error(`Unexpected Authorization header for ${url}`);
    }) as typeof fetch;

    const results = await Promise.all([
        api.post("/x/a"),
        api.post("/x/b"),
        api.post("/x/c"),
    ]);

    assert.equal(refreshCount, 1);
    assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
    assert.equal(
        requestedUrls.filter((url) => url.endsWith("/api/auth/refresh")).length,
        1,
    );
});

test("keeps the session when refresh is temporarily unavailable", async () => {
    const { api } = await import("../../lib/api");
    const unavailableCases = [429, 503, "network"] as const;

    for (const unavailableCase of unavailableCases) {
        let sessionExpiredCount = 0;
        const onSessionExpired = () => {
            sessionExpiredCount += 1;
        };
        window.addEventListener("auth:session-expired", onSessionExpired);
        api.setToken("access-old", "refresh-old");

        (globalThis as { fetch: typeof fetch }).fetch = (async (
            input: Parameters<typeof fetch>[0],
        ) => {
            const url = String(input);
            if (url.endsWith("/api/auth/refresh")) {
                if (unavailableCase === "network") {
                    throw new TypeError("network unavailable");
                }
                return {
                    ok: false,
                    status: unavailableCase,
                    statusText: "Unavailable",
                    headers: new Headers(
                        unavailableCase === 429
                            ? { "Retry-After": "300" }
                            : undefined,
                    ),
                    json: async () => ({
                        error: "Authentication temporarily unavailable",
                    }),
                } as Response;
            }
            return {
                ok: false,
                status: 401,
                statusText: "Unauthorized",
                json: async () => ({
                    error: "Not authenticated",
                    code: "AUTH_REQUIRED",
                }),
            } as Response;
        }) as typeof fetch;

        try {
            await assert.rejects(api.get("/explore"), (failure: unknown) => {
                assert.ok(failure instanceof Error);
                assert.equal(
                    (failure as Error & { status?: number }).status,
                    401,
                );
                return true;
            });
            assert.equal(api.getToken(), "access-old");
            assert.equal(api.getRefreshToken(), "refresh-old");
            assert.equal(sessionExpiredCount, 0);
        } finally {
            window.removeEventListener(
                "auth:session-expired",
                onSessionExpired,
            );
        }
    }
});

test("clears the session when refresh credentials are rejected", async () => {
    const { api } = await import("../../lib/api");
    let sessionExpiredCount = 0;
    const onSessionExpired = () => {
        sessionExpiredCount += 1;
    };
    window.addEventListener("auth:session-expired", onSessionExpired);
    api.setToken("access-old", "refresh-old");

    (globalThis as { fetch: typeof fetch }).fetch = (async (
        input: Parameters<typeof fetch>[0],
    ) => {
        if (String(input).endsWith("/api/auth/refresh")) {
            return {
                ok: false,
                status: 401,
                statusText: "Unauthorized",
                json: async () => ({ error: "Invalid refresh token" }),
            } as Response;
        }
        return {
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            json: async () => ({
                error: "Not authenticated",
                code: "AUTH_REQUIRED",
            }),
        } as Response;
    }) as typeof fetch;

    try {
        await assert.rejects(api.get("/explore"));
        assert.equal(api.getToken(), null);
        assert.equal(api.getRefreshToken(), null);
        assert.equal(sessionExpiredCount, 1);
    } finally {
        window.removeEventListener("auth:session-expired", onSessionExpired);
    }
});

test("refreshes a second time after one spurious post-refresh 401", async () => {
    const { api } = await import("../../lib/api");
    let refreshCount = 0;

    api.setToken("access-0", "refresh-0");
    (globalThis as { fetch: typeof fetch }).fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
    ) => {
        const url = String(input);
        if (url.endsWith("/api/auth/refresh")) {
            refreshCount += 1;
            assert.equal(
                (init as RequestInit & { priority?: string }).priority,
                "high",
            );
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    token: `access-${refreshCount}`,
                    refreshToken: `refresh-${refreshCount}`,
                }),
            } as Response;
        }

        const authorization = new Headers(init?.headers).get("Authorization");
        if (authorization === "Bearer access-2") {
            return {
                ok: true,
                status: 200,
                json: async () => ({ ok: true }),
            } as Response;
        }
        return {
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            json: async () => ({
                error: "Not authenticated",
                code: "AUTH_REQUIRED",
            }),
        } as Response;
    }) as typeof fetch;

    await assert.doesNotReject(async () => {
        assert.deepEqual(await api.get("/explore"), { ok: true });
    });
    assert.equal(refreshCount, 2);
    assert.equal(api.getToken(), "access-2");
});

test("logs out when the second refresh is rejected", async () => {
    const { api } = await import("../../lib/api");
    let refreshCount = 0;
    let sessionExpiredCount = 0;
    const onSessionExpired = () => {
        sessionExpiredCount += 1;
    };
    window.addEventListener("auth:session-expired", onSessionExpired);
    api.setToken("access-0", "refresh-0");

    (globalThis as { fetch: typeof fetch }).fetch = (async (
        input: Parameters<typeof fetch>[0],
    ) => {
        if (String(input).endsWith("/api/auth/refresh")) {
            refreshCount += 1;
            if (refreshCount === 1) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        token: "access-1",
                        refreshToken: "refresh-1",
                    }),
                } as Response;
            }
            return {
                ok: false,
                status: 401,
                statusText: "Unauthorized",
                json: async () => ({ error: "Invalid refresh token" }),
            } as Response;
        }
        return {
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            json: async () => ({
                error: "Not authenticated",
                code: "AUTH_REQUIRED",
            }),
        } as Response;
    }) as typeof fetch;

    try {
        await assert.rejects(api.get("/explore"));
        assert.equal(refreshCount, 2);
        assert.equal(api.getToken(), null);
        assert.equal(api.getRefreshToken(), null);
        assert.equal(sessionExpiredCount, 1);
    } finally {
        window.removeEventListener("auth:session-expired", onSessionExpired);
    }
});
