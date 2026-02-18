"use client";

import {
    type TidalStreamQuality,
    formatTidalQualityBadge,
} from "@/hooks/useStreamBitrate";

interface TidalBadgeProps {
    /** Quality info from useStreamBitrate — omit for a plain "TIDAL" label */
    quality?: TidalStreamQuality | null;
    /** Extra classes for layout (margins, display, etc.) */
    className?: string;
}

export function TidalBadge({ quality, className }: TidalBadgeProps = {}) {
    const label = quality ? formatTidalQualityBadge(quality) || "TIDAL" : "TIDAL";

    return (
        <span
            className={`shrink-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[10px] font-bold bg-[#00BFFF]/20 text-[#00BFFF] px-1.5 py-0.5 rounded ${className || ""}`.trim()}
            title={label}
        >
            {label}
        </span>
    );
}
