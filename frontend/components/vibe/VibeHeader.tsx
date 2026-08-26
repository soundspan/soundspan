"use client";

import { AudioWaveform, Map, RefreshCw, Shuffle, Waves } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { FilterPills } from "@/components/ui/FilterPills";
import { cn } from "@/utils/cn";

export type VibeTab = "explore" | "map";

interface VibeHeaderProps {
    currentTrack: { id: string; title: string } | null;
    sourceTrackId: string | null;
    isLoading: boolean;
    hasLibraryTracks: boolean;
    embeddedTrackCount: number | null;
    vibeTab: VibeTab;
    onTabChange: (tab: VibeTab) => void;
    onUseCurrentTrack: () => void;
    onRandomTrack: () => void;
    onRefresh: () => void;
}

/** Header actions: seed from the playing track, a random track, or refresh. */
function VibeHeaderActions({
    currentTrack,
    sourceTrackId,
    isLoading,
    hasLibraryTracks,
    onUseCurrentTrack,
    onRandomTrack,
    onRefresh,
}: Omit<VibeHeaderProps, "embeddedTrackCount" | "vibeTab" | "onTabChange">) {
    return (
        <>
            {currentTrack && (
                <button
                    onClick={onUseCurrentTrack}
                    disabled={isLoading}
                    className={cn(
                        "flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors disabled:opacity-50",
                        sourceTrackId === currentTrack.id
                            ? "text-brand bg-brand/10"
                            : "text-content-muted hover:text-white hover:bg-white/5",
                    )}
                    title={`Find tracks similar to "${currentTrack.title}"`}
                >
                    <AudioWaveform className="w-4 h-4" />
                    <span className="hidden sm:inline">Now Playing</span>
                </button>
            )}
            <button
                onClick={onRandomTrack}
                disabled={isLoading || !hasLibraryTracks}
                className="flex items-center gap-2 px-3 py-1.5 text-sm text-content-muted hover:text-white hover:bg-white/5 rounded-md transition-colors disabled:opacity-50"
            >
                <Shuffle className="w-4 h-4" />
                <span className="hidden sm:inline">Random</span>
            </button>
            <button
                onClick={onRefresh}
                disabled={isLoading}
                className="p-1.5 text-content-muted hover:text-white hover:bg-white/5 rounded-md transition-colors disabled:opacity-50"
            >
                <RefreshCw
                    className={cn("w-4 h-4", isLoading && "animate-spin")}
                />
            </button>
        </>
    );
}

const TAB_OPTIONS = [
    {
        value: "explore" as const,
        label: (
            <span className="flex items-center gap-2">
                <AudioWaveform className="w-4 h-4" />
                Explore
            </span>
        ),
    },
    {
        value: "map" as const,
        label: (
            <span className="flex items-center gap-2">
                <Map className="w-4 h-4" />
                Map
            </span>
        ),
    },
];

/**
 * Renders the Vibe page header: title, seed actions, and the
 * Explore / Map view toggle.
 */
export function VibeHeader(props: VibeHeaderProps) {
    const { embeddedTrackCount, vibeTab, onTabChange } = props;
    return (
        <>
            <PageHeader
                title="Vibe"
                subtitle={
                    embeddedTrackCount != null
                        ? `${embeddedTrackCount.toLocaleString()} tracks with audio fingerprints`
                        : undefined
                }
                icon={Waves}
                className="mb-0"
                actions={<VibeHeaderActions {...props} />}
            />
            <FilterPills
                options={TAB_OPTIONS}
                value={vibeTab}
                onChange={onTabChange}
                size="segmented"
                className="mt-4 w-fit"
                aria-label="Vibe view"
            />
        </>
    );
}
