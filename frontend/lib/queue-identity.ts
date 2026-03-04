/**
 * Returns `prevSet` when the contents of `nextSet` are identical, preserving
 * referential identity and preventing downstream re-renders.  Returns `nextSet`
 * when the contents differ or `prevSet` is null.
 */
export function resolveStableQueuedTrackIdSet(
    nextSet: ReadonlySet<string>,
    prevSet: ReadonlySet<string> | null,
): ReadonlySet<string> {
    if (!prevSet) return nextSet;
    if (nextSet.size !== prevSet.size) return nextSet;
    for (const id of nextSet) {
        if (!prevSet.has(id)) return nextSet;
    }
    return prevSet;
}
