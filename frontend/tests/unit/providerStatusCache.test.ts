import assert from "node:assert/strict";
import test from "node:test";
import {
    PROVIDER_STATUS_NEGATIVE_TTL_MS,
    PROVIDER_STATUS_POSITIVE_TTL_MS,
    createProviderStatusCacheEntry,
    isProviderStatusCacheFresh,
} from "../../features/album/hooks/providerStatusCache.ts";

test("provider status cache keeps successful availability longer than failures", () => {
    const now = 1_000_000;
    const positive = createProviderStatusCacheEntry(true, now);
    const negative = createProviderStatusCacheEntry(false, now);

    assert.equal(
        isProviderStatusCacheFresh(
            positive,
            now + PROVIDER_STATUS_POSITIVE_TTL_MS - 1
        ),
        true
    );
    assert.equal(
        isProviderStatusCacheFresh(
            positive,
            now + PROVIDER_STATUS_POSITIVE_TTL_MS
        ),
        false
    );

    assert.equal(
        isProviderStatusCacheFresh(
            negative,
            now + PROVIDER_STATUS_NEGATIVE_TTL_MS - 1
        ),
        true
    );
    assert.equal(
        isProviderStatusCacheFresh(
            negative,
            now + PROVIDER_STATUS_NEGATIVE_TTL_MS
        ),
        false
    );
});
