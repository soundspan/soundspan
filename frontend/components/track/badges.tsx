/**
 * Shared badge primitives extracted from 8+ track list surfaces.
 * Each is a zero-prop span with the exact styling previously hardcoded inline.
 */

/**
 * Renders the InQueueBadge component.
 */
export function InQueueBadge() {
    return (
        <span className="shrink-0 text-[10px] bg-brand/15 text-brand-light px-1.5 py-0.5 rounded border border-brand/30 font-medium">
            IN QUEUE
        </span>
    );
}

/**
 * Renders the PreviewBadge component.
 */
export function PreviewBadge() {
    return (
        <span className="shrink-0 text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded font-medium">
            PREVIEW
        </span>
    );
}

/**
 * Renders the LoadingBadge component.
 */
export function LoadingBadge() {
    return (
        <span className="shrink-0 text-[10px] bg-gray-500/20 text-gray-300 px-1.5 py-0.5 rounded font-medium animate-pulse">
            LOADING
        </span>
    );
}

interface UnplayableBadgeProps {
    label?: string;
    title?: string;
    variant?: "warning" | "muted";
}

/**
 * Renders the UnplayableBadge component with optional reason-specific text.
 */
export function UnplayableBadge({
    label = "UNPLAYABLE",
    title,
    variant = "warning",
}: UnplayableBadgeProps = {}) {
    return (
        <span
            title={title}
            className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ${
                variant === "muted"
                    ? "bg-gray-500/20 text-gray-300"
                    : "bg-amber-500/20 text-amber-200"
            }`}
        >
            {label}
        </span>
    );
}
