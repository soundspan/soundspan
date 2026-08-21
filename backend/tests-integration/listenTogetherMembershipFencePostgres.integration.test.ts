import type { GroupMutationFence } from "../src/services/listenTogetherLeaseFencing";

interface ControllableFence extends GroupMutationFence {
    postWriteValidationStarted: Promise<void>;
    loseLease(): void;
}

let mockActiveFence: ControllableFence | null = null;

jest.mock("../src/services/listenTogetherMutationLock", () => ({
    withGroupMutationLock: async <T>(
        _groupId: string,
        _operationName: string,
        operation: (fence: GroupMutationFence) => Promise<T>,
    ): Promise<T> => {
        if (!mockActiveFence) throw new Error("No controlled fence installed");
        return operation(mockActiveFence);
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
        publishSnapshot: jest.fn(async () => undefined),
        publishMembership: jest.fn(async () => undefined),
        publishEnded: jest.fn(async () => undefined),
    },
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
    endGroup,
    joinGroup,
    leaveGroup,
} from "../src/services/listenTogether";
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

async function seedGroup(): Promise<void> {
    await prisma.user.createMany({
        data: [
            HOST_ID,
            DEPARTING_ID,
            JOINING_ID,
            PUBLIC_HOST_ID,
            PUBLIC_DEPARTING_ID,
            PUBLIC_JOINING_ID,
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
