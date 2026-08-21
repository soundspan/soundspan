import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { listenTogetherClusterSync } from "./listenTogetherClusterSync";
import { withListenTogetherDeadlineAt } from "./listenTogetherDeadline";
import { groupManager } from "./listenTogetherManager";
import { quiesceListenTogetherUserGroups } from "./listenTogetherUserQuiescence";

const CLEANUP_PAGE_SIZE = 250;
const MAX_CLEANUP_PAGES_PER_PASS = 400;
const MAX_RESIDUAL_GROUPS_PER_PASS = 10_000;
const USER_CLEANUP_DEADLINE_MS = 10_000;
const log = logger.child("ListenTogetherUserCleanup");

type CleanupMutations = Pick<
    typeof import("./listenTogether"),
    "endGroupAdmitted" | "leaveGroupAdmitted"
>;

interface CleanupScope {
    signal: AbortSignal;
    deadlineAtMs: number;
}

interface CleanupRecordBase {
    id: string;
    groupId: string;
}

interface HostedCleanupRecord extends CleanupRecordBase {
    isActive: boolean;
    cleanupPublicationPending: boolean;
}

interface MembershipCleanupRecord extends CleanupRecordBase {
    leftAt: Date | null;
    groupIsActive: boolean;
    cleanupPublicationPending: boolean;
}

interface CleanupPage<T extends CleanupRecordBase> {
    records: T[];
    lastProcessedId?: string;
    complete: boolean;
}

async function loadCleanupMutations(): Promise<CleanupMutations> {
    return import("./listenTogether");
}

async function loadHostedPage(
    userId: string,
    scope: CleanupScope,
    lastProcessedId?: string,
): Promise<CleanupPage<HostedCleanupRecord>> {
    scope.signal.throwIfAborted();
    const query = prisma.syncGroup.findMany({
        where: {
            hostUserId: userId,
            OR: [{ isActive: true }, { cleanupPublicationPending: true }],
            ...(lastProcessedId ? { id: { gt: lastProcessedId } } : {}),
        },
        select: {
            id: true,
            isActive: true,
            cleanupPublicationPending: true,
        },
        orderBy: { id: "asc" },
        take: CLEANUP_PAGE_SIZE,
    });
    const rows = await withListenTogetherDeadlineAt(
        query,
        "Listen Together hosted cleanup page",
        scope.deadlineAtMs,
        scope.signal,
    );
    const records = rows.map((row) => ({
        id: row.id,
        groupId: row.id,
        isActive: row.isActive ?? true,
        cleanupPublicationPending: row.cleanupPublicationPending ?? false,
    }));
    return cleanupPage(rows, records);
}

async function loadMembershipPage(
    userId: string,
    scope: CleanupScope,
    lastProcessedId?: string,
): Promise<CleanupPage<MembershipCleanupRecord>> {
    scope.signal.throwIfAborted();
    const query = prisma.syncGroupMember.findMany({
        where: {
            userId,
            OR: [{ leftAt: null }, { cleanupPublicationPending: true }],
            ...(lastProcessedId ? { id: { gt: lastProcessedId } } : {}),
        },
        select: {
            id: true,
            syncGroupId: true,
            leftAt: true,
            cleanupPublicationPending: true,
            syncGroup: { select: { isActive: true } },
        },
        orderBy: { id: "asc" },
        take: CLEANUP_PAGE_SIZE,
    });
    const rows = await withListenTogetherDeadlineAt(
        query,
        "Listen Together membership cleanup page",
        scope.deadlineAtMs,
        scope.signal,
    );
    const records = rows.map((row) => ({
        id: row.id,
        groupId: row.syncGroupId,
        leftAt: row.leftAt ?? null,
        groupIsActive: row.syncGroup?.isActive ?? true,
        cleanupPublicationPending: row.cleanupPublicationPending ?? false,
    }));
    return cleanupPage(rows, records);
}

function cleanupPage<T extends CleanupRecordBase>(
    rows: Array<{ id: string }>,
    records: T[],
): CleanupPage<T> {
    return {
        records,
        lastProcessedId: rows[rows.length - 1]?.id,
        complete: rows.length < CLEANUP_PAGE_SIZE,
    };
}

