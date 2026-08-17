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
const mockLoadSpaceVectorState = jest.fn();
const mockGetActiveSpace = jest.fn();
const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();
const mockSetCoverage = jest.fn();
const mockSetMigrationActive = jest.fn();

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
    getActiveSpace: (...args: unknown[]) => mockGetActiveSpace(...args),
    invalidateActiveSpaceCache: () => mockInvalidate(),
}));

jest.mock("../../metrics", () => ({
    recordVibeSpaceTransition: (...args: unknown[]) =>
        mockRecordTransition(...args),
    setVibeEmbeddingCoverage: (...args: unknown[]) => mockSetCoverage(...args),
    setVibeMigrationActive: (...args: unknown[]) =>
        mockSetMigrationActive(...args),
}));

jest.mock("../vibeEmbeddingCoverage", () => ({
    loadVibeEmbeddingCoverage: (...args: unknown[]) =>
        mockLoadCoverage(...args),
    loadVibeSpaceVectorState: (...args: unknown[]) =>
        mockLoadSpaceVectorState(...args),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        child: () => ({
            debug: jest.fn(),
            info: (...args: unknown[]) => mockLogInfo(...args),
            warn: (...args: unknown[]) => mockLogWarn(...args),
            error: jest.fn(),
        }),
    },
}));

import {
    ANN_INDEX_MIN_VECTOR_COUNT,
    MAX_RETIREMENT_DELETE_BATCHES,
    RETIREMENT_DELETE_BATCH_SIZE,
    annIndexListsForVectorCount,
    retirementDue,
    runEmbeddingSpaceLifecycleCheck,
    shouldBuildAnnIndex,
    shouldCutOver,
    shouldCutOverEmptyActiveSpace,
} from "../embeddingSpaceLifecycle";

const now = new Date("2026-08-16T12:00:00.000Z");
const migrating = {
    id: "space_student_1",
    status: "migrating",
    retiredAt: null,
    cleaningAt: null,
    lastSeenAt: now,
};

const lifecycleConfig = {
    threshold: 0.95,
    retirementGraceDays: 7,
    allowFailed: false,
    currentProviderSpaceId: "space_student_1",
    now: () => now,
};

describe("embedding-space lifecycle decisions", () => {
    it.each([
        [0.9499, 0.95, false],
        [0.95, 0.95, true],
        [1, 0.95, true],
    ])("evaluates coverage %s at threshold %s", (coverage, threshold, due) => {
        expect(shouldCutOver(coverage, threshold)).toBe(due);
    });

    it.each([
        [false, false, true],
        [false, true, false],
        [true, false, false],
        [true, true, false],
    ])(
        "evaluates empty-active-space cutover with hasVectors=%s and hadVectors=%s",
        (hasVectors, hadVectors, due) => {
            expect(shouldCutOverEmptyActiveSpace(hasVectors, hadVectors)).toBe(
                due,
            );
        },
    );

    it("treats the exact grace boundary as due", () => {
        const retiredAt = new Date("2026-08-09T12:00:00.000Z");
        expect(retirementDue(retiredAt, 7, now)).toBe(true);
        expect(
            retirementDue(new Date("2026-08-09T12:00:00.001Z"), 7, now),
        ).toBe(false);
        expect(retirementDue(null, 7, now)).toBe(false);
    });

    it.each([
        [0, false],
        [ANN_INDEX_MIN_VECTOR_COUNT - 1, false],
        [ANN_INDEX_MIN_VECTOR_COUNT, true],
        [ANN_INDEX_MIN_VECTOR_COUNT + 1, true],
    ])("builds an ANN index for %s vectors: %s", (vectorCount, expected) => {
        expect(shouldBuildAnnIndex(vectorCount)).toBe(expected);
    });

    it.each([
        [999, null],
        [1_000, 40],
        [2_499, 40],
        [2_500, 100],
        [5_000, 200],
        [10_000, 224],
    ])("sizes %s vectors into the %s-list band", (rows, lists) => {
        expect(annIndexListsForVectorCount(rows)).toBe(lists);
    });
});

