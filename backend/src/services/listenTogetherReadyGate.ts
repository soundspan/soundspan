import type { GroupState } from "./listenTogetherManager";

/** Clear one ready-gate timer and its published deadline. */
export function clearReadyGateTimer(group: GroupState): void {
    if (group.readyTimeout) clearTimeout(group.readyTimeout);
    group.readyTimeout = null;
    group.readyDeadlineMs = null;
}

/** Clear ready-gate timing and member votes. */
export function clearReadyGateState(group: GroupState): void {
    clearReadyGateTimer(group);
    group.readyUserIds.clear();
    for (const member of group.members.values()) member.isReady = false;
}

/** Reset member votes when playback enters a new ready gate. */
export function resetReadyGateVotes(group: GroupState): void {
    group.readyUserIds.clear();
    for (const member of group.members.values()) member.isReady = false;
}

/** Return the connected count when every connected member can start. */
export function readyConnectedMemberCount(group: GroupState): number | null {
    let connectedCount = 0;
    for (const member of group.members.values()) {
        if (member.socketIds.size === 0) continue;
        connectedCount += 1;
        const unavailable = member.unavailableIndices?.has(
            group.playback.currentIndex,
        );
        if (unavailable) {
            group.readyUserIds.add(member.userId);
            member.isReady = true;
            continue;
        }
        if (!group.readyUserIds.has(member.userId)) return null;
    }
    return connectedCount;
}

/** Count members with at least one current socket. */
export function connectedMemberCount(group: GroupState): number {
    let count = 0;
    for (const member of group.members.values()) {
        if (member.socketIds.size > 0) count += 1;
    }
    return count;
}

/** Return whether a completion still targets the current waiting gate. */
export function isExpectedReadyGate(
    group: GroupState | undefined,
    expectedIndex: number,
    expectedStateVersion: number,
): group is GroupState {
    return Boolean(
        group?.syncState === "waiting" &&
        group.playback.currentIndex === expectedIndex &&
        group.playback.stateVersion === expectedStateVersion,
    );
}

/** Arm a referenced timer that delegates due-gate ownership to the caller. */
export function armReadyGateTimer(
    group: GroupState,
    deadlineMs: number,
    onDue: () => void,
): void {
    clearReadyGateTimer(group);
    const now = Date.now();
    const safeDeadlineMs = Math.max(now, deadlineMs);
    group.readyDeadlineMs = safeDeadlineMs;
    const readyTimeout = setTimeout(
        () => {
            group.readyTimeout = null;
            onDue();
        },
        Math.max(0, safeDeadlineMs - now),
    );
    group.readyTimeout = readyTimeout;
    if (typeof readyTimeout.unref === "function") readyTimeout.unref();
}

/** Apply the synchronous playback state change for a completed ready gate. */
export function applyReadyGatePlayback(group: GroupState, now: number): void {
    clearReadyGateState(group);
    group.playback.isPlaying = true;
    group.playback.positionMs = 0;
    group.playback.lastPositionUpdate = now;
    group.playback.stateVersion += 1;
    group.syncState = "playing";
    group.dirty = true;
}