function collectResidualGroupIds(userId: string): {
    hosted: string[];
    membership: string[];
} {
    const groupIds = groupManager.allGroupIds();
    if (groupIds.length > MAX_RESIDUAL_GROUPS_PER_PASS) {
        throw new Error("Listen Together residual cleanup exceeded its bound");
    }
    const hosted: string[] = [];
    const membership: string[] = [];
    for (const groupId of groupIds) {
        const group = groupManager.get(groupId);
        if (!group) continue;
        if (group.hostUserId === userId) {
            hosted.push(groupId);
        } else if (group.members.has(userId)) {
            membership.push(groupId);
        }
    }
    return { hosted, membership };
}

async function loadResidualHostedRecords(
    userId: string,
    groupIds: string[],
    scope: CleanupScope,
): Promise<HostedCleanupRecord[]> {
    if (groupIds.length === 0) return [];
    const query = prisma.syncGroup.findMany({
        where: {
            id: { in: groupIds },
            hostUserId: userId,
            isActive: false,
            cleanupPublicationPending: false,
        },
        select: {
            id: true,
            isActive: true,
            cleanupPublicationPending: true,
        },
        orderBy: { id: "asc" },
        take: MAX_RESIDUAL_GROUPS_PER_PASS,
    });
    const rows = await withListenTogetherDeadlineAt(
        query,
        "Listen Together hosted residual cleanup",
        scope.deadlineAtMs,
        scope.signal,
    );
    return rows.map((row) => ({
        id: row.id,
        groupId: row.id,
        isActive: row.isActive,
        cleanupPublicationPending: row.cleanupPublicationPending,
    }));
}

async function loadResidualMembershipRecords(
    userId: string,
    groupIds: string[],
    scope: CleanupScope,
): Promise<MembershipCleanupRecord[]> {
    if (groupIds.length === 0) return [];
    const query = prisma.syncGroupMember.findMany({
        where: {
            userId,
            syncGroupId: { in: groupIds },
            leftAt: { not: null },
            cleanupPublicationPending: false,
        },
        select: {
            id: true,
            syncGroupId: true,
            leftAt: true,
            cleanupPublicationPending: true,
            syncGroup: { select: { isActive: true } },
        },
        orderBy: { id: "asc" },
        take: MAX_RESIDUAL_GROUPS_PER_PASS,
    });
    const rows = await withListenTogetherDeadlineAt(
        query,
        "Listen Together membership residual cleanup",
        scope.deadlineAtMs,
        scope.signal,
    );
    return rows.map((row) => ({
        id: row.id,
        groupId: row.syncGroupId,
        leftAt: row.leftAt,
        groupIsActive: row.syncGroup.isActive,
        cleanupPublicationPending: row.cleanupPublicationPending,
    }));
}

async function publishUserRevocation(
    userId: string,
    groupIds: string[] | "all-for-user",
    scope: CleanupScope,
): Promise<void> {
    scope.signal.throwIfAborted();
    const revocation = { userId, groupIds };
    const localEviction = listenTogetherClusterSync.revokeLocalUser(revocation);
    await withListenTogetherDeadlineAt(
        localEviction,
        "Listen Together local user revocation",
        scope.deadlineAtMs,
        scope.signal,
    );
    scope.signal.throwIfAborted();
    const publication = listenTogetherClusterSync.publishUserRevocation(
        userId,
        groupIds,
    );
    await withListenTogetherDeadlineAt(
        publication,
        "Listen Together user revocation publication",
        scope.deadlineAtMs,
        scope.signal,
    );
}

async function reconcileRecord(
    userId: string,
    kind: "hosted" | "membership",
    record: HostedCleanupRecord | MembershipCleanupRecord,
    mutations: CleanupMutations,
    scope: CleanupScope,
): Promise<void> {
    scope.signal.throwIfAborted();
    const options = {
        signal: scope.signal,
        deadlineAtMs: scope.deadlineAtMs,
    };
    if (kind === "hosted") {
        await mutations.endGroupAdmitted(userId, record.groupId, true, options);
        await publishUserRevocation(userId, [record.groupId], scope);
        const clear = prisma.syncGroup.updateMany({
            where: { id: record.id, cleanupPublicationPending: true },
            data: { cleanupPublicationPending: false },
        });
        const cleared = await withListenTogetherDeadlineAt(
            clear,
            "Listen Together hosted cleanup marker",
            scope.deadlineAtMs,
            scope.signal,
        );
        if (cleared.count !== 1) {
            throw new Error(`Hosted cleanup marker missing for ${record.id}`);
        }
        return;
    }
    await mutations.leaveGroupAdmitted(userId, record.groupId, true, options);
    await publishUserRevocation(userId, [record.groupId], scope);
    const clear = prisma.syncGroupMember.updateMany({
        where: { id: record.id, cleanupPublicationPending: true },
        data: { cleanupPublicationPending: false },
    });
    const cleared = await withListenTogetherDeadlineAt(
        clear,
        "Listen Together membership cleanup marker",
        scope.deadlineAtMs,
        scope.signal,
    );
    if (cleared.count !== 1) {
        throw new Error(`Membership cleanup marker missing for ${record.id}`);
    }
}

