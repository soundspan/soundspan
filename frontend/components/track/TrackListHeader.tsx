import { cn } from "@/utils/cn";
import type { TrackListHeaderProps } from "./types";

/**
 * Renders the TrackListHeader component.
 *
 * Reusable column header row matching the grid template of a TrackList.
 * Hidden on mobile by default, shown at md breakpoint.
 */
export function TrackListHeader({ columns, className }: TrackListHeaderProps) {
    return (
        <div
            className={cn(
                "hidden md:grid items-center text-xs text-gray-500 uppercase tracking-wider border-b border-white/10 px-3 py-2",
                className,
            )}
        >
            {columns.map((col) => (
                <div key={col.label} className={col.className}>
                    {col.label}
                </div>
            ))}
        </div>
    );
}
