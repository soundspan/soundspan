import type { Namespace, Socket } from "socket.io";
import { randomUUID } from "crypto";
import { prisma } from "../utils/db";
import type {
    ClusterPublicationMetadata,
    ClusterUserRevocation,
} from "./listenTogetherClusterSync";
import { withListenTogetherDeadlineAt } from "./listenTogetherDeadline";
import { createUserRevocationHandler } from "./listenTogetherSocketRevocation";
import { withLocalGroupMutationBoundary } from "./listenTogetherMutationLock";

const SOCKET_AUDIT_BATCH_SIZE = 100;
const MAX_SOCKET_AUDIT_RECORDS = 10_000;

interface AuditedSocket extends Socket {
    data: { userId: string; groupId: string | null };
}

interface SocketMembershipRecord {
    userId: string;
    groupId: string;
}

/** Shared lifetime supplied by the cluster (re)subscription boundary. */
export interface SocketMembershipReconciliationScope {
    signal: AbortSignal;
    deadlineAtMs: number;
}

type DeferredRevocation = () => void | Promise<void>;

/** Authority recovery and revocation seams used by reconnect reconciliation. */
export interface SocketMembershipReconciliationDependencies {
    recoverAuthority(groupId: string, snapshot: null): void | Promise<void>;
    revokeUser(
        revocation: ClusterUserRevocation,
        metadata: ClusterPublicationMetadata,
    ): DeferredRevocation | Promise<DeferredRevocation>;
}

function membershipKey(groupId: string, userId: string): string {
    return JSON.stringify([groupId, userId]);
}

function collectSocketMemberships(ns: Namespace): SocketMembershipRecord[] {
    const records: SocketMembershipRecord[] = [];
    let inspected = 0;
    for (const rawSocket of ns.sockets.values()) {
        if (inspected >= MAX_SOCKET_AUDIT_RECORDS) {
            throw new Error("Listen Together socket audit exceeded its bound");
        }
        inspected += 1;
        const socket = rawSocket as AuditedSocket;
        if (socket.data.groupId) {
            records.push({
                userId: socket.data.userId,
                groupId: socket.data.groupId,
            });
        }
    }
    return records;
}

function clusterMetadata(
    groupId: string,
    membershipFence: bigint,
): ClusterPublicationMetadata {
    const fencingToken = Number(membershipFence);
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 0) {
        throw new Error(`Invalid membership fence for ${groupId}`);
    }
    return { fencingToken, publicationId: randomUUID() };
}

async function loadGroupAuditPage(
    records: SocketMembershipRecord[],
    scope: SocketMembershipReconciliationScope,
) {
    scope.signal.throwIfAborted();
    const groupIds = Array.from(
        new Set(records.map((record) => record.groupId)),
    );
    // Prisma model reads do not accept this scope's AbortSignal. Keep the
    // reconciliation promise tied to raw query settlement so the cluster
    // single-flight remains occupied after its outer caller deadline expires.
    const query = prisma.syncGroup.findMany({
        where: { id: { in: groupIds } },
        select: {
            id: true,
            isActive: true,
            membershipFence: true,
            members: {
                where: {
                    leftAt: null,
                    user: { pendingDeletionAt: null },
                    OR: records.map((record) => ({
                        syncGroupId: record.groupId,
                        userId: record.userId,
                    })),
                },
                select: { userId: true },
                orderBy: { id: "asc" as const },
                take: SOCKET_AUDIT_BATCH_SIZE + 1,
            },
        },
    });
    return query;
}

async function applyAuditPage(
    records: SocketMembershipRecord[],
    dependencies: SocketMembershipReconciliationDependencies,
    scope: SocketMembershipReconciliationScope,
): Promise<void> {
    const rows = await loadGroupAuditPage(records, scope);
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const recordsByGroup = groupSocketMemberships(records);
    const groupIds = Array.from(recordsByGroup.keys());
    for (const groupId of groupIds) {
        scope.signal.throwIfAborted();
        const row = rowsById.get(groupId);
        const boundary = withLocalGroupMutationBoundary(groupId, () =>
            reconcileAuditedGroup(
                groupId,
                row,
                recordsByGroup.get(groupId) ?? [],
                dependencies,
                scope,
            ),
        );
        await withListenTogetherDeadlineAt(
            boundary,
            "Listen Together reconnect mutation boundary",
            scope.deadlineAtMs,
            scope.signal,
        );
    }
}

function groupSocketMemberships(
    records: SocketMembershipRecord[],
): Map<string, SocketMembershipRecord[]> {
    const recordsByGroup = new Map<string, SocketMembershipRecord[]>();
    for (const record of records) {
        const groupRecords = recordsByGroup.get(record.groupId) ?? [];
        groupRecords.push(record);
        recordsByGroup.set(record.groupId, groupRecords);
    }
    return recordsByGroup;
}

