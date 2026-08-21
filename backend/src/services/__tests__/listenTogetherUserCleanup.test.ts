let hostedRecords = [
    {
        id: "hosted-1",
        hostUserId: "deleted-host",
        isActive: true,
        cleanupPublicationPending: false,
    },
    {
        id: "hosted-2",
        hostUserId: "deleted-host",
        isActive: true,
        cleanupPublicationPending: false,
    },
];

const prisma = {
    syncGroup: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
    },
    syncGroupMember: {
        findMany: jest.fn(async (_query: Record<string, any>) => [] as any[]),
        updateMany: jest.fn(),
    },
};
const endGroupAdmitted = jest.fn();
const leaveGroupAdmitted = jest.fn();
const revokeLocalUser = jest.fn();
const publishUserRevocation = jest.fn(async () => undefined);
const withListenTogetherMutationAdmission = jest.fn(
    async (_name: string, operation: () => Promise<void>) => operation(),
);

jest.mock("../../utils/db", () => ({ prisma }));
jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn() }) },
}));
jest.mock("../listenTogether", () => ({
    endGroupAdmitted,
    leaveGroupAdmitted,
}));
jest.mock("../listenTogetherClusterSync", () => ({
    listenTogetherClusterSync: {
        revokeLocalUser,
        publishUserRevocation,
    },
}));
jest.mock("../listenTogetherMutationAdmission", () => ({
    withListenTogetherMutationAdmission,
}));
jest.mock("../listenTogetherUserQuiescence", () => ({
    quiesceListenTogetherUserGroups: jest.fn(async () => undefined),
}));

import { cleanupListenTogetherForUser } from "../listenTogetherUserCleanup";

function matchesHostedPendingPredicate(
    where: Record<string, unknown>,
    record: (typeof hostedRecords)[number],
): boolean {
    if (!Array.isArray(where.OR)) return true;
    return where.OR.some((predicate) => {
        if (predicate.isActive === true) return record.isActive;
        if (predicate.cleanupPublicationPending === true) {
            return record.cleanupPublicationPending;
        }
        return false;
    });
}

function paginateHostedRecords(query: Record<string, any>) {
    const { where } = query;
    const matching = hostedRecords
        .filter((record) => record.hostUserId === where.hostUserId)
        .filter((record) => matchesHostedPendingPredicate(where, record))
        .filter((record) => !where.id?.gt || record.id > where.id.gt);
    const skipped = query.cursor ? matching.slice(query.skip ?? 0) : matching;
    return skipped.slice(0, query.take);
}

