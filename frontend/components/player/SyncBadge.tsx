"use client";

import { memo } from "react";
import Link from "next/link";
import { Users } from "lucide-react";
import { useListenTogether } from "@/lib/listen-together-context";
import { cn } from "@/utils/cn";

interface SyncBadgeProps {
    /** Use compact styling for the mini player. */
    compact?: boolean;
}

/**
 * Small indicator badge shown in the player when the user is in a
 * Listen Together group. Clicking it navigates to the group page.
 * Renders nothing when not in a group.
 */
const SyncBadge = memo(function SyncBadge({ compact = false }: SyncBadgeProps) {
    const { isInGroup, activeGroup, isConnected } = useListenTogether();

    if (!isInGroup || !activeGroup) return null;

    const memberCount = activeGroup.members.length;

    return (
        <Link
            href="/listen-together"
            prefetch={false}
            className={cn(
                "inline-flex items-center gap-1 font-bold rounded transition-colors",
                isConnected
                    ? "bg-purple-500/20 text-purple-400 hover:bg-purple-500/30"
                    : "bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30",
                compact
                    ? "text-[9px] px-1 py-0.5 leading-none"
                    : "text-[10px] px-1.5 py-0.5"
            )}
            title={`Listen Together — ${memberCount} listener${memberCount === 1 ? "" : "s"}`}
        >
            <Users className={compact ? "w-2.5 h-2.5" : "w-3 h-3"} />
            {!compact && <>{memberCount}</>}
        </Link>
    );
});

export { SyncBadge };
