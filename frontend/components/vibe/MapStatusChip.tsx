"use client";

/**
 * MapStatusChip — the bottom-right glass pill that says when the map was
 * built and how many songs it holds, flags a sampled map, and (for admins)
 * offers a rebuild. Presentational; the data hook owns the rebuild lifecycle
 * and `describeMapStatus` owns the copy.
 *
 * Lifted above the mobile mini player via --vibe-binset like every other
 * bottom-floating map surface.
 */

import { Loader2, RefreshCw } from "lucide-react";
import type { MapStatusView } from "./mapStatus";

export interface MapStatusChipProps {
    status: MapStatusView;
    /** Admins only: the server rejects rebuilds from other roles. */
    canRebuild: boolean;
    onRebuild: () => void;
    /** Small screens hide the button label and keep the icon. */
    compact?: boolean;
}

const BUTTON_CLASS =
    "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full text-xs " +
    "text-gray-200 hover:text-white hover:bg-white/10 transition-colors " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 " +
    "disabled:opacity-40 disabled:hover:bg-transparent";

function SampleBadge() {
    return (
        <span
            className="rounded-full border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-200"
            title="Random sample of your library"
        >
            Sample
        </span>
    );
}

function RebuildButton({
    busy,
    compact,
    onRebuild,
}: {
    busy: boolean;
    compact: boolean;
    onRebuild: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onRebuild}
            disabled={busy}
            aria-label="Rebuild map"
            title="Drop the cached map and build a fresh one now"
            className={BUTTON_CLASS}
        >
            {busy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
                <RefreshCw className="w-3.5 h-3.5" />
            )}
            {!compact && <span>Rebuild</span>}
        </button>
    );
}

/** Render the map freshness chip and its optional admin rebuild action. */
export function MapStatusChip({
    status,
    canRebuild,
    onRebuild,
    compact = false,
}: MapStatusChipProps) {
    return (
        <div
            className="pointer-events-none absolute right-3 z-30 max-w-[92%]"
            style={{ bottom: "calc(0.75rem + var(--vibe-binset, 0px))" }}
            data-vibe-panel="map-status"
        >
            <div
                className="pointer-events-auto inline-flex items-center gap-2 h-10 pl-3 pr-1.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 shadow-lg text-xs text-gray-300"
                title={status.detail}
            >
                <span
                    role="status"
                    aria-live="polite"
                    className="tabular-nums whitespace-nowrap"
                >
                    {status.summary}
                </span>
                {status.sampled && <SampleBadge />}
                {canRebuild && (
                    <RebuildButton
                        busy={status.busy}
                        compact={compact}
                        onRebuild={onRebuild}
                    />
                )}
            </div>
        </div>
    );
}
