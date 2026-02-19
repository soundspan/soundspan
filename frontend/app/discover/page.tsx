"use client";

import { useState } from "react";
import { RefreshCw, Music2 } from "lucide-react";
import { cn } from "@/utils/cn";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useAudioState, useAudioPlayback } from "@/lib/audio-context";
import { useDiscoverData } from "@/features/discover/hooks/useDiscoverData";
import { useDiscoverActions } from "@/features/discover/hooks/useDiscoverActions";
import { useDiscoverProviderGapFill } from "@/features/discover/hooks/useDiscoverProviderGapFill";
import { usePreviewPlayer } from "@/features/discover/hooks/usePreviewPlayer";
import { DiscoverHero } from "@/features/discover/components/DiscoverHero";
import { DiscoverActionBar } from "@/features/discover/components/DiscoverActionBar";
import { DiscoverSettings } from "@/features/discover/components/DiscoverSettings";
import { TrackList } from "@/features/discover/components/TrackList";
import { UnavailableAlbums } from "@/features/discover/components/UnavailableAlbums";
import { HowItWorks } from "@/features/discover/components/HowItWorks";

export default function DiscoverWeeklyPage() {
    // Use split hooks to avoid re-renders from currentTime updates
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const [showSettings, setShowSettings] = useState(false);

    // Custom hooks - single source of truth for batch status from useDiscoverData
    const {
        playlist,
        config,
        setConfig,
        loading,
        reloadData,
        batchStatus,
        refreshBatchStatus,
        setPendingGeneration,
        isGenerating,
    } = useDiscoverData();
    const { tracks: providerEnrichedTracks, providerCounts } =
        useDiscoverProviderGapFill(playlist?.tracks);
    const displayPlaylist = playlist
        ? { ...playlist, tracks: providerEnrichedTracks }
        : null;
    const {
        handleGenerate,
        handlePlayPlaylist,
        handlePlayTrack,
        handleTogglePlay,
    } = useDiscoverActions(
        displayPlaylist,
        isGenerating,
        refreshBatchStatus,
        setPendingGeneration
    );
    const { currentPreview, handleTogglePreview } = usePreviewPlayer();

    // Check if we're playing from this playlist
    const isPlaylistPlaying = displayPlaylist?.tracks.some(
        (t) => t.id === currentTrack?.id
    );

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    return (
        <div className="min-h-screen">
            <DiscoverHero playlist={displayPlaylist} config={config} />

            <DiscoverActionBar
                playlist={displayPlaylist}
                config={config}
                isPlaylistPlaying={isPlaylistPlaying || false}
                isPlaying={isPlaying}
                onPlayToggle={isPlaylistPlaying && isPlaying ? handleTogglePlay : handlePlayPlaylist}
                onGenerate={handleGenerate}
                onToggleSettings={() => setShowSettings(!showSettings)}
                isGenerating={isGenerating}
                batchStatus={batchStatus}
            />

            {showSettings && (
                <DiscoverSettings
                    config={config}
                    onUpdateConfig={setConfig}
                    onPlaylistCleared={reloadData}
                />
            )}

            {/* Track Listing */}
            <div className="px-2 md:px-8 pb-32">
                {displayPlaylist && displayPlaylist.tracks.length > 0 ? (
                        <div className="space-y-6">
                            <p className="text-xs text-gray-400">
                                Source mix: {providerCounts.local} local
                                {providerCounts.tidal > 0
                                    ? ` • ${providerCounts.tidal} TIDAL gap-fill`
                                    : ""}
                                {providerCounts.youtube > 0
                                    ? ` • ${providerCounts.youtube} YouTube Music gap-fill`
                                    : ""}
                            </p>
                            <TrackList
                                tracks={displayPlaylist.tracks}
                                currentTrack={currentTrack}
                                isPlaying={isPlaying}
                                onPlayTrack={handlePlayTrack}
                                onTogglePlay={handleTogglePlay}
                            />

                            <UnavailableAlbums
                                unavailable={displayPlaylist.unavailable}
                                currentPreview={currentPreview}
                                onTogglePreview={handleTogglePreview}
                            />

                            <HowItWorks />
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-24 text-center">
                            <div className="w-20 h-20 bg-gradient-to-br from-[#1a1acc]/20 to-yellow-600/20 rounded-full flex items-center justify-center mb-4 shadow-xl border border-white/10">
                                <Music2 className="w-10 h-10 text-[#5b5bff]" />
                            </div>
                            <h3 className="text-lg font-medium text-white mb-1">
                                No Discover Weekly Yet
                            </h3>
                            <p className="text-sm text-gray-500 mb-6 max-w-md">
                                Generate your first playlist based on your
                                listening history!
                            </p>
                            <button
                                onClick={handleGenerate}
                                disabled={isGenerating}
                                className={cn(
                                    "flex items-center gap-2 px-6 py-3 rounded-full text-white font-semibold transition-all",
                                    isGenerating
                                        ? "bg-white/5 cursor-not-allowed opacity-50"
                                        : "bg-[#1a1acc]/20 hover:bg-[#1a1acc]/30 border border-[#2323FF]/30 hover:scale-105"
                                )}
                            >
                                {isGenerating ? (
                                    <>
                                        <GradientSpinner size="sm" />
                                        {batchStatus?.status === "scanning"
                                            ? "Finalizing recommendations..."
                                            : batchStatus?.status ===
                                                "generating"
                                              ? "Refreshing recommendations..."
                                              : `Working... ${batchStatus?.completed || 0}/${batchStatus?.total || 0}`}
                                    </>
                                ) : (
                                    <>
                                        <RefreshCw className="w-5 h-5" />
                                        Generate Now
                                    </>
                                )}
                            </button>
                        </div>
                    )}
            </div>
        </div>
    );
}
