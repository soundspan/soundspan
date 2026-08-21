import type { GroupMutationFence } from "../src/services/listenTogetherLeaseFencing";
import type { ListenTogetherClusterSync } from "../src/services/listenTogetherClusterSync";

type ListenTogetherClusterSyncStub = {
    [Key in keyof ListenTogetherClusterSync]: ListenTogetherClusterSync[Key];
};

interface ControllableFence extends GroupMutationFence {
    postWriteValidationStarted: Promise<void>;
    loseLease(): void;
}

let mockActiveFence: ControllableFence | null = null;
interface OperationGate {
    started: Promise<void>;
    markStarted(): void;
    released: Promise<void>;
    release(): void;
}

let mockOperationGate: OperationGate | null = null;
const mockLocalMutationTails = new Map<string, Promise<void>>();

jest.mock("../src/services/listenTogetherMutationLock", () => ({
    withGroupMutationLock: async <T>(
        _groupId: string,
        _operationName: string,
        operation: (fence: GroupMutationFence) => Promise<T>,
    ): Promise<T> => {
        if (!mockActiveFence) throw new Error("No controlled fence installed");
        const previous =
            mockLocalMutationTails.get(_groupId) ?? Promise.resolve();
        let releaseTail: () => void = () => undefined;
        const current = new Promise<void>((resolve) => {
            releaseTail = resolve;
        });
        const tail = previous.then(() => current);
        mockLocalMutationTails.set(_groupId, tail);
        try {
            await previous;
            if (mockOperationGate) {
                const gate = mockOperationGate;
                gate.markStarted();
                await gate.released;
            }
            return await operation(mockActiveFence);
        } finally {
            releaseTail();
            if (mockLocalMutationTails.get(_groupId) === tail) {
                mockLocalMutationTails.delete(_groupId);
            }
        }
    },
    drainLocalGroupMutationTails: async (
        groupIds: readonly string[],
        deadlineAtMs: number,
    ) => {
        const tails = groupIds
            .map((groupId) => mockLocalMutationTails.get(groupId))
            .filter((tail): tail is Promise<void> => tail !== undefined);
        await Promise.allSettled(tails);
        return {
            drained: Date.now() <= deadlineAtMs,
            deadlineAtMs,
            remainingMs: Math.max(0, deadlineAtMs - Date.now()),
        };
    },
    releaseLocalGroupMutationState: jest.fn(),
    withLocalGroupMutationBoundary: async <T>(
        _groupId: string,
        operation: () => Promise<T>,
    ): Promise<T> => operation(),
}));

jest.mock("../src/services/listenTogetherStateStore", () => ({
    listenTogetherStateStore: {
        getSnapshot: jest.fn(async () => null),
        setSnapshot: jest.fn(async () => "accepted"),
        deleteSnapshot: jest.fn(async () => "accepted"),
        claimFence: jest.fn(async () => "accepted"),
    },
}));

jest.mock("../src/services/listenTogetherClusterSync", () => ({
    listenTogetherClusterSync: {
        isEnabled: jest.fn(() => false),
        start: jest.fn(async () => undefined),
        revokeLocalUser: jest.fn(async () => undefined),
        publishSnapshot: jest.fn(async () => undefined),
        publishMembership: jest.fn(async () => undefined),
        publishEnded: jest.fn(async () => undefined),
        publishUserRevocation: jest.fn(async () => undefined),
        stop: jest.fn(async () => undefined),
    } satisfies ListenTogetherClusterSyncStub,
}));

// Keep the transaction's second lease check as this suite's only fence wait.
// Publication has its own fence checks, after PostgreSQL has already committed.
jest.mock("../src/services/listenTogetherCallbacks", () => ({
    enqueueGroupEndedPublication: jest.fn(async () => undefined),
    enqueueGroupMembershipPublication: jest.fn(async () => undefined),
    enqueueGroupSnapshotPublication: jest.fn(async () => undefined),
    flushGroupPublications: jest.fn(async () => undefined),
}));

