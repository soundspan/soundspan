import assert from "node:assert/strict";
import { after, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

const originalFetch = globalThis.fetch;

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
