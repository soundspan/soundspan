"use client";

/**
 * YouTubeBadge — small red badge shown on tracks that are being
 * streamed from YouTube rather than the local library.
 */

interface YouTubeBadgeProps {
    /** Extra classes for layout (margins, display, etc.) */
    className?: string;
}

export function YouTubeBadge({ className }: YouTubeBadgeProps = {}) {
    return (
        <span
            className={`shrink-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[10px] font-bold bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded ${className || ""}`.trim()}
            title="YOUTUBE"
        >
            YOUTUBE
        </span>
    );
}
