const mockFindFirst = jest.fn();
const mockFindManySpaces = jest.fn();
const mockUpdateMany = jest.fn();
const mockUpdate = jest.fn();
const mockTrackCount = jest.fn();
const mockEmbeddingCount = jest.fn();
const mockEmbeddingFindMany = jest.fn();
const mockEmbeddingDeleteMany = jest.fn();
const mockQueryRaw = jest.fn();
const mockExecuteRawUnsafe = jest.fn();
const mockTransaction = jest.fn();
const mockInvalidate = jest.fn();
const mockRecordTransition = jest.fn();
const mockLoadCoverage = jest.fn();
const mockLogInfo = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        embeddingSpace: {
            findFirst: (...args: unknown[]) => mockFindFirst(...args),
            findMany: (...args: unknown[]) => mockFindManySpaces(...args),
            updateMany: (...args: unknown[]) => mockUpdateMany(...args),
            update: (...args: unknown[]) => mockUpdate(...args),
        },
        track: { count: (...args: unknown[]) => mockTrackCount(...args) },
        trackEmbedding: {
            count: (...args: unknown[]) => mockEmbeddingCount(...args),
            findMany: (...args: unknown[]) => mockEmbeddingFindMany(...args),
            deleteMany: (...args: unknown[]) =>
                mockEmbeddingDeleteMany(...args),
        },
        $executeRawUnsafe: (...args: unknown[]) =>
            mockExecuteRawUnsafe(...args),
        $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
        $transaction: (...args: unknown[]) => mockTransaction(...args),
    },
}));

jest.mock("../embeddingSpaces", () => ({
    invalidateActiveSpaceCache: () => mockInvalidate(),
}));

jest.mock("../../metrics", () => ({
    recordVibeSpaceTransition: (...args: unknown[]) =>
        mockRecordTransition(...args),
}));

jest.mock("../vibeEmbeddingCoverage", () => ({
    loadVibeEmbeddingCoverage: (...args: unknown[]) =>
        mockLoadCoverage(...args),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        child: () => ({
            debug: jest.fn(),
            info: (...args: unknown[]) => mockLogInfo(...args),
            warn: jest.fn(),
            error: jest.fn(),
        }),
    },
}));

import {
    MAX_RETIREMENT_DELETE_BATCHES,
    RETIREMENT_DELETE_BATCH_SIZE,
    retirementDue,
    runEmbeddingSpaceLifecycleCheck,
    shouldCutOver,
} from "../embeddingSpaceLifecycle";

const now = new Date("2026-08-16T12:00:00.000Z");
const migrating = {
    id: "space_student_1",
    status: "migrating",
    retiredAt: null,
};

describe("embedding-space lifecycle decisions", () => {
    it.each([
        [0.9499, 0.95, false],
        [0.95, 0.95, true],
        [1, 0.95, true],
    ])("evaluates coverage %s at threshold %s", (coverage, threshold, due) => {
        expect(shouldCutOver(coverage, threshold)).toBe(due);
    });

    it("treats the exact grace boundary as due", () => {
        const retiredAt = new Date("2026-08-09T12:00:00.000Z");
        expect(retirementDue(retiredAt, 7, now)).toBe(true);
        expect(
            retirementDue(new Date("2026-08-09T12:00:00.001Z"), 7, now),
        ).toBe(false);
        expect(retirementDue(null, 7, now)).toBe(false);
    });
});

