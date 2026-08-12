const MAX_ROUTER_LAYERS = 10_000;

/**
 * Flattens mounted library sub-routers in registration order for focused
 * direct-handler tests.
 */
export function flattenLibraryRouteLayers(router: unknown): any[] {
    const rootStack = (router as { stack?: any[] }).stack ?? [];
    const pending = [...rootStack].reverse();
    const routes: any[] = [];
    let visited = 0;

    while (pending.length > 0 && visited < MAX_ROUTER_LAYERS) {
        visited += 1;
        const layer = pending.pop();
        if (!layer) continue;
        if (layer.route) {
            routes.push(layer);
            continue;
        }

        const childStack = layer.handle?.stack;
        if (!childStack) continue;
        for (let index = childStack.length - 1; index >= 0; index -= 1) {
            pending.push(childStack[index]);
        }
    }

    if (pending.length > 0) {
        throw new Error(
            `Library router exceeds ${MAX_ROUTER_LAYERS} nested layers`,
        );
    }
    return routes;
}
