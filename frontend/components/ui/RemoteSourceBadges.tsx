"use client";

import { TidalBadge } from "./TidalBadge";
import { YouTubeBadge } from "./YouTubeBadge";

/** Streaming providers that have a badge. */
export type RemoteBadgeSource = "tidal" | "youtube";

const BADGE_ORDER: readonly RemoteBadgeSource[] = ["tidal", "youtube"];
const SOURCE_NAMES: Record<RemoteBadgeSource, string> = {
    tidal: "TIDAL",
    youtube: "YouTube Music",
};

interface RemoteSourceBadgesProps {
    sources: readonly RemoteBadgeSource[] | null | undefined;
    className?: string;
}

/**
 * Marks an item as coming from a streaming service: one badge per provider,
 * TIDAL first, with a screen-reader label.
 */
export function RemoteSourceBadges({
    sources,
    className,
}: RemoteSourceBadgesProps) {
    const shown = BADGE_ORDER.filter((source) => sources?.includes(source));
    if (shown.length === 0) return null;
    const label = `From ${shown.map((source) => SOURCE_NAMES[source]).join(" and ")}`;
    return (
        <span
            className={`inline-flex shrink-0 items-center gap-1 ${className ?? ""}`.trim()}
        >
            <span className="sr-only">{label}</span>
            {shown.map((source) =>
                source === "tidal" ? (
                    <TidalBadge key={source} />
                ) : (
                    <YouTubeBadge key={source} />
                ),
            )}
        </span>
    );
}
