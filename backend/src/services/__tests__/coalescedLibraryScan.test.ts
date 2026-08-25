const mockScanQueue = {
    add: jest.fn(),
    getJob: jest.fn(),
};

const mockRedis = {
    eval: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    quit: jest.fn(),
};
const mockCreateIORedisClient = jest.fn(() => mockRedis);
const mockCompareAndDeleteSchedulerClaim = jest.fn(
    async (key: string, token: string) =>
        (await mockRedis.eval("shared-claim-release", 1, key, token)) === 1,
);
const mockRandomUUID = jest.fn();

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);

jest.mock("../../workers/queues", () => ({ scanQueue: mockScanQueue }));
jest.mock("../../config", () => ({ config: { underJest: true } }));
jest.mock("../../utils/ioredis", () => ({
    createIORedisClient: mockCreateIORedisClient,
}));
jest.mock("../../utils/schedulerClaim", () => ({
    compareAndDeleteSchedulerClaim: mockCompareAndDeleteSchedulerClaim,
}));
jest.mock("../../utils/logger", () => ({ logger: mockLogger }));
jest.mock("crypto", () => ({
    ...jest.requireActual("crypto"),
    randomUUID: mockRandomUUID,
}));

import {
    closeCoalescedLibraryScanRedis,
    COALESCED_SCAN_JOB_ID,
    consumeCoalescedScanFollowUp,
    requestCoalescedLibraryScan,
} from "../coalescedLibraryScan";

const FOLLOW_UP_KEY = "coalesced-library-scan:follow-up";
const JOB_OPTIONS = {
    jobId: COALESCED_SCAN_JOB_ID,
    delay: 30_000,
    removeOnComplete: true,
    removeOnFail: true,
};

function jobInState(state: string) {
    return {
        getState: jest.fn(async () => state),
        remove: jest.fn(async () => undefined),
    };
}