describe("embedding-space lifecycle effects", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        mockUpdateMany.mockResolvedValue({ count: 1 });
        mockFindManySpaces.mockResolvedValue([]);
        mockFindFirst.mockResolvedValue(null);
        mockQueryRaw.mockResolvedValue([]);
        mockLoadCoverage.mockResolvedValue({
            embedded: 0,
            pending: 1,
            failed: 0,
        });
        mockTransaction.mockImplementation(
            async (operation: (tx: unknown) => Promise<unknown>) =>
                operation({
                    embeddingSpace: {
                        updateMany: mockUpdateMany,
                        update: mockUpdate,
                    },
                }),
        );
    });

    it("builds the index before atomically flipping both spaces", async () => {
        const order: string[] = [];
        mockFindFirst.mockResolvedValue(migrating);
        mockLoadCoverage.mockResolvedValue({
            embedded: 95,
            pending: 5,
            failed: 20,
        });
        mockExecuteRawUnsafe.mockImplementation(async () => {
            order.push("index");
            return 0;
        });
        mockTransaction.mockImplementation(
            async (operation: (tx: unknown) => Promise<unknown>) => {
                order.push("transaction");
                return operation({
                    embeddingSpace: {
                        updateMany: mockUpdateMany,
                        update: mockUpdate,
                    },
                });
            },
        );

        await runEmbeddingSpaceLifecycleCheck({
            threshold: 0.95,
            retirementGraceDays: 7,
            now: () => now,
        });

        expect(order).toEqual(["index", "transaction"]);
        expect(mockLoadCoverage).toHaveBeenCalledWith("space_student_1");
        expect(mockLogInfo).toHaveBeenCalledWith(
            "Embedding-space migration coverage sampled",
            {
                spaceId: "space_student_1",
                coveragePercent: 95,
                thresholdPercent: 95,
            },
        );
        expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
            expect.stringContaining("CREATE INDEX CONCURRENTLY IF NOT EXISTS"),
        );
        expect(mockUpdateMany).toHaveBeenCalledWith({
            where: { status: "active" },
            data: { status: "retired", retiredAt: now },
        });
        expect(mockUpdateMany).toHaveBeenCalledWith({
            where: { id: "space_student_1", status: "migrating" },
            data: { status: "active", retiredAt: null },
        });
        expect(mockInvalidate).toHaveBeenCalledTimes(1);
        expect(mockRecordTransition).toHaveBeenCalledWith("cutover");
    });

    it("keeps an existing valid partial index", async () => {
        mockFindFirst.mockResolvedValue(migrating);
        mockLoadCoverage.mockResolvedValue({
            embedded: 1,
            pending: 0,
            failed: 0,
        });
        mockQueryRaw.mockResolvedValue([{ isValid: true }]);

        await runEmbeddingSpaceLifecycleCheck({
            threshold: 0.95,
            retirementGraceDays: 7,
            now: () => now,
        });

        expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
        expect(mockUpdateMany).toHaveBeenCalledWith({
            where: { id: "space_student_1", status: "migrating" },
            data: { status: "active", retiredAt: null },
        });
    });

    it("logs stalled migration coverage once without starting cutover", async () => {
        mockFindFirst.mockResolvedValue(migrating);
        mockLoadCoverage.mockResolvedValue({
            embedded: 80,
            pending: 20,
            failed: 10,
        });

        await runEmbeddingSpaceLifecycleCheck({
            threshold: 0.95,
            retirementGraceDays: 7,
            now: () => now,
        });

        expect(mockLogInfo).toHaveBeenCalledTimes(1);
        expect(mockLogInfo).toHaveBeenCalledWith(
            "Embedding-space migration coverage sampled",
            {
                spaceId: "space_student_1",
                coveragePercent: 80,
                thresholdPercent: 95,
            },
        );
        expect(mockQueryRaw).not.toHaveBeenCalled();
        expect(mockTransaction).not.toHaveBeenCalled();
    });

    it("drops and rebuilds an existing invalid partial index once", async () => {
        mockFindFirst.mockResolvedValue(migrating);
        mockLoadCoverage.mockResolvedValue({
            embedded: 1,
            pending: 0,
            failed: 0,
        });
        mockQueryRaw.mockResolvedValue([{ isValid: false }]);

        await runEmbeddingSpaceLifecycleCheck({
            threshold: 0.95,
            retirementGraceDays: 7,
            now: () => now,
        });

        expect(mockExecuteRawUnsafe).toHaveBeenCalledTimes(2);
        expect(mockExecuteRawUnsafe).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining("DROP INDEX CONCURRENTLY"),
        );
        expect(mockExecuteRawUnsafe).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining("CREATE INDEX CONCURRENTLY IF NOT EXISTS"),
        );
    });

    it("keeps retirement deletion bounded when every batch is full", async () => {
        mockFindManySpaces.mockResolvedValue([
            {
                id: "space_retired_1",
                status: "retired",
                retiredAt: new Date("2026-08-01T12:00:00.000Z"),
            },
        ]);
        mockEmbeddingFindMany.mockResolvedValue(
            Array.from(
                { length: RETIREMENT_DELETE_BATCH_SIZE },
                (_, index) => ({
                    trackId: `track-${index}`,
                    spaceId: "space_retired_1",
                }),
            ),
        );
        mockEmbeddingDeleteMany.mockResolvedValue({
            count: RETIREMENT_DELETE_BATCH_SIZE,
        });

        await runEmbeddingSpaceLifecycleCheck({
            threshold: 0.95,
            retirementGraceDays: 7,
            now: () => now,
        });

        expect(mockEmbeddingDeleteMany).toHaveBeenCalledTimes(
            MAX_RETIREMENT_DELETE_BATCHES,
        );
        expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
        expect(mockRecordTransition).not.toHaveBeenCalledWith(
            "retired_cleaned",
        );
    });

    it("deletes due vectors in batches before dropping the partial index", async () => {
        const retiredAt = new Date("2026-08-01T12:00:00.000Z");
        mockFindManySpaces.mockResolvedValue([
            { id: "space_retired_1", status: "retired", retiredAt },
        ]);
        mockEmbeddingFindMany
            .mockResolvedValueOnce([
                { trackId: "track-1", spaceId: "space_retired_1" },
                { trackId: "track-2", spaceId: "space_retired_1" },
            ])
            .mockResolvedValueOnce([]);
        mockEmbeddingDeleteMany.mockResolvedValue({ count: 2 });

        await runEmbeddingSpaceLifecycleCheck({
            threshold: 0.95,
            retirementGraceDays: 7,
            now: () => now,
        });

        expect(mockEmbeddingDeleteMany).toHaveBeenCalledTimes(1);
        expect(mockEmbeddingDeleteMany).toHaveBeenCalledWith({
            where: {
                spaceId: "space_retired_1",
                trackId: { in: ["track-1", "track-2"] },
            },
        });
        expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
            expect.stringContaining("DROP INDEX CONCURRENTLY IF EXISTS"),
        );
        expect(mockUpdateMany).toHaveBeenCalledWith({
            where: {
                id: "space_retired_1",
                status: "retired",
                retiredAt,
            },
            data: { retiredAt: null },
        });
        expect(mockRecordTransition).toHaveBeenCalledWith("retired_cleaned");
    });

    it("stops retirement deletion when the space is restored between batches", async () => {
        const retiredAt = new Date("2026-08-01T12:00:00.000Z");
        const fullBatch = Array.from(
            { length: RETIREMENT_DELETE_BATCH_SIZE },
            (_, index) => ({
                trackId: `track-${index}`,
                spaceId: "space_retired_1",
            }),
        );
        mockFindManySpaces.mockResolvedValue([
            { id: "space_retired_1", status: "retired", retiredAt },
        ]);
        mockEmbeddingFindMany.mockResolvedValue(fullBatch);
        mockEmbeddingDeleteMany.mockResolvedValue({
            count: RETIREMENT_DELETE_BATCH_SIZE,
        });
        mockUpdateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });

        await runEmbeddingSpaceLifecycleCheck({
            threshold: 0.95,
            retirementGraceDays: 7,
            now: () => now,
        });

        expect(mockEmbeddingDeleteMany).toHaveBeenCalledTimes(1);
        expect(mockEmbeddingFindMany).toHaveBeenCalledTimes(1);
        expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
        expect(mockRecordTransition).not.toHaveBeenCalledWith(
            "retired_cleaned",
        );
    });
});
