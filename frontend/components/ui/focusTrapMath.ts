/**
 * Returns the next focusable-element index for Tab navigation within a trap.
 */
export function nextFocusIndex(
    count: number,
    currentIndex: number,
    shiftKey: boolean,
): number {
    if (count <= 0) return -1;
    if (currentIndex === -1) return shiftKey ? count - 1 : 0;
    if (shiftKey) return (currentIndex - 1 + count) % count;
    return (currentIndex + 1) % count;
}