import { Client } from "pg";
import { prisma } from "../src/utils/db";
import {
    createGroup,
    endGroup,
    joinGroup,
    leaveGroup,
} from "../src/services/listenTogether";
import { cleanupListenTogetherForUser } from "../src/services/listenTogetherUserCleanup";
import { enqueueGroupSnapshotPublication } from "../src/services/listenTogetherCallbacks";
import { listenTogetherStateStore } from "../src/services/listenTogetherStateStore";
import { markUserPendingDeletion } from "../src/services/userDeletion";
import { withSyncGroupMembershipFence } from "../src/services/listenTogetherMembershipFence";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && databaseName ? describe : describe.skip;

const GROUP_ID = "listen-together-fence-group";
const HOST_ID = "listen-together-fence-host";
const DEPARTING_ID = "listen-together-fence-departing";
const JOINING_ID = "listen-together-fence-joining";
const PUBLIC_GROUP_ID = "listen-together-public-fence-group";
const PUBLIC_HOST_ID = "listen-together-public-fence-host";
const PUBLIC_DEPARTING_ID = "listen-together-public-fence-departing";
const PUBLIC_JOINING_ID = "listen-together-public-fence-joining";
const PUBLIC_JOIN_CODE = "PUB007";
const DELETION_USER_ID = "listen-together-deletion-user";
const ROLE_GUARD_LOCK_KEY = "8025773003692380079";

function operationGate(): OperationGate {
    let markStarted: () => void = () => undefined;
    let releaseOperation: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
        releaseOperation = resolve;
    });
    return {
        started,
        markStarted,
        released,
        release: releaseOperation,
    };
}

function fence(fencingToken: number) {
    return {
        fencingToken,
        requiresMembershipFence: true,
        isFenced: () => false,
    };
}

function controllableFence(fencingToken: number): ControllableFence {
    let stale = false;
    let validationCount = 0;
    let markPostWriteValidationStarted: () => void = () => undefined;
    let releasePostWriteValidation: () => void = () => undefined;
    const postWriteValidationStarted = new Promise<void>((resolve) => {
        markPostWriteValidationStarted = resolve;
    });
    const postWriteValidationGate = new Promise<void>((resolve) => {
        releasePostWriteValidation = resolve;
    });
    return {
        fencingToken,
        requiresMembershipFence: true,
        isFenced: () => stale,
        assertCurrent: async () => {
            validationCount += 1;
            if (validationCount !== 2) return;
            markPostWriteValidationStarted();
            await postWriteValidationGate;
        },
        postWriteValidationStarted,
        loseLease: () => {
            stale = true;
            releasePostWriteValidation();
        },
    };
}

function unblockedFence(fencingToken: number): ControllableFence {
    return {
        fencingToken,
        requiresMembershipFence: false,
        isFenced: () => false,
        assertCurrent: async () => undefined,
        postWriteValidationStarted: Promise.resolve(),
        loseLease: () => undefined,
    };
}

async function seedGroup(): Promise<void> {
    await prisma.user.createMany({
        data: [
            HOST_ID,
            DEPARTING_ID,
            JOINING_ID,
            PUBLIC_HOST_ID,
            PUBLIC_DEPARTING_ID,
            PUBLIC_JOINING_ID,
            DELETION_USER_ID,
        ].map((id) => ({ id, username: id })),
    });
    await prisma.syncGroup.create({
        data: {
            id: GROUP_ID,
            joinCode: "FENCE5",
            hostUserId: HOST_ID,
            members: {
                create: [
                    { userId: HOST_ID, isHost: true },
                    { userId: DEPARTING_ID },
                ],
            },
        },
    });
    await prisma.syncGroup.create({
        data: {
            id: PUBLIC_GROUP_ID,
            joinCode: PUBLIC_JOIN_CODE,
            hostUserId: PUBLIC_HOST_ID,
            members: {
                create: [
                    { userId: PUBLIC_HOST_ID, isHost: true },
                    { userId: PUBLIC_DEPARTING_ID },
                ],
            },
        },
    });
}

