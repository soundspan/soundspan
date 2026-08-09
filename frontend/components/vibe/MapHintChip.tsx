"use client";

/**
 * MapHintChip — the bottom-center whisper teaching the map's grammar for the
 * current mode (text chosen by the pure `hintForMode`). Presentational;
 * VibeMap owns visibility (hidden while the sweep chip / fullscreen Esc hint
 * own bottom-center, or on small screens while a mode sheet covers it) and
 * the session-scoped dismissal.
 *
 * Lifted above the mobile mini player via --vibe-binset like every other
 * bottom-floating map surface.
 */

import { X } from "lucide-react";

export interface MapHintChipProps {
    text: string;
    onDismiss: () => void;
}

export function MapHintChip({ text, onDismiss }: MapHintChipProps) {
    return (
        <div
            className="absolute left-1/2 -translate-x-1/2 z-30 max-w-[92%]"
            style={{ bottom: "calc(1rem + var(--vibe-binset, 0px))" }}
            data-vibe-panel="hint"
        >
            <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-black/50 backdrop-blur-md border border-white/10 shadow-lg pl-3 pr-1 py-1">
                <span className="text-xs text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis">
                    {text}
                </span>
                <button
                    type="button"
                    onClick={onDismiss}
                    aria-label="Hide hints"
                    title="Hide hints for this session"
                    className="flex items-center justify-center w-7 h-7 rounded-full text-gray-400 hover:text-white hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>
        </div>
    );
}
