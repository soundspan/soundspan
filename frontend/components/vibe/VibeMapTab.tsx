"use client";

/** Full-bleed host surface for the map tab on the Vibe page. */

import { AudioWaveform, Map } from "lucide-react";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { MOBILE_PLAYER_CLEARANCE_PX, VibeMap } from "./VibeMap";

/** Host inputs for the full-bleed map tab. */
export interface VibeMapTabProps {
    currentTrackPresent: boolean;
    onExplore: () => void;
}

/** Render the immersive map and its compact Explore/Map switcher. */
export function VibeMapTab({ currentTrackPresent, onExplore }: VibeMapTabProps) {
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const playerOverlapsMap = (isMobile || isTablet) && currentTrackPresent;
    const header = <div className="pointer-events-auto flex gap-0.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 p-1 shadow-lg">
        <button type="button" onClick={onExplore}
            className="flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-medium text-gray-300 hover:text-white hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60">
            <AudioWaveform className="w-3.5 h-3.5" />Explore
        </button>
        <button type="button" aria-pressed aria-label="Map view (current)"
            className="flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-medium bg-white/15 text-white">
            <Map className="w-3.5 h-3.5" />Map
        </button>
    </div>;
    return <div className="absolute inset-0 overflow-hidden bg-[#0a0a0a]">
        <VibeMap headerSlot={header}
            bottomInset={playerOverlapsMap ? MOBILE_PLAYER_CLEARANCE_PX : 0} />
    </div>;
}
