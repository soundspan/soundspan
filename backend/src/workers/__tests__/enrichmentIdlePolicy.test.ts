import {
    EnrichmentIdleBackoff,
    ExpiringMemo,
    shouldSkipEnrichmentSnapshot,
} from "../enrichmentIdlePolicy";

describe("enrichment idle policy", () => {
    it("backs off exponentially after idle cycles and caps at five minutes", () => {
        const policy = new EnrichmentIdleBackoff(5_000, 300_000);
        let now = 1_000;

        expect(policy.getDelayMs()).toBe(5_000);
        for (const expectedDelay of [10_000, 20_000, 40_000, 80_000]) {
            policy.recordIdle(now);
            expect(policy.getDelayMs()).toBe(expectedDelay);
            expect(policy.isDue(now + expectedDelay - 1)).toBe(false);
            now += expectedDelay;
            expect(policy.isDue(now)).toBe(true);
        }

        for (let cycle = 0; cycle < 10; cycle += 1) {
            policy.recordIdle(now);
        }
        expect(policy.getDelayMs()).toBe(300_000);
    });

    it("resets to the base delay when work or a library-change signal arrives", () => {
        const policy = new EnrichmentIdleBackoff(5_000, 300_000);

        policy.recordIdle(1_000);
        policy.recordIdle(11_000);
        policy.recordWork(31_000);

        expect(policy.getDelayMs()).toBe(5_000);
        expect(policy.isDue(35_999)).toBe(false);
        expect(policy.isDue(36_000)).toBe(true);

        policy.recordIdle(36_000);
        policy.reset();
        expect(policy.getDelayMs()).toBe(5_000);
        expect(policy.isDue(36_000)).toBe(true);
    });

    it("skips snapshots only for authoritative, follow-up-free idle state", () => {
        const completeIdleState = {
            status: "idle",
            completionNotificationSent: true,
            coreCacheCleared: true,
            fullCacheCleared: true,
            pendingMoodBucketBackfill: false,
            moodBucketBackfillInProgress: false,
        } as const;

        expect(shouldSkipEnrichmentSnapshot(completeIdleState, false)).toBe(
            true,
        );
        expect(shouldSkipEnrichmentSnapshot(completeIdleState, true)).toBe(
            false,
        );
        expect(
            shouldSkipEnrichmentSnapshot({
                ...completeIdleState,
                status: "running",
            }),
        ).toBe(false);
        expect(
            shouldSkipEnrichmentSnapshot({
                ...completeIdleState,
                pendingMoodBucketBackfill: true,
            }),
        ).toBe(false);
        expect(
            shouldSkipEnrichmentSnapshot({
                ...completeIdleState,
                completionNotificationSent: false,
            }),
        ).toBe(false);
    });

    it("memoizes within the TTL and reloads after expiry or invalidation", async () => {
        let now = 10_000;
        const memo = new ExpiringMemo<string>(3_000, () => now);
        const load = jest
            .fn<Promise<string>, []>()
            .mockResolvedValueOnce("first")
            .mockResolvedValueOnce("second")
            .mockResolvedValueOnce("third");

        await expect(memo.get(load)).resolves.toBe("first");
        now = 12_999;
        await expect(memo.get(load)).resolves.toBe("first");
        now = 13_000;
        await expect(memo.get(load)).resolves.toBe("second");
        memo.invalidate();
        await expect(memo.get(load)).resolves.toBe("third");
        expect(load).toHaveBeenCalledTimes(3);
    });
});