async function resetPublicBoundaryGroup(): Promise<void> {
    await prisma.user.update({
        where: { id: PUBLIC_DEPARTING_ID },
        data: { pendingDeletionAt: null },
    });
    await prisma.syncGroupMember.deleteMany({
        where: { syncGroupId: PUBLIC_GROUP_ID },
    });
    await prisma.syncGroup.update({
        where: { id: PUBLIC_GROUP_ID },
        data: {
            hostUserId: PUBLIC_HOST_ID,
            isActive: true,
            endedAt: null,
            isPlaying: false,
            membershipFence: 0n,
        },
    });
    await prisma.syncGroupMember.createMany({
        data: [
            {
                syncGroupId: PUBLIC_GROUP_ID,
                userId: PUBLIC_HOST_ID,
                isHost: true,
            },
            {
                syncGroupId: PUBLIC_GROUP_ID,
                userId: PUBLIC_DEPARTING_ID,
            },
        ],
    });
}

async function resetDeletionBoundary(): Promise<void> {
    await prisma.syncGroup.deleteMany({
        where: { hostUserId: DELETION_USER_ID },
    });
    await prisma.syncGroupMember.deleteMany({
        where: {
            syncGroupId: PUBLIC_GROUP_ID,
            userId: DELETION_USER_ID,
        },
    });
    await prisma.user.update({
        where: { id: DELETION_USER_ID },
        data: { pendingDeletionAt: null },
    });
    await prisma.syncGroupMember.create({
        data: {
            syncGroupId: PUBLIC_GROUP_ID,
            userId: DELETION_USER_ID,
            leftAt: new Date("2026-08-20T12:00:00.000Z"),
        },
    });
}

function readPublicBoundaryState() {
    return prisma.syncGroup.findUniqueOrThrow({
        where: { id: PUBLIC_GROUP_ID },
        select: {
            hostUserId: true,
            isActive: true,
            endedAt: true,
            membershipFence: true,
            members: {
                orderBy: { userId: "asc" },
                select: {
                    userId: true,
                    isHost: true,
                    joinedAt: true,
                    leftAt: true,
                },
            },
        },
    });
}

async function exercisePublicBoundaryRollback(
    operationFactory: () => Promise<unknown>,
): Promise<{
    checkpoint: "post-write-validation" | "operation-settled";
    outcome: { status: "fulfilled" } | { status: "rejected"; reason: unknown };
}> {
    const operation = operationFactory();
    const outcome = operation.then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    const checkpoint = await Promise.race([
        mockActiveFence!.postWriteValidationStarted.then(
            () => "post-write-validation" as const,
        ),
        outcome.then(() => "operation-settled" as const),
    ]);
    if (checkpoint === "post-write-validation") {
        mockActiveFence!.loseLease();
    }
    return { checkpoint, outcome: await outcome };
}

function expectFencedRollbackOutcome(
    result: Awaited<ReturnType<typeof exercisePublicBoundaryRollback>>,
): void {
    expect(result.checkpoint).toBe("post-write-validation");
    expect(result.outcome).toMatchObject({
        status: "rejected",
        reason: { code: "CONFLICT" },
    });
}

