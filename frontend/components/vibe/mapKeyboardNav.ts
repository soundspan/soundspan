/** A keyboard navigation outcome for the vibe map. */
export type MapKeyNavResult =
    | { type: "move"; index: number }
    | { type: "select"; index: number }
    | { type: "none" };

/** The visible track order and current track focus. */
export interface MapKeyNavContext {
    order: readonly number[];
    focusedIndex: number | null;
}

/** Resolve a keyboard input without depending on React or the DOM. */
export function resolveMapKeyNav(
    key: string,
    ctx: MapKeyNavContext,
): MapKeyNavResult {
    if (ctx.order.length === 0) return { type: "none" };
    const position =
        ctx.focusedIndex === null ? -1 : ctx.order.indexOf(ctx.focusedIndex);
    if (key === "ArrowRight" || key === "ArrowDown") {
        const next =
            position < 0 ? 0 : Math.min(position + 1, ctx.order.length - 1);
        return { type: "move", index: ctx.order[next] };
    }
    if (key === "ArrowLeft" || key === "ArrowUp") {
        const previous = position < 0 ? 0 : Math.max(position - 1, 0);
        return { type: "move", index: ctx.order[previous] };
    }
    if (key === "Home") return { type: "move", index: ctx.order[0] };
    if (key === "End") {
        return { type: "move", index: ctx.order[ctx.order.length - 1] };
    }
    if (key === "Enter" || key === " " || key === "Spacebar") {
        if (position < 0 || ctx.focusedIndex === null) return { type: "none" };
        return { type: "select", index: ctx.focusedIndex };
    }
    return { type: "none" };
}
