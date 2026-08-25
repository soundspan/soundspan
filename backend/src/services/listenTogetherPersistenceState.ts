import type { GroupState } from "./listenTogetherTypes";

/** Make a captured group reference ineligible for persistence. */
export function invalidateGroupPersistence(group: GroupState): void {
    group.dirty = false;
    group.playbackAuthoritative = false;
    group.persistenceValid = false;
}

/** Return whether one dirty group has completed its publication pipeline. */
export function isGroupPersistenceEligible(group: GroupState): boolean {
    return (
        group.dirty &&
        group.persistenceValid &&
        group.lastPublishedStateVersion >= group.playback.stateVersion
    );
}

/** Advance the highest fully published state version. */
export function confirmGroupPublication(group: GroupState): void {
    if (!group.persistenceValid) return;
    group.lastPublishedStateVersion = Math.max(
        group.lastPublishedStateVersion,
        group.playback.stateVersion,
    );
}