describeWithPostgres("Listen Together PostgreSQL membership fencing", () => {
    let admin: Client;

    beforeAll(async () => {
        admin = await createScaleDatabase(
            integrationDatabaseUrl!,
            databaseName!,
        );
        await applyScaleMigrations(process.env.DATABASE_URL!);
        await seedGroup();
    });

    afterAll(async () => {
        await prisma.$disconnect();
        if (admin && databaseName) {
            await dropScaleDatabase(admin, databaseName);
        }
    });

    describe("public service membership boundaries", () => {
        beforeEach(async () => {
            await resetPublicBoundaryGroup();
            mockActiveFence = controllableFence(10);
        });

        afterEach(() => {
            mockActiveFence = null;
        });

        it("rolls back a public join when its lease is lost before commit", async () => {
            const result = await exercisePublicBoundaryRollback(() =>
                joinGroup(
                    PUBLIC_JOINING_ID,
                    PUBLIC_JOINING_ID,
                    PUBLIC_JOIN_CODE,
                ),
            );
            const state = await readPublicBoundaryState();

            expect(state.membershipFence).toBe(0n);
            expect(
                state.members.find(
                    (member) => member.userId === PUBLIC_JOINING_ID,
                ),
            ).toBeUndefined();
            expectFencedRollbackOutcome(result);
        });

        it("rolls back a public departure when its lease is lost before commit", async () => {
            const result = await exercisePublicBoundaryRollback(() =>
                leaveGroup(PUBLIC_DEPARTING_ID, PUBLIC_GROUP_ID),
            );
            const state = await readPublicBoundaryState();

            expect(state.membershipFence).toBe(0n);
            expect(
                state.members.find(
                    (member) => member.userId === PUBLIC_DEPARTING_ID,
                ),
            ).toMatchObject({ leftAt: null, isHost: false });
            expectFencedRollbackOutcome(result);
        });

        it("rolls back a public end when its lease is lost before commit", async () => {
            const result = await exercisePublicBoundaryRollback(() =>
                endGroup(PUBLIC_HOST_ID, PUBLIC_GROUP_ID),
            );
            const state = await readPublicBoundaryState();

            expect(state.membershipFence).toBe(0n);
            expect(state).toMatchObject({ isActive: true, endedAt: null });
            expect(
                state.members.map((member) => ({
                    userId: member.userId,
                    isHost: member.isHost,
                    leftAt: member.leftAt,
                })),
            ).toEqual([
                {
                    userId: PUBLIC_DEPARTING_ID,
                    isHost: false,
                    leftAt: null,
                },
                {
                    userId: PUBLIC_HOST_ID,
                    isHost: true,
                    leftAt: null,
                },
            ]);
            expectFencedRollbackOutcome(result);
        });
    });

    describe("user deletion membership ordering", () => {
        beforeEach(async () => {
            await resetPublicBoundaryGroup();
            await resetDeletionBoundary();
            mockActiveFence = unblockedFence(20);
        });

        afterEach(() => {
            mockOperationGate?.release();
            mockOperationGate = null;
            mockActiveFence = null;
            mockLocalMutationTails.clear();
            jest.mocked(enqueueGroupSnapshotPublication).mockResolvedValue(
                undefined,
            );
            jest.mocked(listenTogetherStateStore.getSnapshot).mockResolvedValue(
                null,
            );
        });

        it("rejects membership reactivation when deletion marks first", async () => {
            mockOperationGate = operationGate();
            const join = joinGroup(
                DELETION_USER_ID,
                DELETION_USER_ID,
                PUBLIC_JOIN_CODE,
            );
            await mockOperationGate.started;

            await expect(
                markUserPendingDeletion(DELETION_USER_ID),
            ).resolves.toBe("reserved");
            mockOperationGate.release();

            await expect(join).rejects.toMatchObject({
                code: "NOT_ALLOWED",
                message: "User deletion is pending",
            });
            const membership = await prisma.syncGroupMember.findUniqueOrThrow({
                where: {
                    syncGroupId_userId: {
                        syncGroupId: PUBLIC_GROUP_ID,
                        userId: DELETION_USER_ID,
                    },
                },
            });
            expect(membership.leftAt).not.toBeNull();
        });

        it("sweeps membership reactivation that commits before deletion marks", async () => {
            const guard = new Client({
                connectionString: process.env.DATABASE_URL,
            });
            await guard.connect();
            try {
                await guard.query("BEGIN");
                await guard.query("SELECT pg_advisory_xact_lock($1::bigint)", [
                    ROLE_GUARD_LOCK_KEY,
                ]);
                const marking = markUserPendingDeletion(DELETION_USER_ID);
                await joinGroup(
                    DELETION_USER_ID,
                    DELETION_USER_ID,
                    PUBLIC_JOIN_CODE,
                );
                await guard.query("COMMIT");
                await expect(marking).resolves.toBe("reserved");

                await cleanupListenTogetherForUser(DELETION_USER_ID);

                const membership =
                    await prisma.syncGroupMember.findUniqueOrThrow({
                        where: {
                            syncGroupId_userId: {
                                syncGroupId: PUBLIC_GROUP_ID,
                                userId: DELETION_USER_ID,
                            },
                        },
                    });
                expect(membership.leftAt).toEqual(expect.any(Date));
                expect(membership.cleanupPublicationPending).toBe(false);
            } finally {
                await guard.query("ROLLBACK").catch(() => undefined);
                await guard.end();
            }
        });

        it("sweeps a group that commits before deletion marks", async () => {
            const guard = new Client({
                connectionString: process.env.DATABASE_URL,
            });
            await guard.connect();
            try {
                await guard.query("BEGIN");
                await guard.query("SELECT pg_advisory_xact_lock($1::bigint)", [
                    ROLE_GUARD_LOCK_KEY,
                ]);
                const marking = markUserPendingDeletion(DELETION_USER_ID);
                const created = await createGroup(
                    DELETION_USER_ID,
                    DELETION_USER_ID,
                    { visibility: "private" },
                );
                await guard.query("COMMIT");
                await expect(marking).resolves.toBe("reserved");

                await cleanupListenTogetherForUser(DELETION_USER_ID);

                const group = await prisma.syncGroup.findUniqueOrThrow({
                    where: { id: created.id },
                    include: { members: true },
                });
                expect(group.isActive).toBe(false);
                expect(group.cleanupPublicationPending).toBe(false);
                expect(group.members).toEqual([
                    expect.objectContaining({
                        userId: DELETION_USER_ID,
                        leftAt: expect.any(Date),
                    }),
                ]);
            } finally {
                await guard.query("ROLLBACK").catch(() => undefined);
                await guard.end();
            }
        });

        it("waits for a pre-reservation leave and reconciles its unmarked publication failure", async () => {
            const joinedAt = new Date("2026-08-21T12:00:00.000Z");
            jest.mocked(listenTogetherStateStore.getSnapshot).mockResolvedValue(
                {
                    id: PUBLIC_GROUP_ID,
                    name: "Public boundary group",
                    joinCode: PUBLIC_JOIN_CODE,
                    groupType: "host-follower",
                    visibility: "public",
                    isActive: true,
                    hostUserId: PUBLIC_HOST_ID,
                    membershipVersion: 0,
                    syncState: "paused",
                    playback: {
                        queue: [],
                        currentIndex: 0,
                        isPlaying: false,
                        positionMs: 0,
                        serverTime: 0,
                        stateVersion: 0,
                        trackId: null,
                    },
                    members: [
                        {
                            userId: PUBLIC_HOST_ID,
                            username: PUBLIC_HOST_ID,
                            isHost: true,
                            joinedAt: joinedAt.toISOString(),
                            isConnected: false,
                        },
                        {
                            userId: PUBLIC_DEPARTING_ID,
                            username: PUBLIC_DEPARTING_ID,
                            isHost: false,
                            joinedAt: joinedAt.toISOString(),
                            isConnected: true,
                        },
                    ],
                },
            );
            jest.mocked(enqueueGroupSnapshotPublication)
                .mockRejectedValueOnce(new Error("publication failed"))
                .mockResolvedValue(undefined);
            mockOperationGate = operationGate();
            const leave = leaveGroup(PUBLIC_DEPARTING_ID, PUBLIC_GROUP_ID);
            await mockOperationGate.started;
            await expect(
                markUserPendingDeletion(PUBLIC_DEPARTING_ID),
            ).resolves.toBe("reserved");

            let cleanupSettled = false;
            const cleanup = cleanupListenTogetherForUser(
                PUBLIC_DEPARTING_ID,
            ).finally(() => {
                cleanupSettled = true;
            });
            await Promise.resolve();
            await Promise.resolve();
            expect(cleanupSettled).toBe(false);

            mockOperationGate.release();
            await expect(leave).rejects.toMatchObject({ code: "CONFLICT" });
            await expect(cleanup).resolves.toBeUndefined();

            const membership = await prisma.syncGroupMember.findUniqueOrThrow({
                where: {
                    syncGroupId_userId: {
                        syncGroupId: PUBLIC_GROUP_ID,
                        userId: PUBLIC_DEPARTING_ID,
                    },
                },
            });
            expect(membership.leftAt).toEqual(expect.any(Date));
            expect(membership.cleanupPublicationPending).toBe(false);
            // The first call is the rejected ordinary-leave enqueue. The
            // second is cleanup's successful replay of that durable marker.
            expect(
                jest
                    .mocked(enqueueGroupSnapshotPublication)
                    .mock.calls.map(([groupId, snapshot, publication]) => ({
                        groupId,
                        snapshot: {
                            id: snapshot.id,
                            hostUserId: snapshot.hostUserId,
                            memberIds: snapshot.members.map(
                                ({ userId }) => userId,
                            ),
                        },
                        transition: publication?.type,
                        departedUserId:
                            publication?.type === "left"
                                ? publication.member.userId
                                : undefined,
                    })),
            ).toEqual([
                {
                    groupId: PUBLIC_GROUP_ID,
                    snapshot: {
                        id: PUBLIC_GROUP_ID,
                        hostUserId: PUBLIC_HOST_ID,
                        memberIds: [PUBLIC_HOST_ID],
                    },
                    transition: "left",
                    departedUserId: PUBLIC_DEPARTING_ID,
                },
                {
                    groupId: PUBLIC_GROUP_ID,
                    snapshot: {
                        id: PUBLIC_GROUP_ID,
                        hostUserId: PUBLIC_HOST_ID,
                        memberIds: [PUBLIC_HOST_ID],
                    },
                    transition: "left",
                    departedUserId: PUBLIC_DEPARTING_ID,
                },
            ]);
        });
    });

    it("rejects an expired holder delayed before its fence advance", async () => {
        let releaseExpiredHolder: () => void = () => undefined;
        let markExpiredHolderReady: () => void = () => undefined;
        const expiredHolderReady = new Promise<void>((resolve) => {
            markExpiredHolderReady = resolve;
        });
        const expiredHolderGate = new Promise<void>((resolve) => {
            releaseExpiredHolder = resolve;
        });

        const expiredDeparture = prisma.$transaction(async (tx) => {
            markExpiredHolderReady();
            await expiredHolderGate;
            await withSyncGroupMembershipFence(
                tx,
                GROUP_ID,
                fence(1),
                async () => {
                    await tx.syncGroupMember.updateMany({
                        where: {
                            syncGroupId: GROUP_ID,
                            userId: DEPARTING_ID,
                            leftAt: null,
                        },
                        data: { leftAt: new Date() },
                    });
                },
            );
        });
        await expiredHolderReady;

        await prisma.$transaction((tx) =>
            withSyncGroupMembershipFence(tx, GROUP_ID, fence(2), async () => {
                await tx.syncGroupMember.create({
                    data: { syncGroupId: GROUP_ID, userId: JOINING_ID },
                });
            }),
        );
        releaseExpiredHolder();

        await expect(expiredDeparture).rejects.toMatchObject({
            code: "CONFLICT",
        });
        const group = await prisma.syncGroup.findUniqueOrThrow({
            where: { id: GROUP_ID },
            include: { members: { where: { leftAt: null } } },
        });
        expect(group.membershipFence).toBe(2n);
        expect(group.members.map((member) => member.userId).sort()).toEqual(
            [DEPARTING_ID, HOST_ID, JOINING_ID].sort(),
        );
    });

    it("rolls back membership writes when the lease is lost before commit", async () => {
        let fenced = false;
        const lostLease = {
            fencingToken: 3,
            requiresMembershipFence: true,
            isFenced: () => fenced,
        };

        await expect(
            prisma.$transaction((tx) =>
                withSyncGroupMembershipFence(
                    tx,
                    GROUP_ID,
                    lostLease,
                    async () => {
                        await tx.syncGroupMember.updateMany({
                            where: {
                                syncGroupId: GROUP_ID,
                                userId: DEPARTING_ID,
                                leftAt: null,
                            },
                            data: { leftAt: new Date() },
                        });
                        fenced = true;
                    },
                ),
            ),
        ).rejects.toMatchObject({ code: "CONFLICT" });

        const group = await prisma.syncGroup.findUniqueOrThrow({
            where: { id: GROUP_ID },
            include: { members: { where: { leftAt: null } } },
        });
        expect(group.membershipFence).toBe(2n);
        expect(group.members.map((member) => member.userId).sort()).toEqual(
            [DEPARTING_ID, HOST_ID, JOINING_ID].sort(),
        );
    });
});
