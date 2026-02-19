"use client";

import { Play, Pause, RefreshCw, Settings, Loader2, Plus } from "lucide-react";
import { cn } from "@/utils/cn";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import type { DiscoverPlaylist, DiscoverConfig } from "../types";

interface BatchStatus {
    active: boolean;
    status: "downloading" | "scanning" | "generating" | null;
    progress?: number;
    completed?: number;
    failed?: number;
    total?: number;
}

interface DiscoverActionBarProps {
    playlist: DiscoverPlaylist | null;
    config: DiscoverConfig | null;
    isPlaylistPlaying: boolean;
    isPlaying: boolean;
    onPlayToggle: () => void;
    onGenerate: () => void;
    onToggleSettings: () => void;
    onAddToPlaylist?: () => void;
    isGenerating: boolean;
    batchStatus?: BatchStatus | null;
}

export function DiscoverActionBar({
    playlist,
    config,
    isPlaylistPlaying,
    isPlaying,
    onPlayToggle,
    onGenerate,
    onToggleSettings,
    onAddToPlaylist,
    isGenerating,
    batchStatus,
}: DiscoverActionBarProps) {
    const { showSpinner, triggerPlayFeedback } = usePlayButtonFeedback();

    const getStatusText = () => {
        if (!isGenerating) return null;
        
        if (batchStatus?.status === "scanning") {
            return "Finalizing recommendations...";
        }

        if (batchStatus?.status === "generating") {
            return "Refreshing recommendations...";
        }
        
        if (batchStatus?.total) {
            return `Progress ${batchStatus.completed || 0}%`;
        }
        
        return "Starting...";
    };

    const handlePlayToggle = () => {
        triggerPlayFeedback();
        onPlayToggle();
    };

    return (
        <div className="bg-gradient-to-b from-[#1a1a1a]/60 to-transparent px-4 md:px-8 py-4">
            <div className="flex items-center gap-4">
                {/* Play Button */}
                {playlist && playlist.tracks.length > 0 && (
                    <button
                        onClick={handlePlayToggle}
                        disabled={isGenerating}
                        className={cn(
                            "flex items-center gap-2 px-5 py-2.5 rounded-full shadow-lg transition-all border font-semibold text-sm",
                            isGenerating
                                ? "bg-white/5 border-transparent text-white/50 cursor-not-allowed"
                                : "bg-[#1a1acc]/20 hover:bg-[#1a1acc]/30 border-[#2323FF]/30 text-white hover:scale-105"
                        )}
                    >
                        {showSpinner ? (
                            <Loader2 className="w-5 h-5 animate-spin" />
                        ) : isPlaylistPlaying && isPlaying ? (
                            <Pause className="w-5 h-5 fill-current" />
                        ) : (
                            <Play className="w-5 h-5 fill-current ml-0.5" />
                        )}
                        <span>{isPlaylistPlaying && isPlaying ? "Pause" : "Play All"}</span>
                    </button>
                )}

                {/* Generate Button */}
                <button
                    onClick={onGenerate}
                    disabled={isGenerating || !config?.enabled}
                    className={cn(
                        "flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all",
                        isGenerating || !config?.enabled
                            ? "bg-white/5 text-white/50 cursor-not-allowed"
                            : "bg-[#1a1acc]/20 hover:bg-[#1a1acc]/30 text-white border border-[#2323FF]/30"
                    )}
                >
                    {isGenerating ? (
                        <>
                            <GradientSpinner size="sm" />
                            <span className="hidden sm:inline">{getStatusText()}</span>
                            <span className="sm:hidden">
                                {batchStatus?.completed || 0}/{batchStatus?.total || "?"}
                            </span>
                        </>
                    ) : (
                        <>
                            <RefreshCw className="w-4 h-4" />
                            <span className="hidden sm:inline">
                                {playlist ? "Regenerate" : "Generate"}
                            </span>
                        </>
                    )}
                </button>

                {/* Settings Button */}
                <button
                    onClick={onToggleSettings}
                    disabled={isGenerating}
                    className={cn(
                        "h-8 w-8 rounded-full flex items-center justify-center transition-all",
                        isGenerating
                            ? "text-white/30 cursor-not-allowed"
                            : "text-white/60 hover:text-white hover:bg-white/10"
                    )}
                    title="Settings"
                >
                    <Settings className="w-5 h-5" />
                </button>

                {/* Add to Playlist Button */}
                {playlist && playlist.tracks.length > 0 && onAddToPlaylist && (
                    <button
                        onClick={onAddToPlaylist}
                        className="h-8 w-8 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-all"
                        title="Add all to playlist"
                    >
                        <Plus className="w-5 h-5" />
                    </button>
                )}
            </div>
        </div>
    );
}
