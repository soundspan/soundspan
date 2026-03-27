import path from "node:path";

export function safeResolvePath(base: string, untrusted: string): string | null {
    const resolvedBase = path.resolve(base);
    const resolvedTarget = path.resolve(resolvedBase, untrusted);

    if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
        return null;
    }

    return resolvedTarget;
}
