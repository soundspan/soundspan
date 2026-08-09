/**
 * Pure index math for TrackList drag-and-drop reordering (GH #27).
 * The DOM/drag-event wiring lives in TrackList; every decision that can
 * be wrong lives here where it is unit-testable.
 */

/** Which side of the hovered row a drop would insert on. */
export type DropPosition = "before" | "after";

/**
 * Splits a hovered row at its vertical midpoint: drops in the top half
 * insert before it, bottom half after it.
 */
export function resolveDropPosition(
    offsetY: number,
    rowHeight: number,
): DropPosition {
    if (!(rowHeight > 0)) {
        return "after";
    }
    return offsetY < rowHeight / 2 ? "before" : "after";
}

/**
 * Resolves the final index for splice semantics (remove the dragged row,
 * then insert at the returned index). Returns `fromIndex` unchanged for
 * no-op drops (onto itself, or immediately adjacent positions).
 */
export function resolveDropTargetIndex(
    fromIndex: number,
    overIndex: number,
    position: DropPosition,
): number {
    const insertionIndex = position === "after" ? overIndex + 1 : overIndex;
    // After removing the dragged row, insertion points past it shift
    // down by one.
    const target =
        fromIndex < insertionIndex ? insertionIndex - 1 : insertionIndex;
    return target;
}

/**
 * Resolves the destination index for keyboard reordering.
 * Returns `null` when the key or requested movement cannot reorder the item.
 */
export function resolveKeyboardReorderTarget(
    key: string,
    index: number,
    count: number,
): number | null {
    if (count <= 1 || index < 0 || index >= count) {
        return null;
    }
    if (key === "ArrowUp") {
        return index > 0 ? index - 1 : null;
    }
    if (key === "ArrowDown") {
        return index < count - 1 ? index + 1 : null;
    }
    if (key === "Home") {
        return index > 0 ? 0 : null;
    }
    if (key === "End") {
        return index < count - 1 ? count - 1 : null;
    }
    return null;
}
