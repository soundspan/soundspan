import type { Namespace } from "socket.io";

const prisma = {
    syncGroup: { findMany: jest.fn() },
};

jest.mock("../../utils/db", () => ({ prisma }));
jest.mock("../listenTogetherMutationLock", () => ({
    withLocalGroupMutationBoundary: async <T>(
        _groupId: string,
        operation: () => Promise<T>,
    ) => operation(),
}));

import {
    createSocketMembershipReconciliationHandler,
    type SocketMembershipReconciliationDependencies,
} from "../listenTogetherSocketReconciliation";
import { createUserRevocationHandler } from "../listenTogetherSocketRevocation";

function socket(userId: string, groupId: string) {
    return {
        data: { userId, groupId },
        emit: jest.fn(),
        leave: jest.fn(async () => undefined),
    };
}

function scope(timeoutMs: number = 1_000) {
    return {
        signal: new AbortController().signal,
        deadlineAtMs: Date.now() + timeoutMs,
    };
}

describe("Listen Together reconnect membership reconciliation", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it("evicts a socket after a missed membership event without disturbing valid sockets", async () => {
        const deleted = socket("deleted-user", "group-1");
        const valid = socket("valid-user", "group-1");
        const namespace = {
            sockets: new Map([
                ["deleted-socket", deleted],
                ["valid-socket", valid],
            ]),
        } as unknown as Namespace;
        prisma.syncGroup.findMany.mockResolvedValueOnce([
            {
                id: "group-1",
                isActive: true,
                hostUserId: "valid-user",
                membershipFence: 8n,
                members: [
                    {
                        userId: "valid-user",
                        joinedAt: new Date("2026-08-21T12:00:00.000Z"),
                        user: { username: "valid", displayName: null },
                    },
                ],
            },
        ]);
        const recoverAuthority = jest.fn(async () => undefined);
        const revokeUser = createUserRevocationHandler(namespace, jest.fn());
        const dependencies: SocketMembershipReconciliationDependencies = {
            recoverAuthority,
            revokeUser,
        };

        await createSocketMembershipReconciliationHandler(
            namespace,
            dependencies,
        )(scope());

        expect(prisma.syncGroup.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                select: expect.objectContaining({
                    members: expect.objectContaining({
                        where: expect.objectContaining({
                            OR: [
                                {
                                    syncGroupId: "group-1",
                                    userId: "deleted-user",
                                },
                                {
                                    syncGroupId: "group-1",
                                    userId: "valid-user",
                                },
                            ],
                        }),
                    }),
                }),
            }),
        );
        expect(deleted.leave).toHaveBeenCalledWith("group-1");
        expect(deleted.data.groupId).toBeNull();
        expect(valid.leave).not.toHaveBeenCalled();
        expect(valid.data.groupId).toBe("group-1");
        expect(recoverAuthority).not.toHaveBeenCalled();
    });

    it("uses bounded database batches and leaves every valid socket attached", async () => {
        const sockets = Array.from({ length: 251 }, (_value, index) => {
            const id = index.toString().padStart(3, "0");
            return [
                `socket-${id}`,
                socket(`user-${id}`, `group-${id}`),
            ] as const;
        });
        const namespace = { sockets: new Map(sockets) } as unknown as Namespace;
        prisma.syncGroup.findMany.mockImplementation(async ({ where }) =>
            where.id.in.map((groupId: string) => {
                const id = groupId.slice("group-".length);
                return {
                    id: groupId,
                    isActive: true,
                    hostUserId: `user-${id}`,
                    membershipFence: 1n,
                    members: [
                        {
                            userId: `user-${id}`,
                            joinedAt: new Date("2026-08-21T12:00:00.000Z"),
                            user: { username: `user-${id}`, displayName: null },
                        },
                    ],
                };
            }),
        );
        const dependencies: SocketMembershipReconciliationDependencies = {
            recoverAuthority: jest.fn(async () => undefined),
            revokeUser: createUserRevocationHandler(namespace, jest.fn()),
        };

        await createSocketMembershipReconciliationHandler(
            namespace,
            dependencies,
        )(scope());

        expect(prisma.syncGroup.findMany).toHaveBeenCalledTimes(3);
        for (const [query] of prisma.syncGroup.findMany.mock.calls) {
            expect(query.select.members.where.OR.length).toBeLessThanOrEqual(
                100,
            );
            expect(query.select.members.take).toBe(101);
        }
        expect(
            sockets.every(([, current]) => current.data.groupId !== null),
        ).toBe(true);
    });

    it("keeps a stalled database batch pending until raw settlement", async () => {
        jest.useFakeTimers();
        const namespace = {
            sockets: new Map([["socket-1", socket("user-1", "group-1")]]),
        } as unknown as Namespace;
        let releaseQuery: (rows: []) => void = () => undefined;
        const stalledQuery = new Promise<[]>((resolve) => {
            releaseQuery = resolve;
        });
        prisma.syncGroup.findMany.mockReturnValueOnce(stalledQuery);
        const dependencies: SocketMembershipReconciliationDependencies = {
            recoverAuthority: jest.fn(async () => undefined),
            revokeUser: jest.fn(() => jest.fn()),
        };
        const controller = new AbortController();
        const audit = createSocketMembershipReconciliationHandler(
            namespace,
            dependencies,
        )({ signal: controller.signal, deadlineAtMs: Date.now() + 100 });
        let outcome = "pending";
        void audit.then(
            () => {
                outcome = "resolved";
            },
            () => {
                outcome = "rejected";
            },
        );
        setTimeout(() => {
            controller.abort(new Error("Reconnect audit deadline expired"));
        }, 100);

        await jest.advanceTimersByTimeAsync(100);
        expect(outcome).toBe("pending");

        releaseQuery([]);
        await expect(audit).rejects.toThrow("Reconnect audit deadline expired");
        expect(outcome).toBe("rejected");
    });
});