describe("coalescedLibraryScan", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        let nonce = 0;
        mockRandomUUID.mockImplementation(() => `nonce-${(nonce += 1)}`);
        mockRedis.eval.mockReset();
        mockRedis.get.mockReset();
        mockRedis.set.mockReset();
        mockRedis.quit.mockReset();
        mockScanQueue.add.mockReset();
        mockScanQueue.getJob.mockReset();
        mockRedis.eval.mockResolvedValue(1);
        mockRedis.get.mockResolvedValue(null);
        mockRedis.set.mockResolvedValue("OK");
        mockRedis.quit.mockResolvedValue("OK");
        mockScanQueue.add.mockResolvedValue({ id: COALESCED_SCAN_JOB_ID });
    });

    afterAll(async () => {
        await closeCoalescedLibraryScanRedis();
    });

    it("adds the stable delayed scan when no coalesced job exists", async () => {
        mockScanQueue.getJob
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(jobInState("waiting"));

        await requestCoalescedLibraryScan("user-1", "tidal-download");

        expect(mockScanQueue.add).toHaveBeenCalledWith(
            "scan",
            {
                userId: "user-1",
                source: "coalesced-library-scan",
            },
            JOB_OPTIONS,
        );
    });

    it.each(["waiting", "delayed", "paused"])(
        "does not add another scan while the job is %s",
        async (state) => {
            mockScanQueue.getJob.mockResolvedValueOnce(jobInState(state));

            await requestCoalescedLibraryScan("user-1", "youtube-download");

            expect(mockScanQueue.add).not.toHaveBeenCalled();
            expect(mockRedis.set).not.toHaveBeenCalled();
        },
    );

    it("coalesces a burst while the stable job is waiting", async () => {
        const waitingJob = jobInState("waiting");
        mockScanQueue.getJob
            .mockResolvedValueOnce(null)
            .mockResolvedValue(waitingJob);

        await requestCoalescedLibraryScan("user-first", "youtube-download");
        await Promise.all(
            Array.from({ length: 8 }, (_, index) =>
                requestCoalescedLibraryScan(
                    `user-${index}`,
                    "youtube-download",
                ),
            ),
        );

        expect(mockScanQueue.add).toHaveBeenCalledTimes(1);
        expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it("sets the distributed follow-up flag while the scan stays active", async () => {
        mockScanQueue.getJob
            .mockResolvedValueOnce(jobInState("active"))
            .mockResolvedValueOnce(jobInState("active"));

        await requestCoalescedLibraryScan("user-2", "download-queue");

        expect(mockRedis.set).toHaveBeenCalledWith(
            FOLLOW_UP_KEY,
            JSON.stringify({ userId: "user-2", nonce: "nonce-1" }),
            "EX",
            86_400,
        );
        expect(mockRedis.eval).not.toHaveBeenCalled();
        expect(mockScanQueue.add).not.toHaveBeenCalled();
    });

    it("cleans up its marker and adds a fresh job when an active job settles", async () => {
        mockScanQueue.getJob
            .mockResolvedValueOnce(jobInState("active"))
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(jobInState("waiting"));
        const stored = JSON.stringify({
            userId: "user-settled",
            nonce: "nonce-1",
        });

        await requestCoalescedLibraryScan("user-settled", "download-queue");

        expect(mockRedis.eval).toHaveBeenCalledWith(
            expect.any(String),
            1,
            FOLLOW_UP_KEY,
            stored,
        );
        expect(mockScanQueue.add).toHaveBeenCalledWith(
            "scan",
            {
                userId: "user-settled",
                source: "coalesced-library-scan",
            },
            JOB_OPTIONS,
        );
        expect(mockScanQueue.getJob).toHaveBeenCalledTimes(4);
    });

    it("continues when settled cleanup finds its marker already changed", async () => {
        mockScanQueue.getJob
            .mockResolvedValueOnce(jobInState("active"))
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(jobInState("waiting"));
        mockRedis.eval.mockResolvedValueOnce(0);

        await requestCoalescedLibraryScan("user-consumed", "download-queue");

        expect(mockRedis.eval).toHaveBeenCalledWith(
            expect.any(String),
            1,
            FOLLOW_UP_KEY,
            JSON.stringify({
                userId: "user-consumed",
                nonce: "nonce-1",
            }),
        );
        expect(mockScanQueue.add).toHaveBeenCalledTimes(1);
    });

    it("removes a retained terminal job before adding the next scan", async () => {
        const terminalJob = jobInState("completed");
        mockScanQueue.getJob
            .mockResolvedValueOnce(terminalJob)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(jobInState("waiting"));

        await requestCoalescedLibraryScan("user-3", "queue-cleaner-recovery");

        expect(terminalJob.remove).toHaveBeenCalledTimes(1);
        expect(mockScanQueue.add).toHaveBeenCalledWith(
            "scan",
            {
                userId: "user-3",
                source: "coalesced-library-scan",
            },
            JOB_OPTIONS,
        );
        expect(terminalJob.remove.mock.invocationCallOrder[0]).toBeLessThan(
            mockScanQueue.add.mock.invocationCallOrder[0],
        );
    });

    it("does not remove a terminal handle whose state becomes delayed", async () => {
        const changingJob = jobInState("completed");
        changingJob.getState
            .mockResolvedValueOnce("completed")
            .mockResolvedValue("delayed");
        mockScanQueue.getJob.mockResolvedValue(changingJob);

        await requestCoalescedLibraryScan(
            "user-state-change",
            "queue-cleaner-recovery",
        );

        expect(changingJob.getState).toHaveBeenCalledTimes(3);
        expect(changingJob.remove).not.toHaveBeenCalled();
        expect(mockScanQueue.add).not.toHaveBeenCalled();
    });

    it("sets the follow-up flag when the add race leaves the job active", async () => {
        mockScanQueue.getJob
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(jobInState("active"))
            .mockResolvedValueOnce(jobInState("active"));

        await requestCoalescedLibraryScan("user-race", "retry-pending-track");

        expect(mockScanQueue.add).toHaveBeenCalledTimes(1);
        expect(mockRedis.set).toHaveBeenCalledWith(
            FOLLOW_UP_KEY,
            JSON.stringify({ userId: "user-race", nonce: "nonce-1" }),
            "EX",
            86_400,
        );
        expect(mockRedis.eval).not.toHaveBeenCalled();
    });

    it("adds a fresh job when a deduplicated add vanishes before its recheck", async () => {
        mockScanQueue.getJob
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(jobInState("waiting"));

        await requestCoalescedLibraryScan("user-race", "download-queue");

        expect(mockScanQueue.add).toHaveBeenCalledTimes(2);
        expect(mockScanQueue.add).toHaveBeenLastCalledWith(
            "scan",
            {
                userId: "user-race",
                source: "coalesced-library-scan",
            },
            JOB_OPTIONS,
        );
    });

    it("cleans up the marker when the post-add active job settles", async () => {
        mockScanQueue.getJob
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(jobInState("active"))
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(jobInState("waiting"));
        await requestCoalescedLibraryScan("user-post-add", "download-queue");

        expect(mockRedis.eval).toHaveBeenCalledWith(
            expect.any(String),
            1,
            FOLLOW_UP_KEY,
            JSON.stringify({
                userId: "user-post-add",
                nonce: "nonce-1",
            }),
        );
        expect(mockScanQueue.add).toHaveBeenCalledTimes(2);
    });

    it("bounds repeated active-to-settled races without recursive consumption", async () => {
        mockScanQueue.getJob
            .mockResolvedValueOnce(jobInState("active"))
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(jobInState("active"))
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(jobInState("active"))
            .mockResolvedValueOnce(null)
            .mockResolvedValue(jobInState("waiting"));
        await requestCoalescedLibraryScan("user-bounded", "download-queue");

        expect(mockScanQueue.getJob).toHaveBeenCalledTimes(6);
        expect(mockScanQueue.add).toHaveBeenCalledTimes(1);
        expect(mockRedis.eval).toHaveBeenCalledTimes(3);
    });

    it("propagates initial enqueue failures", async () => {
        const enqueueError = new Error("queue unavailable");
        mockScanQueue.getJob.mockResolvedValueOnce(null);
        mockScanQueue.add.mockRejectedValueOnce(enqueueError);

        await expect(
            requestCoalescedLibraryScan("user-error", "tidal-download"),
        ).rejects.toBe(enqueueError);
    });

    it("propagates retained terminal job removal failures", async () => {
        const removeError = new Error("remove unavailable");
        const terminalJob = jobInState("completed");
        terminalJob.remove.mockRejectedValueOnce(removeError);
        mockScanQueue.getJob.mockResolvedValueOnce(terminalJob);

        await expect(
            requestCoalescedLibraryScan("user-error", "download-queue"),
        ).rejects.toBe(removeError);

        expect(mockScanQueue.add).not.toHaveBeenCalled();
    });

    it("uses one direct add after bounded attempts are exhausted", async () => {
        mockScanQueue.getJob
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        await requestCoalescedLibraryScan(
            "user-exhausted",
            "queue-cleaner-recovery",
        );

        expect(mockScanQueue.add).toHaveBeenCalledTimes(4);
        expect(mockRedis.set).toHaveBeenCalledWith(
            FOLLOW_UP_KEY,
            JSON.stringify({
                userId: "user-exhausted",
                nonce: "nonce-1",
            }),
            "EX",
            86_400,
        );
        expect(mockScanQueue.getJob).toHaveBeenCalledTimes(6);
        expect(mockRedis.eval).not.toHaveBeenCalled();
    });

    it("propagates a direct fallback add failure without consuming", async () => {
        const enqueueError = new Error("queue unavailable during fallback");
        const stored = JSON.stringify({
            userId: "user-exhausted",
            nonce: "nonce-1",
        });
        mockScanQueue.getJob
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        mockScanQueue.add
            .mockResolvedValueOnce({ id: COALESCED_SCAN_JOB_ID })
            .mockResolvedValueOnce({ id: COALESCED_SCAN_JOB_ID })
            .mockResolvedValueOnce({ id: COALESCED_SCAN_JOB_ID })
            .mockRejectedValueOnce(enqueueError);

        await expect(
            requestCoalescedLibraryScan(
                "user-exhausted",
                "queue-cleaner-recovery",
            ),
        ).rejects.toBe(enqueueError);

        expect(mockRedis.set).toHaveBeenNthCalledWith(
            1,
            FOLLOW_UP_KEY,
            stored,
            "EX",
            86_400,
        );
        expect(mockRedis.set).toHaveBeenCalledTimes(1);
        expect(mockScanQueue.getJob).toHaveBeenCalledTimes(6);
        expect(mockRedis.eval).not.toHaveBeenCalled();
    });

    it("reads a stored follow-up and re-enqueues", async () => {
        const stored = JSON.stringify({
            userId: "user-follow-up",
            nonce: "stored-nonce",
        });
        mockRedis.get.mockResolvedValueOnce(stored);
        mockScanQueue.getJob
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(jobInState("waiting"));

        await consumeCoalescedScanFollowUp();

        expect(mockRedis.get).toHaveBeenCalledWith(FOLLOW_UP_KEY);
        expect(mockRedis.eval).toHaveBeenCalledWith(
            expect.any(String),
            1,
            FOLLOW_UP_KEY,
            stored,
        );
        expect(mockScanQueue.add).toHaveBeenCalledWith(
            "scan",
            {
                userId: "user-follow-up",
                source: "coalesced-library-scan",
            },
            JOB_OPTIONS,
        );
    });

    it("compare-deletes the exact marker only after re-enqueue succeeds", async () => {
        const stored = JSON.stringify({
            userId: "user-follow-up",
            nonce: "stored-nonce",
        });
        mockRedis.get.mockResolvedValueOnce(stored);
        mockScanQueue.getJob
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(jobInState("waiting"));

        await consumeCoalescedScanFollowUp();

        expect(mockRedis.eval).toHaveBeenCalledWith(
            "shared-claim-release",
            1,
            FOLLOW_UP_KEY,
            stored,
        );
        expect(mockScanQueue.add.mock.invocationCallOrder[0]).toBeLessThan(
            mockRedis.eval.mock.invocationCallOrder[0],
        );
    });

    it("retains the marker without restoring when follow-up re-enqueue fails", async () => {
        const stored = JSON.stringify({
            userId: "user-follow-up",
            nonce: "stored-nonce",
        });
        const enqueueError = new Error("queue closed");
        let marker: string | null = stored;
        mockRedis.get.mockImplementationOnce(async () => marker);
        mockRedis.eval.mockImplementationOnce(
            async (_script, _keyCount, _key, expected) => {
                if (marker !== expected) return 0;
                marker = null;
                return 1;
            },
        );
        mockScanQueue.getJob.mockResolvedValueOnce(null);
        mockScanQueue.add.mockRejectedValueOnce(enqueueError);

        await expect(consumeCoalescedScanFollowUp()).resolves.toBeUndefined();

        expect(marker).toBe(stored);
        expect(mockRedis.eval).not.toHaveBeenCalled();
        expect(mockRedis.set).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledWith(
            "Failed to re-enqueue coalesced library scan follow-up; marker retained",
            { error: enqueueError },
        );
    });

    it("preserves a newer same-user marker during stale settled-recheck cleanup", async () => {
        const ownMarker = JSON.stringify({
            userId: "user-shared",
            nonce: "nonce-1",
        });
        const newerMarker = JSON.stringify({
            userId: "user-shared",
            nonce: "generation-2",
        });
        let marker: string | null = null;
        mockRedis.set.mockImplementationOnce(async (_key, value) => {
            marker = value;
            return "OK";
        });
        mockRedis.eval.mockImplementationOnce(
            async (_script, _keyCount, _key, expected) => {
                if (marker !== expected) return 0;
                marker = null;
                return 1;
            },
        );
        mockScanQueue.getJob
            .mockResolvedValueOnce(jobInState("active"))
            .mockImplementationOnce(async () => {
                marker = newerMarker;
                return null;
            })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(jobInState("waiting"));

        await requestCoalescedLibraryScan("user-shared", "download-queue");

        expect(marker).toBe(newerMarker);
        expect(mockRedis.eval).toHaveBeenCalledWith(
            expect.any(String),
            1,
            FOLLOW_UP_KEY,
            ownMarker,
        );
    });

    it("writes different marker payloads for two generations of the same user", async () => {
        mockScanQueue.getJob
            .mockResolvedValueOnce(jobInState("active"))
            .mockResolvedValueOnce(jobInState("active"))
            .mockResolvedValueOnce(jobInState("active"))
            .mockResolvedValueOnce(jobInState("active"));

        await requestCoalescedLibraryScan("user-shared", "download-queue");
        await requestCoalescedLibraryScan("user-shared", "download-queue");

        const firstStored = mockRedis.set.mock.calls[0]?.[1];
        const secondStored = mockRedis.set.mock.calls[1]?.[1];
        expect(firstStored).toBe(
            JSON.stringify({ userId: "user-shared", nonce: "nonce-1" }),
        );
        expect(secondStored).toBe(
            JSON.stringify({ userId: "user-shared", nonce: "nonce-2" }),
        );
        expect(firstStored).not.toBe(secondStored);
    });

    it("allows two consumers to enqueue idempotently and compare-delete", async () => {
        const stored = JSON.stringify({
            userId: "user-double",
            nonce: "stored-nonce",
        });
        mockRedis.get.mockResolvedValue(stored);
        mockRedis.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
        mockScanQueue.getJob
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValue(jobInState("waiting"));

        await Promise.all([
            consumeCoalescedScanFollowUp(),
            consumeCoalescedScanFollowUp(),
        ]);

        expect(mockScanQueue.add).toHaveBeenCalledTimes(2);
        expect(mockScanQueue.add).toHaveBeenNthCalledWith(
            1,
            "scan",
            { userId: "user-double", source: "coalesced-library-scan" },
            JOB_OPTIONS,
        );
        expect(mockScanQueue.add).toHaveBeenNthCalledWith(
            2,
            "scan",
            { userId: "user-double", source: "coalesced-library-scan" },
            JOB_OPTIONS,
        );
        expect(mockRedis.eval).toHaveBeenCalledTimes(2);
        expect(mockRedis.eval).toHaveBeenNthCalledWith(
            1,
            expect.any(String),
            1,
            FOLLOW_UP_KEY,
            stored,
        );
        expect(mockRedis.eval).toHaveBeenNthCalledWith(
            2,
            expect.any(String),
            1,
            FOLLOW_UP_KEY,
            stored,
        );
    });

    it("performs one bounded request per consumed marker", async () => {
        mockRedis.get.mockResolvedValueOnce(
            JSON.stringify({ userId: "user-once", nonce: "stored-nonce" }),
        );
        mockScanQueue.getJob
            .mockResolvedValueOnce(jobInState("active"))
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(jobInState("active"))
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(jobInState("active"))
            .mockResolvedValueOnce(null);

        await consumeCoalescedScanFollowUp();

        expect(mockScanQueue.getJob).toHaveBeenCalledTimes(6);
        expect(mockScanQueue.add).toHaveBeenCalledTimes(1);
        expect(mockRedis.get).toHaveBeenCalledTimes(1);
        expect(mockRedis.eval).toHaveBeenCalledTimes(4);
    });

    it.each([
        ["a user", "user-round-trip"],
        ["no user", null],
    ])("round-trips %s through the follow-up key", async (_label, userId) => {
        mockScanQueue.getJob
            .mockResolvedValueOnce(jobInState("active"))
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(jobInState("waiting"));

        await requestCoalescedLibraryScan(userId, "download-queue");
        const stored = mockRedis.set.mock.calls[0]?.[1];
        mockRedis.get.mockResolvedValueOnce(stored);
        await consumeCoalescedScanFollowUp();

        expect(stored).toBe(JSON.stringify({ userId, nonce: "nonce-1" }));
        expect(mockScanQueue.add).toHaveBeenCalledWith(
            "scan",
            { userId, source: "coalesced-library-scan" },
            JOB_OPTIONS,
        );
    });

    it.each(["waiting", "delayed"])(
        "consumes the follow-up without adding while a job is %s",
        async (state) => {
            mockRedis.get.mockResolvedValueOnce(
                JSON.stringify({
                    userId: "user-follow-up",
                    nonce: "stored-nonce",
                }),
            );
            mockScanQueue.getJob.mockResolvedValueOnce(jobInState(state));

            await consumeCoalescedScanFollowUp();

            expect(mockRedis.get).toHaveBeenCalledWith(FOLLOW_UP_KEY);
            expect(mockRedis.eval).toHaveBeenCalledTimes(1);
            expect(mockScanQueue.add).not.toHaveBeenCalled();
        },
    );

    it("warns and retains a malformed follow-up payload until expiry", async () => {
        mockRedis.get.mockResolvedValueOnce("not-json");

        await expect(consumeCoalescedScanFollowUp()).resolves.toBeUndefined();

        expect(mockLogger.warn).toHaveBeenCalledWith(
            "Ignoring invalid coalesced library scan follow-up; marker retained until expiry or overwrite",
            { error: expect.any(Error) },
        );
        expect(mockRedis.eval).not.toHaveBeenCalled();
        expect(mockScanQueue.add).not.toHaveBeenCalled();
    });

    it("rejects a legacy follow-up payload without a nonce", async () => {
        mockRedis.get.mockResolvedValueOnce(
            JSON.stringify({ userId: "user-legacy" }),
        );

        await expect(consumeCoalescedScanFollowUp()).resolves.toBeUndefined();

        expect(mockLogger.warn).toHaveBeenCalledWith(
            "Ignoring invalid coalesced library scan follow-up; marker retained until expiry or overwrite",
            { error: expect.any(Error) },
        );
        expect(mockRedis.eval).not.toHaveBeenCalled();
        expect(mockScanQueue.add).not.toHaveBeenCalled();
    });

    it("does nothing when no follow-up flag exists", async () => {
        mockRedis.get.mockResolvedValueOnce(null);

        await consumeCoalescedScanFollowUp();

        expect(mockScanQueue.add).not.toHaveBeenCalled();
    });

    it("warns without rejecting when the Redis read fails", async () => {
        const redisError = new Error("redis unavailable");
        mockRedis.get.mockRejectedValueOnce(redisError);

        await expect(consumeCoalescedScanFollowUp()).resolves.toBeUndefined();

        expect(mockLogger.warn).toHaveBeenCalledWith(
            "Failed to read coalesced library scan follow-up",
            { error: redisError },
        );
        expect(mockScanQueue.add).not.toHaveBeenCalled();
    });
});

