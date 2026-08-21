const prisma = {
    user: {
        findUnique: jest.fn(),
        count: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
};

jest.mock("../../utils/db", () => ({ prisma }));

const acquireRoleGuardLock = jest.fn();
jest.mock("../../utils/advisoryLocks", () => ({ acquireRoleGuardLock }));

import {
    deleteMarkedUserWithRoleGuard,
    markUserPendingDeletion,
} from "../userDeletion";

describe("administrative user deletion guards", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.$transaction.mockImplementation(async (run) => run(prisma));
        prisma.user.updateMany.mockResolvedValue({ count: 1 });
        prisma.user.deleteMany.mockResolvedValue({ count: 1 });
    });

    it("does not count pending admins when reserving another admin", async () => {
        prisma.user.findUnique.mockResolvedValue({
            role: "admin",
            pendingDeletionAt: null,
        });
        prisma.user.count.mockResolvedValue(0);

        await expect(markUserPendingDeletion("admin-b")).resolves.toBe(
            "lastAdmin",
        );

        expect(prisma.user.count).toHaveBeenCalledWith({
            where: {
                role: "admin",
                id: { not: "admin-b" },
                pendingDeletionAt: null,
            },
        });
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it("clears the marker atomically when final deletion finds the last admin", async () => {
        const pendingDeletionAt = new Date("2026-08-21T12:00:00.000Z");
        prisma.user.findUnique.mockResolvedValue({
            role: "admin",
            pendingDeletionAt,
        });
        prisma.user.count.mockResolvedValue(0);

        await expect(deleteMarkedUserWithRoleGuard("admin-b")).resolves.toBe(
            "lastAdmin",
        );

        expect(prisma.user.count).toHaveBeenCalledWith({
            where: {
                role: "admin",
                id: { not: "admin-b" },
                pendingDeletionAt: null,
            },
        });
        expect(prisma.user.updateMany).toHaveBeenCalledWith({
            where: { id: "admin-b", pendingDeletionAt: { not: null } },
            data: { pendingDeletionAt: null },
        });
        expect(prisma.user.deleteMany).not.toHaveBeenCalled();
    });

    it("returns lastAdmin to both serialized concurrent finalizers", async () => {
        const pendingDeletionAt = new Date("2026-08-21T12:00:00.000Z");
        let marker: Date | null = pendingDeletionAt;
        let transactionTail = Promise.resolve();
        prisma.$transaction.mockImplementation((run) => {
            const result = transactionTail.then(() => run(prisma));
            transactionTail = result.then(
                () => undefined,
                () => undefined,
            );
            return result;
        });
        prisma.user.findUnique.mockImplementation(async () => ({
            role: "admin",
            pendingDeletionAt: marker,
        }));
        prisma.user.count.mockResolvedValue(0);
        prisma.user.updateMany.mockImplementation(async () => {
            if (!marker) return { count: 0 };
            marker = null;
            return { count: 1 };
        });

        await expect(
            Promise.all([
                deleteMarkedUserWithRoleGuard("admin-b"),
                deleteMarkedUserWithRoleGuard("admin-b"),
            ]),
        ).resolves.toEqual(["lastAdmin", "lastAdmin"]);

        expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
        expect(prisma.user.deleteMany).not.toHaveBeenCalled();
    });
});
