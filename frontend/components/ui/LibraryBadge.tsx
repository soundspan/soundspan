"use client";

import { Library } from "lucide-react";

interface LibraryBadgeProps {
    /** Extra classes for layout (margins, display, etc.) */
    className?: string;
}

/**
 * Renders the LibraryBadge component — a library icon in emerald green.
 */
export function LibraryBadge({ className }: LibraryBadgeProps = {}) {
    return (
        <span
            className={`shrink-0 inline-flex items-center justify-center bg-emerald-500/20 rounded p-1 ${className || ""}`.trim()}
            title="Your Library"
        >
            <Library className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
        </span>
    );
}
