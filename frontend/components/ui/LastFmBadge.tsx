"use client";

interface LastFmBadgeProps {
    /** Extra classes for layout (margins, display, etc.) */
    className?: string;
}

/**
 * Renders the LastFmBadge component — a Last.fm logo icon in red.
 */
export function LastFmBadge({ className }: LastFmBadgeProps = {}) {
    return (
        <span
            className={`shrink-0 inline-flex items-center justify-center bg-[#D51007]/20 rounded p-1 ${className || ""}`.trim()}
            title="Last.fm"
        >
            <svg
                viewBox="0 0 24 24"
                className="w-3.5 h-3.5 text-[#D51007]"
                fill="currentColor"
                aria-hidden="true"
            >
                <path d="M10.584 17.21l-.88-2.392s-1.43 1.594-3.573 1.594c-1.897 0-3.244-1.649-3.244-4.288 0-3.382 1.704-4.591 3.381-4.591 2.422 0 3.19 1.567 3.849 3.574l.88 2.749c.88 2.666 2.529 4.81 7.285 4.81 3.409 0 5.718-1.044 5.718-3.793 0-2.227-1.265-3.381-3.63-3.931l-1.758-.385c-1.21-.275-1.567-.77-1.567-1.594 0-.935.742-1.484 1.952-1.484 1.32 0 2.034.495 2.144 1.677l2.749-.33c-.22-2.474-1.924-3.492-4.729-3.492-2.474 0-4.893.935-4.893 3.932 0 1.87.907 3.051 3.189 3.601l1.87.44c1.402.33 1.87.825 1.87 1.65 0 1.044-.907 1.484-2.612 1.484-2.529 0-3.574-1.32-4.178-3.134l-.907-2.803c-1.209-3.766-3.134-4.893-6.598-4.893C2.144 5.468 0 7.696 0 12.31c0 4.398 2.144 6.345 5.332 6.345 2.835 0 4.508-1.34 5.252-1.445z" />
            </svg>
        </span>
    );
}