async function reconcileAuditedGroup(
    groupId: string,
    row: Awaited<ReturnType<typeof loadGroupAuditPage>>[number] | undefined,
    records: SocketMembershipRecord[],
    dependencies: SocketMembershipReconciliationDependencies,
    scope: SocketMembershipReconciliationScope,
): Promise<void> {
    scope.signal.throwIfAborted();
    const metadata = row?.isActive
        ? clusterMetadata(groupId, row.membershipFence)
        : { fencingToken: 0, publicationId: randomUUID() };
    const validMemberships = new Set<string>();
    if (row?.isActive) {
        if (row.members.length > SOCKET_AUDIT_BATCH_SIZE) {
            throw new Error(
                "Listen Together membership pair audit exceeded its bound",
            );
        }
        for (const member of row.members) {
            validMemberships.add(membershipKey(groupId, member.userId));
        }
    } else {
        await withListenTogetherDeadlineAt(
            Promise.resolve(dependencies.recoverAuthority(groupId, null)),
            "Listen Together reconnect authority recovery",
            scope.deadlineAtMs,
            scope.signal,
        );
    }
    await revokeInvalidGroupSockets(
        records,
        validMemberships,
        metadata,
        dependencies,
        scope,
    );
}

async function revokeInvalidGroupSockets(
    records: SocketMembershipRecord[],
    validMemberships: Set<string>,
    metadata: ClusterPublicationMetadata,
    dependencies: SocketMembershipReconciliationDependencies,
    scope: SocketMembershipReconciliationScope,
): Promise<void> {
    const revokedMemberships = new Set<string>();
    for (const record of records) {
        scope.signal.throwIfAborted();
        const key = membershipKey(record.groupId, record.userId);
        if (validMemberships.has(key) || revokedMemberships.has(key)) continue;
        revokedMemberships.add(key);
        const effect = await withListenTogetherDeadlineAt(
            Promise.resolve(
                dependencies.revokeUser(
                    { userId: record.userId, groupIds: [record.groupId] },
                    metadata,
                ),
            ),
            "Listen Together reconnect revocation preparation",
            scope.deadlineAtMs,
            scope.signal,
        );
        const revocation = Promise.resolve().then(effect);
        await withListenTogetherDeadlineAt(
            revocation,
            "Listen Together reconnect socket revocation",
            scope.deadlineAtMs,
            scope.signal,
        );
    }
}

async function reconcileConnectedSocketMemberships(
    ns: Namespace,
    dependencies: SocketMembershipReconciliationDependencies,
    scope: SocketMembershipReconciliationScope,
): Promise<void> {
    const records = uniqueSocketMemberships(collectSocketMemberships(ns));
    for (
        let offset = 0;
        offset < records.length && offset < MAX_SOCKET_AUDIT_RECORDS;
        offset += SOCKET_AUDIT_BATCH_SIZE
    ) {
        scope.signal.throwIfAborted();
        const pageRecords = records.slice(
            offset,
            offset + SOCKET_AUDIT_BATCH_SIZE,
        );
        await applyAuditPage(pageRecords, dependencies, scope);
    }
}

function uniqueSocketMemberships(
    records: SocketMembershipRecord[],
): SocketMembershipRecord[] {
    const unique = new Map<string, SocketMembershipRecord>();
    for (const record of records) {
        unique.set(membershipKey(record.groupId, record.userId), record);
    }
    return Array.from(unique.values());
}

/** Audit this replica's attached sockets after a cluster subscription starts. */
export function createSocketMembershipReconciliationHandler(
    ns: Namespace,
    dependencies: SocketMembershipReconciliationDependencies,
): (scope: SocketMembershipReconciliationScope) => Promise<void> {
    return (scope) =>
        reconcileConnectedSocketMemberships(ns, dependencies, scope);
}

/** Compose direct revocation and reconnect audit around one socket namespace. */
export function createClusterSocketReconciliationHandlers(
    ns: Namespace,
    recoverAuthority: SocketMembershipReconciliationDependencies["recoverAuthority"],
    beforeRevoke: (groupId: string, userId: string) => void,
    afterRevoke: (groupId: string, userId: string) => void,
) {
    const userRevocationHandler = createUserRevocationHandler(
        ns,
        beforeRevoke,
        afterRevoke,
    );
    return {
        userRevocationHandler,
        reconciliationHandler: createSocketMembershipReconciliationHandler(ns, {
            recoverAuthority,
            revokeUser: userRevocationHandler,
        }),
    };
}
