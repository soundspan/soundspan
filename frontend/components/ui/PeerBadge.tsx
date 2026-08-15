"use client";

import { Network } from "lucide-react";
import { cn } from "@/utils/cn";

interface PeerBadgeProps {
    peerName: string;
    online: boolean;
    className?: string;
}

/** Shows federation provenance and visually mutes an offline peer. */
export function PeerBadge({ peerName, online, className }: PeerBadgeProps) {
    return (
        <span
            className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-gray-200",
                !online && "opacity-50",
                className,
            )}
            title={`From ${peerName}`}
        >
            <Network className="h-3 w-3" aria-hidden="true" />
            <span className="max-w-24 truncate">{peerName}</span>
        </span>
    );
}
