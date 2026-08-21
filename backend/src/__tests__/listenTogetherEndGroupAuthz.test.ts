/**
 * Authorization contract for ending a Listen Together group.
 *
 * `endGroup` must enforce host authorization even when the group is NOT
 * present in the in-memory GroupManager (e.g. after a restart or on a
 * different API pod). Previously the host check lived only inside
 * `groupManager.endGroup`, so any authenticated user could end any group
 * that had not been hydrated into local memory.
 */

export {};

const mockSyncGroupFindUnique = jest.fn();
const mockSyncGroupUpdate = jest.fn(async () => undefined);
const mockSyncGroupMemberUpdateMany = jest.fn(async () => undefined);
const mockTransaction = jest.fn();

// The mutation-lock module evaluates config at import; disable the Redis
// lock so this suite needs no environment.
jest.mock("../config", () => ({
    config: {
        listenTogether: {
            mutationLockEnabled: false,
            publicationDeadlineMs: 750,
        },
    },
}));

jest.mock("../utils/db", () => ({
    prisma: {
        syncGroup: {
            findUnique: mockSyncGroupFindUnique,
            update: mockSyncGroupUpdate,
        },
        syncGroupMember: {
            updateMany: mockSyncGroupMemberUpdateMany,
        },
        $transaction: mockTransaction,
    },
}));

jest.mock("../utils/logger", () => {
    const childLogger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    };
    return {
        logger: {
            ...childLogger,
            child: jest.fn(() => childLogger),
        },
    };
});

jest.mock("../services/trackMappingService", () => ({
    trackMappingService: {},
}));

const mockDeleteSnapshot = jest.fn(async () => undefined);
jest.mock("../services/listenTogetherStateStore", () => ({
    listenTogetherStateStore: {
        getSnapshot: jest.fn(async () => null),
        setSnapshot: jest.fn(async () => undefined),
        deleteSnapshot: mockDeleteSnapshot,
    },
}));

import { endGroup } from "../services/listenTogether";
import { groupManager } from "../services/listenTogetherManager";

const GROUP_ID = "group-authz-test";
const HOST_ID = "host-user";
const OTHER_ID = "not-the-host";

describe("endGroup host authorization", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockTransaction.mockImplementation(async (operation: any) =>
            operation({
                syncGroup: {
                    findUnique: mockSyncGroupFindUnique,
                    update: mockSyncGroupUpdate,
                },
                syncGroupMember: {
                    updateMany: mockSyncGroupMemberUpdateMany,
                },
            }),
        );
        // Guarantee the group is not in local memory for the DB-path tests.
        groupManager.remove(GROUP_ID);
    });

    it("rejects a non-host caller when the group is not in local memory", async () => {
        mockSyncGroupFindUnique.mockResolvedValue({
            hostUserId: HOST_ID,
            isActive: true,
        });

        await expect(endGroup(OTHER_ID, GROUP_ID)).rejects.toMatchObject({
            code: "NOT_ALLOWED",
        });

        // The group must not be ended in the DB nor its snapshot dropped.
        expect(mockTransaction).toHaveBeenCalledTimes(1);
        expect(mockSyncGroupUpdate).not.toHaveBeenCalled();
        expect(mockDeleteSnapshot).not.toHaveBeenCalled();
    });

    it("rejects with NOT_FOUND when the group does not exist", async () => {
        mockSyncGroupFindUnique.mockResolvedValue(null);

        await expect(endGroup(HOST_ID, GROUP_ID)).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
        expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it("rejects with NOT_FOUND when the group is already inactive", async () => {
        mockSyncGroupFindUnique.mockResolvedValue({
            hostUserId: HOST_ID,
            isActive: false,
        });

        await expect(endGroup(HOST_ID, GROUP_ID)).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
        expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it("lets the host end a group that is not in local memory", async () => {
        mockSyncGroupFindUnique.mockResolvedValue({
            hostUserId: HOST_ID,
            isActive: true,
        });

        await expect(endGroup(HOST_ID, GROUP_ID)).resolves.toBeUndefined();

        expect(mockTransaction).toHaveBeenCalledTimes(1);
        expect(mockDeleteSnapshot).toHaveBeenCalledWith(
            GROUP_ID,
            expect.any(Number),
        );
    });

    it("still rejects a non-host caller when the group IS in local memory", async () => {
        groupManager.hydrate(GROUP_ID, {
            name: "test group",
            joinCode: "ABC234",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: HOST_ID,
            queue: [],
            currentIndex: 0,
            isPlaying: false,
            currentTimeMs: 0,
            stateVersion: 1,
            createdAt: new Date(),
            members: [
                {
                    userId: HOST_ID,
                    username: "host",
                    isHost: true,
                    joinedAt: new Date(),
                },
                {
                    userId: OTHER_ID,
                    username: "member",
                    isHost: false,
                    joinedAt: new Date(),
                },
            ],
        });

        try {
            await expect(endGroup(OTHER_ID, GROUP_ID)).rejects.toMatchObject({
                code: "NOT_ALLOWED",
            });
            expect(mockTransaction).toHaveBeenCalledTimes(1);
        } finally {
            groupManager.remove(GROUP_ID);
        }
    });
});
