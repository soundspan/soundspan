import { prisma } from "../utils/db";
import { withListenTogetherDeadlineAt } from "./listenTogetherDeadline";
import { drainLocalGroupMutationTails } from "./listenTogetherMutationLock";

const GROUP_PAGE_SIZE = 250;
const MAX_GROUP_PAGES = 400;

async function collectCurrentGroupIds(
    userId: string,
    deadlineAtMs: number,
    signal: AbortSignal,
): Promise<string[]> {
    const groupIds: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_GROUP_PAGES; page += 1) {
        signal.throwIfAborted();
        const query = prisma.syncGroup.findMany({
            where: {
                OR: [{ hostUserId: userId }, { members: { some: { userId } } }],
            },
            select: { id: true },
            orderBy: { id: "asc" },
            take: GROUP_PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        const rows = await withListenTogetherDeadlineAt(
            query,
            "Listen Together user group collection",
            deadlineAtMs,
            signal,
        );
        signal.throwIfAborted();
        groupIds.push(...rows.map(({ id }) => id));
        if (rows.length < GROUP_PAGE_SIZE) return groupIds;
        cursor = rows[rows.length - 1]?.id;
        if (!cursor) throw new Error("Group page lacked a terminal record");
    }
    throw new Error("Listen Together group quiescence page limit reached");
}

/** Wait for local mutations admitted before a user's deletion reservation. */
export async function quiesceListenTogetherUserGroups(
    userId: string,
    deadlineAtMs: number,
    signal: AbortSignal,
): Promise<void> {
    const groupIds = await collectCurrentGroupIds(userId, deadlineAtMs, signal);
    signal.throwIfAborted();
    const drain = drainLocalGroupMutationTails(groupIds, deadlineAtMs);
    const result = await withListenTogetherDeadlineAt(
        drain,
        "Listen Together user mutation quiescence",
        deadlineAtMs,
        signal,
    );
    if (!result.drained) {
        throw new Error("Listen Together user mutation quiescence timed out");
    }
}
