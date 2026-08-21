import type { Namespace, Socket } from "socket.io";
import type { MembershipFanoutMetadata } from "./listenTogetherCallbacks";
import type {
    ClusterPublicationMetadata,
    ClusterUserRevocation,
} from "./listenTogetherClusterSync";

const MAX_SOCKET_REVOCATION_SCAN = 10_000;

interface RevocableSocket extends Socket {
    data: {
        userId: string;
        groupId: string | null;
    };
}

type BeforeSocketRevocation = (groupId: string, userId: string) => void;
type AfterMembershipRevocation = (groupId: string, userId: string) => void;
type UserRevocationGroups = string[] | "all-for-user";

function socketRevocationTargets(
    ns: Namespace,
    groupId: string,
    socketIds: string[],
    userId?: string,
): string[] {
    if (socketIds.length > MAX_SOCKET_REVOCATION_SCAN) {
        throw new Error("Listen Together socket revocation exceeded its bound");
    }
    const targets = new Set(socketIds);
    if (!userId) return Array.from(targets);
    let scanned = 0;
    for (const [socketId, rawSocket] of ns.sockets) {
        if (scanned >= MAX_SOCKET_REVOCATION_SCAN) {
            throw new Error("Listen Together socket scan exceeded its bound");
        }
        scanned += 1;
        const socket = rawSocket as RevocableSocket;
        if (socket.data.groupId === groupId && socket.data.userId === userId) {
            targets.add(socketId);
        }
    }
    return Array.from(targets);
}

function allGroupSocketRevocationTargets(
    ns: Namespace,
    groupId: string,
): string[] {
    const targets: string[] = [];
    let scanned = 0;
    for (const [socketId, rawSocket] of ns.sockets) {
        if (scanned >= MAX_SOCKET_REVOCATION_SCAN) {
            throw new Error("Listen Together socket scan exceeded its bound");
        }
        scanned += 1;
        const socket = rawSocket as RevocableSocket;
        if (socket.data.groupId === groupId) targets.push(socketId);
    }
    return targets;
}

async function revokeSocket(
    ns: Namespace,
    socketId: string,
    groupId: string,
    userId: string | undefined,
    metadata: MembershipFanoutMetadata | undefined,
    beforeRevoke: BeforeSocketRevocation,
): Promise<void> {
    const socket = ns.sockets.get(socketId) as RevocableSocket | undefined;
    if (!socket || socket.data.groupId !== groupId) return;
    if (userId && socket.data.userId !== userId) return;
    beforeRevoke(groupId, socket.data.userId);
    socket.emit("group:membership-revoked", { groupId, ...metadata });
    socket.data.groupId = null;
    await socket.leave(groupId);
}

async function endSocket(
    ns: Namespace,
    socketId: string,
    groupId: string,
    reason: string,
    beforeRevoke: BeforeSocketRevocation,
): Promise<void> {
    const socket = ns.sockets.get(socketId) as RevocableSocket | undefined;
    if (!socket || socket.data.groupId !== groupId) return;
    socket.emit("group:ended", { reason });
    await revokeSocket(
        ns,
        socketId,
        groupId,
        undefined,
        undefined,
        beforeRevoke,
    );
}

function userSocketRevocationTargets(
    ns: Namespace,
    userId: string,
    groupIds: UserRevocationGroups,
): Array<{ socketId: string; groupId: string }> {
    const allowedGroups =
        groupIds === "all-for-user" ? null : new Set(groupIds);
    const targets: Array<{ socketId: string; groupId: string }> = [];
    let scanned = 0;
    for (const [socketId, rawSocket] of ns.sockets) {
        if (scanned >= MAX_SOCKET_REVOCATION_SCAN) {
            throw new Error("Listen Together socket scan exceeded its bound");
        }
        scanned += 1;
        const socket = rawSocket as RevocableSocket;
        const groupId = socket.data.groupId;
        if (
            socket.data.userId === userId &&
            groupId !== null &&
            (!allowedGroups || allowedGroups.has(groupId))
        ) {
            targets.push({ socketId, groupId });
        }
    }
    return targets;
}

/** Evict committed departures by captured socket ID and durable user identity. */
export async function revokeGroupSockets(
    ns: Namespace,
    groupId: string,
    socketIds: string[],
    metadata: MembershipFanoutMetadata | undefined,
    userId: string | undefined,
    beforeRevoke: BeforeSocketRevocation,
): Promise<void> {
    const targets = socketRevocationTargets(ns, groupId, socketIds, userId);
    await Promise.all(
        targets.map((socketId) =>
            revokeSocket(ns, socketId, groupId, userId, metadata, beforeRevoke),
        ),
    );
}

/** Notify and evict every local socket after authority confirms group end. */
export async function endAllGroupSockets(
    ns: Namespace,
    groupId: string,
    reason: string,
    beforeRevoke: BeforeSocketRevocation,
): Promise<void> {
    const targets = allGroupSocketRevocationTargets(ns, groupId);
    await Promise.all(
        targets.map((socketId) =>
            endSocket(ns, socketId, groupId, reason, beforeRevoke),
        ),
    );
}

/** Evict a user's sockets without relying on local manager membership. */
export async function revokeUserSockets(
    ns: Namespace,
    userId: string,
    groupIds: UserRevocationGroups,
    metadata: MembershipFanoutMetadata | undefined,
    beforeRevoke: BeforeSocketRevocation,
    afterRevoke?: AfterMembershipRevocation,
): Promise<void> {
    const targets = userSocketRevocationTargets(ns, userId, groupIds);
    await Promise.all(
        targets.map(({ socketId, groupId }) =>
            revokeSocket(ns, socketId, groupId, userId, metadata, beforeRevoke),
        ),
    );
    const revokedGroupIds = new Set(targets.map((target) => target.groupId));
    for (const groupId of revokedGroupIds) afterRevoke?.(groupId, userId);
}

/** Bind cluster identity revocation to one Socket.IO namespace. */
export function createUserRevocationHandler(
    ns: Namespace,
    beforeRevoke: BeforeSocketRevocation,
    afterRevoke?: AfterMembershipRevocation,
): (
    revocation: ClusterUserRevocation,
    metadata: ClusterPublicationMetadata,
) => () => Promise<void> {
    return (revocation, metadata) => () =>
        revokeUserSockets(
            ns,
            revocation.userId,
            revocation.groupIds,
            {
                membershipVersion: metadata.fencingToken,
            },
            beforeRevoke,
            afterRevoke,
        );
}
