import type { LibraryOrigin } from "@/hooks/useQueries";

/** Which optional Library sources this viewer can browse. */
export interface LibraryOriginAvailability {
    /** Federation is enabled, so peer libraries can appear. */
    federation: boolean;
    /** A streaming provider is connected, so liked remote tracks can appear. */
    remote: boolean;
}

const ORIGIN_LABELS: Record<LibraryOrigin, string> = {
    all: "All",
    local: "Local",
    peers: "Peers",
    remote: "Remote",
};

/**
 * Lists the origin pills to offer. Returns an empty list when "All" and
 * "Local" would be the only choices, because they mean the same thing then.
 */
export function listLibraryOrigins(
    availability: LibraryOriginAvailability,
): LibraryOrigin[] {
    const origins: LibraryOrigin[] = ["all", "local"];
    if (availability.federation) origins.push("peers");
    if (availability.remote) origins.push("remote");
    return origins.length > 2 ? origins : [];
}

/** Falls back to "all" when the selected origin is no longer offered. */
export function resolveLibraryOrigin(
    selected: LibraryOrigin,
    offered: readonly LibraryOrigin[],
): LibraryOrigin {
    if (selected === "all") return selected;
    return offered.includes(selected) ? selected : "all";
}

/** Human label for an origin pill. */
export function getLibraryOriginLabel(origin: LibraryOrigin): string {
    return ORIGIN_LABELS[origin];
}