describe("coalescedLibraryScan shutdown", () => {
    it("does not resurrect Redis when an in-flight consume deletes after close", async () => {
        const stored = JSON.stringify({
            userId: "user-shutdown",
            nonce: "stored-nonce",
        });
        let resolveAdd!: (value: { id: string }) => void;
        let signalAddStarted!: () => void;
        const addStarted = new Promise<void>((resolve) => {
            signalAddStarted = resolve;
        });
        const pendingAdd = new Promise<{ id: string }>((resolve) => {
            resolveAdd = resolve;
        });
        jest.clearAllMocks();
        mockRedis.eval.mockReset();
        mockRedis.get.mockReset();
        mockRedis.get.mockResolvedValueOnce(stored);
        mockRedis.set.mockResolvedValue("OK");
        mockRedis.quit.mockResolvedValue("OK");
        mockScanQueue.getJob.mockReset();
        mockScanQueue.getJob
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(jobInState("waiting"));
        mockScanQueue.add.mockReset();
        mockScanQueue.add.mockImplementationOnce(() => {
            signalAddStarted();
            return pendingAdd;
        });

        await jest.isolateModulesAsync(async () => {
            const service = await import("../coalescedLibraryScan");
            const consumption = service.consumeCoalescedScanFollowUp();
            await addStarted;

            await service.closeCoalescedLibraryScanRedis();
            resolveAdd({ id: COALESCED_SCAN_JOB_ID });
            await expect(consumption).resolves.toBeUndefined();
            await expect(
                service.consumeCoalescedScanFollowUp(),
            ).resolves.toBeUndefined();
            await service.closeCoalescedLibraryScanRedis();
        });

        expect(mockCreateIORedisClient).toHaveBeenCalledTimes(1);
        expect(mockRedis.quit).toHaveBeenCalledTimes(1);
        expect(mockRedis.set).not.toHaveBeenCalled();
        expect(mockRedis.eval).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledWith(
            "Shutdown in progress; consumed coalesced scan follow-up marker retained for consumption after restart or the next trigger",
            { error: expect.any(Error) },
        );
        expect(mockLogger.warn).toHaveBeenCalledWith(
            "Shutdown in progress; coalesced scan follow-up marker retained for consumption after restart or the next trigger",
            { error: expect.any(Error) },
        );
    });
});