describe("embedding-space lifecycle effects", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        mockUpdateMany.mockResolvedValue({ count: 1 });
        mockFindManySpaces.mockResolvedValue([]);
        mockFindFirst.mockResolvedValue(null);
        mockQueryRaw.mockResolvedValue([]);
        mockEmbeddingCount.mockResolvedValue(0);
        mockLoadCoverage.mockResolvedValue({
            embedded: 0,
            pending: 1,
            failed: 0,
        });
        mockLoadSpaceVectorState.mockResolvedValue({
            hasVectors: true,
            hadVectors: true,
        });
        mockGetActiveSpace.mockResolvedValue({
            id: "space_teacher_1",
            hadVectors: true,
        });
        mockTransaction.mockImplementation(
            async (operation: (tx: unknown) => Promise<unknown>) =>
                operation({
                    embeddingSpace: {
                        updateMany: mockUpdateMany,
                        update: mockUpdate,
                    },
                    trackEmbedding: {
                        findMany: mockEmbeddingFindMany,
                        deleteMany: mockEmbeddingDeleteMany,
                    },
                }),
        );
    });

    it("cuts over a covered migration when the active space has vectors", async () => {
        const order: string[] = [];
        mockFindFirst.mockResolvedValue(migrating);
        mockLoadCoverage.mockResolvedValue({
            embedded: ANN_INDEX_MIN_VECTOR_COUNT,
            pending: 5,
            failed: 5,
        });
        mockEmbeddingCount.mockResolvedValue(ANN_INDEX_MIN_VECTOR_COUNT);
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

        await runEmbeddingSpaceLifecycleCheck(lifecycleConfig);

        expect(order).toEqual(["index", "transaction"]);
        expect(mockLoadSpaceVectorState).toHaveBeenCalledWith(
            "space_teacher_1",
        );
        expect(mockLoadCoverage).toHaveBeenCalledWith("space_student_1");
        expect(mockLogInfo).toHaveBeenCalledWith(
            "Embedding-space migration coverage sampled",
            {
                spaceId: "space_student_1",
                coveragePercent:
                    (ANN_INDEX_MIN_VECTOR_COUNT /
                        (ANN_INDEX_MIN_VECTOR_COUNT + 5)) *
                    100,
                thresholdPercent: 95,
                embedded: ANN_INDEX_MIN_VECTOR_COUNT,
                pending: 5,
                failed: 5,
            },
        );
        expect(mockSetCoverage).toHaveBeenCalledWith({
            embedded: ANN_INDEX_MIN_VECTOR_COUNT,
            pending: 5,
            failed: 5,
        });
        expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
            expect.stringContaining("CREATE INDEX CONCURRENTLY IF NOT EXISTS"),
        );
        expect(mockUpdateMany).toHaveBeenCalledWith({
            where: { status: "active" },
            data: { status: "retired", retiredAt: now },
        });
        expect(mockUpdateMany).toHaveBeenCalledWith({
            where: {
                id: "space_student_1",
                status: "migrating",
                cleaningAt: null,
            },
            data: { status: "active", retiredAt: null, cleaningAt: null },
        });
        expect(mockInvalidate).toHaveBeenCalledTimes(1);
        expect(mockRecordTransition).toHaveBeenCalledWith("cutover");
        expect(mockSetMigrationActive).toHaveBeenCalledWith(false);
        expect(mockLogInfo).toHaveBeenCalledWith(
            "Embedding-space cutover completed",
            {
                spaceId: "space_student_1",
                coverage:
                    ANN_INDEX_MIN_VECTOR_COUNT /
                    (ANN_INDEX_MIN_VECTOR_COUNT + 5),
                failed: 5,
            },
        );
    });

    it("holds a covered migration when its unacknowledged failure tail exceeds tolerance", async () => {
        mockFindFirst.mockResolvedValue(migrating);
        mockLoadCoverage.mockResolvedValue({
            embedded: 95,
            pending: 5,
            failed: 20,
        });

        await runEmbeddingSpaceLifecycleCheck(lifecycleConfig);

        expect(mockTransaction).not.toHaveBeenCalled();
        expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
        expect(mockLogWarn).toHaveBeenCalledWith(
            "Embedding-space cutover held for unacknowledged failures",
            expect.objectContaining({
                spaceId: "space_student_1",
                retryEndpoint: "/api/analysis/vibe/retry",
            }),
        );
    });

    it("allows an operator-acknowledged failure tail to cut over", async () => {
        mockFindFirst.mockResolvedValue(migrating);
        mockLoadCoverage.mockResolvedValue({
            embedded: 95,
            pending: 5,
            failed: 20,
        });

        await runEmbeddingSpaceLifecycleCheck({
            ...lifecycleConfig,
            allowFailed: true,
        });

        expect(mockTransaction).toHaveBeenCalledTimes(1);
        expect(mockRecordTransition).toHaveBeenCalledWith("cutover");
    });

    it("keeps an existing valid partial index", async () => {
        mockFindFirst.mockResolvedValue(migrating);
        mockLoadCoverage.mockResolvedValue({
            embedded: ANN_INDEX_MIN_VECTOR_COUNT,
            pending: 0,
            failed: 0,
        });
        mockEmbeddingCount.mockResolvedValue(ANN_INDEX_MIN_VECTOR_COUNT);
        mockQueryRaw.mockResolvedValue([
            { isValid: true, options: ["lists=40"] },
        ]);

        await runEmbeddingSpaceLifecycleCheck(lifecycleConfig);

        expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
        expect(mockUpdateMany).toHaveBeenCalledWith({
            where: {
                id: "space_student_1",
                status: "migrating",
                cleaningAt: null,
            },
            data: { status: "active", retiredAt: null, cleaningAt: null },
        });
    });

    it("keeps a sub-threshold migration when the active space has vectors", async () => {
        mockFindFirst.mockResolvedValue(migrating);
        mockLoadCoverage.mockResolvedValue({
            embedded: 80,
            pending: 20,
            failed: 10,
        });

        await runEmbeddingSpaceLifecycleCheck(lifecycleConfig);

        expect(mockLoadSpaceVectorState).toHaveBeenCalledWith(
            "space_teacher_1",
        );
        expect(mockLogInfo).toHaveBeenCalledTimes(1);
        expect(mockLogInfo).toHaveBeenCalledWith(
            "Embedding-space migration coverage sampled",
            {
                spaceId: "space_student_1",
                coveragePercent: 80,
                thresholdPercent: 95,
                embedded: 80,
                pending: 20,
                failed: 10,
            },
        );
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
        expect(mockTransaction).not.toHaveBeenCalled();
    });

    it("cuts over immediately when a fresh active space has no vectors", async () => {
        mockFindFirst.mockResolvedValue(migrating);
        mockLoadSpaceVectorState.mockResolvedValue({
            hasVectors: false,
            hadVectors: false,
        });
        mockGetActiveSpace.mockResolvedValue({
            id: "space_teacher_1",
            hadVectors: false,
        });
        mockLoadCoverage.mockResolvedValue({
            embedded: 0,
            pending: 0,
            failed: 0,
        });

        await runEmbeddingSpaceLifecycleCheck(lifecycleConfig);

        expect(mockLoadSpaceVectorState).toHaveBeenCalledWith(
            "space_teacher_1",
        );
        expect(mockLoadCoverage).toHaveBeenCalledWith("space_student_1");
        expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
        expect(mockTransaction).toHaveBeenCalledTimes(1);
        expect(mockInvalidate).toHaveBeenCalledTimes(1);
        expect(mockRecordTransition).toHaveBeenCalledWith("cutover");
        expect(mockLogInfo).toHaveBeenCalledWith(
            "Embedding-space cutover starting because active space has no embedded vectors",
            {
                activeSpaceId: "space_teacher_1",
                migratingSpaceId: "space_student_1",
            },
        );
        expect(mockLogInfo).toHaveBeenCalledWith(
            "Embedding-space cutover completed",
            {
                spaceId: "space_student_1",
                reason: "empty_active_space",
                failed: 0,
            },
        );
    });

    it("does not instant-cut over a wiped active space that previously had vectors", async () => {
        mockFindFirst.mockResolvedValue(migrating);
        mockLoadSpaceVectorState.mockResolvedValue({
            hasVectors: false,
            hadVectors: true,
        });
        mockGetActiveSpace.mockResolvedValue({
            id: "space_teacher_1",
            hadVectors: true,
        });
        mockLoadCoverage.mockResolvedValue({
            embedded: 1,
            pending: 99,
            failed: 4,
        });

        await runEmbeddingSpaceLifecycleCheck(lifecycleConfig);

        expect(mockLoadCoverage).toHaveBeenCalledWith("space_student_1");
        expect(mockTransaction).not.toHaveBeenCalled();
        expect(mockRecordTransition).not.toHaveBeenCalledWith("cutover");
    });

    it("drops and rebuilds an existing invalid partial index once", async () => {
        mockFindFirst.mockResolvedValue(migrating);
        mockLoadCoverage.mockResolvedValue({
            embedded: ANN_INDEX_MIN_VECTOR_COUNT,
            pending: 0,
            failed: 0,
        });
        mockEmbeddingCount.mockResolvedValue(ANN_INDEX_MIN_VECTOR_COUNT);
        mockQueryRaw.mockResolvedValue([
            { isValid: false, options: ["lists=40"] },
        ]);

        await runEmbeddingSpaceLifecycleCheck(lifecycleConfig);

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

    it("builds a missing ANN index after the active space crosses the floor", async () => {
        mockEmbeddingCount.mockResolvedValue(ANN_INDEX_MIN_VECTOR_COUNT);

        await runEmbeddingSpaceLifecycleCheck(lifecycleConfig);

        expect(mockEmbeddingCount).toHaveBeenCalledWith({
            where: { spaceId: "space_teacher_1" },
        });
        expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
            expect.stringContaining("CREATE INDEX CONCURRENTLY IF NOT EXISTS"),
        );
    });

    it("keeps an active space exact below the ANN index floor", async () => {
        mockEmbeddingCount.mockResolvedValue(ANN_INDEX_MIN_VECTOR_COUNT - 1);

        await runEmbeddingSpaceLifecycleCheck(lifecycleConfig);

        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
        expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
    });

    it("rebuilds at most once when the active space crosses a list band", async () => {
        mockEmbeddingCount.mockResolvedValue(2_500);
        mockQueryRaw.mockResolvedValue([
            { isValid: true, options: ["lists=40"] },
        ]);

        await runEmbeddingSpaceLifecycleCheck(lifecycleConfig);

        expect(mockExecuteRawUnsafe).toHaveBeenCalledTimes(2);
        expect(mockExecuteRawUnsafe).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining("DROP INDEX CONCURRENTLY"),
        );
        expect(mockExecuteRawUnsafe).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining("WITH (lists = 100)"),
        );
    });

    it("selects the current provider migration instead of an older abandoned space", async () => {
        mockFindFirst.mockResolvedValue(migrating);
        mockLoadCoverage.mockResolvedValue({
            embedded: 1,
            pending: 0,
            failed: 0,
        });

        await runEmbeddingSpaceLifecycleCheck(lifecycleConfig);

        expect(mockFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    id: "space_student_1",
                    status: "migrating",
                    cleaningAt: null,
                },
            }),
        );
        expect(mockLoadCoverage).toHaveBeenCalledWith("space_student_1");
    });

    it("retires migrations not seen within the configured grace", async () => {
        mockFindFirst.mockResolvedValue(null);

        await runEmbeddingSpaceLifecycleCheck(lifecycleConfig);

        expect(mockUpdateMany).toHaveBeenCalledWith({
            where: {
                status: "migrating",
                id: { not: "space_student_1" },
                lastSeenAt: {
                    lte: new Date("2026-08-09T12:00:00.000Z"),
                },
                cleaningAt: null,
            },
            data: {
                status: "retired",
                retiredAt: now,
            },
        });
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

        await runEmbeddingSpaceLifecycleCheck(lifecycleConfig);

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

        await runEmbeddingSpaceLifecycleCheck(lifecycleConfig);

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
                cleaningAt: now,
            },
            data: { retiredAt: null, cleaningAt: null },
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
        let validationCount = 0;
        mockTransaction.mockImplementation(
            async (operation: (transaction: unknown) => Promise<unknown>) => {
                validationCount += 1;
                return operation({
                    embeddingSpace: {
                        updateMany: jest.fn(async () => ({
                            count: validationCount === 1 ? 1 : 0,
                        })),
                    },
                    trackEmbedding: {
                        findMany: mockEmbeddingFindMany,
                        deleteMany: mockEmbeddingDeleteMany,
                    },
                });
            },
        );

        await runEmbeddingSpaceLifecycleCheck(lifecycleConfig);

        expect(mockEmbeddingDeleteMany).toHaveBeenCalledTimes(1);
        expect(mockEmbeddingFindMany).toHaveBeenCalledTimes(1);
        expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
        expect(mockRecordTransition).not.toHaveBeenCalledWith(
            "retired_cleaned",
        );
    });
});
