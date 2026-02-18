"use client";

/**
 * YouTubeBadge — small red badge shown on tracks that are being
 * streamed from YouTube Music rather than the local library.
 */

import React from "react";
import { cn } from "@/utils/cn";

interface YouTubeBadgeProps {
    className?: string;
    /** Show a compact version (icon-only) */
    compact?: boolean;
}

export function YouTubeBadge({ className, compact = false }: YouTubeBadgeProps) {
    return (
        <span
            className={cn(
                "shrink-0 inline-flex items-center gap-1 font-medium rounded border",
                "bg-red-500/20 text-red-400 border-red-500/30",
                compact
                    ? "text-[9px] px-1 py-0.5"
                    : "text-[10px] px-1.5 py-0.5",
                className
            )}
            title="Streaming from YouTube Music"
        >
            {/* Simple YT play-button icon via SVG */}
            <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                className={compact ? "w-2.5 h-2.5" : "w-3 h-3"}
            >
                <path d="M21.543 6.498C22 8.28 22 12 22 12s0 3.72-.457 5.502c-.254.985-.997 1.76-1.938 2.022C17.896 20 12 20 12 20s-5.893 0-7.605-.476c-.945-.266-1.687-1.04-1.938-2.022C2 15.72 2 12 2 12s0-3.72.457-5.502c.254-.985.997-1.76 1.938-2.022C6.107 4 12 4 12 4s5.896 0 7.605.476c.945.266 1.687 1.04 1.938 2.022ZM10 15.5l6-3.5-6-3.5v7Z" />
            </svg>
            {!compact && "YT MUSIC"}
        </span>
    );
}
