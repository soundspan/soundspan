import type { Prisma } from "@prisma/client";
import {
    advanceSyncGroupMembershipFence,
    withSyncGroupMembershipFence,
} from "../listenTogetherMembershipFence";

function transactionClient(updateMany: jest.Mock): Prisma.TransactionClient {
    return {
        syncGroup: { updateMany },
    } as unknown as Prisma.TransactionClient;
}

describe("Listen Together PostgreSQL membership fence", () => {
    it("does not persist a resettable fully-local fencing token", async () => {
        const updateMany = jest.fn();

        await advanceSyncGroupMembershipFence(
            transactionClient(updateMany),
            "group-local",
            {
                fencingToken: 1,
                requiresMembershipFence: false,
                isFenced: () => false,
            },
        );

        expect(updateMany).not.toHaveBeenCalled();
    });

    it("rejects a durable token that cannot advance the group fence", async () => {
        const updateMany = jest.fn(async () => ({ count: 0 }));

        await expect(
            advanceSyncGroupMembershipFence(
                transactionClient(updateMany),
                "group-stale",
                {
                    fencingToken: 4,
                    requiresMembershipFence: true,
                    isFenced: () => false,
                },
            ),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(updateMany).toHaveBeenCalledWith({
            where: { id: "group-stale", membershipFence: { lt: 4n } },
            data: { membershipFence: 4n },
        });
    });

    it("rejects a lease lost before the transaction without advancing or writing", async () => {
        const updateMany = jest.fn(async () => ({ count: 1 }));
        const write = jest.fn(async () => undefined);

        await expect(
            withSyncGroupMembershipFence(
                transactionClient(updateMany),
                "group-expired",
                {
                    fencingToken: 5,
                    requiresMembershipFence: true,
                    isFenced: () => true,
                },
                write,
            ),
        ).rejects.toMatchObject({ code: "CONFLICT" });

        expect(updateMany).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });

    it("rejects a lease lost during the transaction after running its writes", async () => {
        const updateMany = jest.fn(async () => ({ count: 1 }));
        let fenced = false;
        const write = jest.fn(async () => {
            fenced = true;
            return "staged";
        });

        await expect(
            withSyncGroupMembershipFence(
                transactionClient(updateMany),
                "group-expired",
                {
                    fencingToken: 6,
                    requiresMembershipFence: true,
                    isFenced: () => fenced,
                },
                write,
            ),
        ).rejects.toMatchObject({ code: "CONFLICT" });

        expect(updateMany).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledTimes(1);
    });

    it("validates external authority before fence advance and after writes", async () => {
        const updateMany = jest.fn(async () => ({ count: 1 }));
        const assertCurrent = jest.fn(async () => undefined);

        await expect(
            withSyncGroupMembershipFence(
                transactionClient(updateMany),
                "group-current",
                {
                    fencingToken: 7,
                    requiresMembershipFence: true,
                    isFenced: () => false,
                    assertCurrent,
                },
                async () => "committed",
            ),
        ).resolves.toBe("committed");

        expect(assertCurrent).toHaveBeenCalledTimes(2);
    });
});