async function reconcilePages(
    userId: string,
    kind: "hosted" | "membership",
    mutations: CleanupMutations,
    scope: CleanupScope,
): Promise<void> {
    let lastProcessedId: string | undefined;
    for (let page = 0; page < MAX_CLEANUP_PAGES_PER_PASS; page += 1) {
        scope.signal.throwIfAborted();
        const cleanupPage =
            kind === "hosted"
                ? await loadHostedPage(userId, scope, lastProcessedId)
                : await loadMembershipPage(userId, scope, lastProcessedId);
        scope.signal.throwIfAborted();
        for (const record of cleanupPage.records) {
            scope.signal.throwIfAborted();
            await reconcileRecord(userId, kind, record, mutations, scope);
        }
        if (cleanupPage.complete) return;
        lastProcessedId = cleanupPage.lastProcessedId;
        if (!lastProcessedId) {
            throw new Error("Cleanup page lacked a terminal record");
        }
    }
    throw new Error(`Listen Together ${kind} cleanup pass limit reached`);
}

async function reconcileResidualRuntimeState(
    userId: string,
    mutations: CleanupMutations,
    scope: CleanupScope,
): Promise<void> {
    const groupIds = collectResidualGroupIds(userId);
    const hosted = await loadResidualHostedRecords(
        userId,
        groupIds.hosted,
        scope,
    );
    for (const record of hosted) {
        await reconcileRecord(userId, "hosted", record, mutations, scope);
    }
    const memberships = await loadResidualMembershipRecords(
        userId,
        groupIds.membership,
        scope,
    );
    for (const record of memberships) {
        await reconcileRecord(userId, "membership", record, mutations, scope);
    }
}

async function cleanupListenTogetherForUserAdmitted(
    userId: string,
    signal: AbortSignal,
    deadlineAtMs: number,
): Promise<void> {
    const scope = { signal, deadlineAtMs };
    await quiesceListenTogetherUserGroups(userId, deadlineAtMs, signal);
    scope.signal.throwIfAborted();
    const mutations = await loadCleanupMutations();
    // Each committed publication clears its durable marker, so the next retry
    // starts at the first unfinished terminal transition instead of replaying
    // completed history.
    await reconcilePages(userId, "hosted", mutations, scope);
    await reconcilePages(userId, "membership", mutations, scope);
    // Inspect bounded local runtime state once for unmarked terminal records.
    // Historical remote-only sockets are covered by the final identity sweep.
    await reconcileResidualRuntimeState(userId, mutations, scope);
    await publishUserRevocation(userId, "all-for-user", scope);
}

function createCleanupDeadlineScope(): {
    signal: AbortSignal;
    deadlineAtMs: number;
    abort(): void;
    dispose(): void;
} {
    const controller = new AbortController();
    const deadlineAtMs = Date.now() + USER_CLEANUP_DEADLINE_MS;
    const timer = setTimeout(
        () => controller.abort(new Error("User cleanup deadline expired")),
        USER_CLEANUP_DEADLINE_MS,
    );
    timer.unref?.();
    return {
        signal: controller.signal,
        deadlineAtMs,
        abort: () => controller.abort(new Error("User cleanup stopped")),
        dispose: () => clearTimeout(timer),
    };
}

/** Reconcile durable Listen Together state before deleting a user. */
export async function cleanupListenTogetherForUser(
    userId: string,
): Promise<void> {
    const { withListenTogetherMutationAdmission } =
        await import("./listenTogetherMutationAdmission");
    const scope = createCleanupDeadlineScope();
    const cleanup = withListenTogetherMutationAdmission("cleanup-user", () =>
        cleanupListenTogetherForUserAdmitted(
            userId,
            scope.signal,
            scope.deadlineAtMs,
        ),
    );
    try {
        return await cleanup;
    } catch (error) {
        log.warn("Listen Together user cleanup remains incomplete", {
            userId,
            error,
        });
        throw error;
    } finally {
        scope.abort();
        scope.dispose();
    }
}