describe("Listen Together user cleanup convergence", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        hostedRecords = [
            {
                id: "hosted-1",
                hostUserId: "deleted-host",
                isActive: true,
                cleanupPublicationPending: false,
            },
            {
                id: "hosted-2",
                hostUserId: "deleted-host",
                isActive: true,
                cleanupPublicationPending: false,
            },
        ];
        jest.clearAllMocks();
        prisma.syncGroup.findMany.mockImplementation(async (query) =>
            paginateHostedRecords(query).map((record) => ({
                id: record.id,
                isActive: record.isActive,
                cleanupPublicationPending: record.cleanupPublicationPending,
            })),
        );
        prisma.syncGroup.updateMany.mockImplementation(
            async ({ where, data }) => {
                const record = hostedRecords.find(({ id }) => id === where.id);
                if (!record || !record.cleanupPublicationPending) {
                    return { count: 0 };
                }
                record.cleanupPublicationPending =
                    data.cleanupPublicationPending;
                return { count: 1 };
            },
        );
        endGroupAdmitted.mockImplementation(async (_userId, groupId) => {
            const record = hostedRecords.find(({ id }) => id === groupId);
            if (!record) throw new Error(`Missing hosted record ${groupId}`);
            record.isActive = false;
            record.cleanupPublicationPending = true;
        });
        revokeLocalUser.mockImplementation(async ({ groupIds }) => {
            if (groupIds === "all-for-user") return;
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 6_000);
            });
        });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("resumes after a deadline and excludes completed history on the next scan", async () => {
        const firstCleanup = cleanupListenTogetherForUser("deleted-host");
        const firstOutcome = firstCleanup.then(
            () => "resolved" as const,
            () => "rejected" as const,
        );
        await jest.advanceTimersByTimeAsync(10_000);
        expect(await firstOutcome).toBe("rejected");
        await jest.advanceTimersByTimeAsync(2_000);

        const secondCleanup = cleanupListenTogetherForUser("deleted-host");
        const secondOutcome = secondCleanup.then(
            () => "resolved" as const,
            () => "rejected" as const,
        );
        await jest.advanceTimersByTimeAsync(10_000);
        expect(await secondOutcome).toBe("resolved");
        await jest.advanceTimersByTimeAsync(2_000);

        const mutationCount = endGroupAdmitted.mock.calls.length;
        await expect(
            cleanupListenTogetherForUser("deleted-host"),
        ).resolves.toBeUndefined();

        expect(endGroupAdmitted).toHaveBeenCalledTimes(mutationCount);
        expect(prisma.syncGroup.findMany).toHaveBeenLastCalledWith({
            where: {
                hostUserId: "deleted-host",
                OR: [{ isActive: true }, { cleanupPublicationPending: true }],
            },
            select: {
                id: true,
                isActive: true,
                cleanupPublicationPending: true,
            },
            orderBy: { id: "asc" },
            take: 250,
        });
    });

    it("processes the 251st hosted group when completed rows leave the predicate", async () => {
        jest.useRealTimers();
        hostedRecords = Array.from({ length: 251 }, (_value, index) => ({
            id: `hosted-${index.toString().padStart(3, "0")}`,
            hostUserId: "deleted-host",
            isActive: true,
            cleanupPublicationPending: false,
        }));
        revokeLocalUser.mockResolvedValue(undefined);

        await expect(
            cleanupListenTogetherForUser("deleted-host"),
        ).resolves.toBeUndefined();

        expect(endGroupAdmitted).toHaveBeenCalledTimes(251);
        expect(endGroupAdmitted).toHaveBeenLastCalledWith(
            "deleted-host",
            "hosted-250",
            true,
            expect.any(Object),
        );
        expect(prisma.syncGroup.findMany).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                where: expect.objectContaining({
                    id: { gt: "hosted-249" },
                }),
            }),
        );
        expect(prisma.syncGroup.findMany.mock.calls[1][0]).not.toEqual(
            expect.objectContaining({ cursor: expect.anything(), skip: 1 }),
        );
    });

    it("processes the 251st membership when completed rows leave the predicate", async () => {
        jest.useRealTimers();
        hostedRecords = [];
        const memberships = Array.from({ length: 251 }, (_value, index) => ({
            id: `membership-${index.toString().padStart(3, "0")}`,
            syncGroupId: `joined-${index.toString().padStart(3, "0")}`,
            userId: "deleted-member",
            leftAt: null as Date | null,
            cleanupPublicationPending: false,
        }));
        prisma.syncGroupMember.findMany.mockImplementation(async (query) => {
            const matching = memberships
                .filter((record) => record.userId === query.where.userId)
                .filter(
                    (record) =>
                        record.leftAt === null ||
                        record.cleanupPublicationPending,
                )
                .filter(
                    (record) =>
                        !query.where.id?.gt || record.id > query.where.id.gt,
                );
            const skipped = query.cursor
                ? matching.slice(query.skip ?? 0)
                : matching;
            return skipped.slice(0, query.take).map((record) => ({
                id: record.id,
                syncGroupId: record.syncGroupId,
                leftAt: record.leftAt,
                cleanupPublicationPending: record.cleanupPublicationPending,
                syncGroup: { isActive: true },
            }));
        });
        leaveGroupAdmitted.mockImplementation(async (_userId, groupId) => {
            const record = memberships.find(
                ({ syncGroupId }) => syncGroupId === groupId,
            );
            if (!record) throw new Error(`Missing membership for ${groupId}`);
            record.leftAt = new Date();
            record.cleanupPublicationPending = true;
        });
        prisma.syncGroupMember.updateMany.mockImplementation(
            async ({ where, data }) => {
                const record = memberships.find(({ id }) => id === where.id);
                if (!record || !record.cleanupPublicationPending) {
                    return { count: 0 };
                }
                record.cleanupPublicationPending =
                    data.cleanupPublicationPending;
                return { count: 1 };
            },
        );
        revokeLocalUser.mockResolvedValue(undefined);

        await expect(
            cleanupListenTogetherForUser("deleted-member"),
        ).resolves.toBeUndefined();

        expect(leaveGroupAdmitted).toHaveBeenCalledTimes(251);
        expect(leaveGroupAdmitted).toHaveBeenLastCalledWith(
            "deleted-member",
            "joined-250",
            true,
            expect.any(Object),
        );
        expect(prisma.syncGroupMember.findMany).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                where: expect.objectContaining({
                    id: { gt: "membership-249" },
                }),
            }),
        );
        expect(prisma.syncGroupMember.findMany.mock.calls[1][0]).not.toEqual(
            expect.objectContaining({ cursor: expect.anything(), skip: 1 }),
        );
    });
});
