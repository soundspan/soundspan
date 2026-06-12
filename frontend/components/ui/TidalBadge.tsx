"use client";

interface TidalBadgeProps {
    /** Extra classes for layout (margins, display, etc.) */
    className?: string;
}

/**
 * Renders the TidalBadge component — a TIDAL logo icon in cyan.
 */
export function TidalBadge({ className }: TidalBadgeProps = {}) {
    return (
        <span
            className={`shrink-0 inline-flex items-center justify-center bg-[#00BFFF]/20 rounded p-1 ${className || ""}`.trim()}
            title="TIDAL"
        >
            <svg
                viewBox="0 0 12 8"
                className="w-3.5 h-2.5 text-[#00BFFF]"
                fill="currentColor"
                aria-hidden="true"
            >
                {/* Three diamonds top row + one below center */}
                <path d="M2 0 L4 2 L2 4 L0 2Z" />
                <path d="M6 0 L8 2 L6 4 L4 2Z" />
                <path d="M10 0 L12 2 L10 4 L8 2Z" />
                <path d="M6 4 L8 6 L6 8 L4 6Z" />
            </svg>
        </span>
    );
}
