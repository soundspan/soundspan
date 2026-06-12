"use client";

interface YouTubeBadgeProps {
    /** Extra classes for layout (margins, display, etc.) */
    className?: string;
}

/**
 * Renders the YouTubeBadge component — a YouTube icon in red.
 */
export function YouTubeBadge({ className }: YouTubeBadgeProps = {}) {
    return (
        <span
            className={`shrink-0 inline-flex items-center justify-center bg-red-500/20 rounded p-1 ${className || ""}`.trim()}
            title="YouTube Music"
        >
            <svg
                viewBox="0 0 24 24"
                className="w-3.5 h-3.5 text-red-400"
                fill="currentColor"
                aria-hidden="true"
            >
                <path d="M21.58 7.19c-.23-.86-.91-1.54-1.77-1.77C18.25 5 12 5 12 5s-6.25 0-7.81.42c-.86.23-1.54.91-1.77 1.77C2 8.75 2 12 2 12s0 3.25.42 4.81c.23.86.91 1.54 1.77 1.77C5.75 19 12 19 12 19s6.25 0 7.81-.42c.86-.23 1.54-.91 1.77-1.77C22 15.25 22 12 22 12s0-3.25-.42-4.81zM10 15V9l5.2 3-5.2 3z" />
            </svg>
        </span>
    );
}
