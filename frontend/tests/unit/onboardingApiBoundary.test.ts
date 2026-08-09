import assert from "node:assert/strict";
import { test } from "node:test";

import { api } from "../../lib/api";

test("getOnboardingStatus requests the onboarding status endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let calledUrl = "";

    globalThis.fetch = (async (input: string | URL | Request) => {
        calledUrl = String(input);
        return {
            ok: true,
            status: 200,
            json: async () => ({
                needsOnboarding: false,
                hasAccount: true,
            }),
        } as Response;
    }) as typeof fetch;

    try {
        const result = await api.getOnboardingStatus();

        assert.equal(calledUrl.endsWith("/api/onboarding/status"), true);
        assert.equal(result.needsOnboarding, false);
        assert.equal(result.hasAccount, true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
