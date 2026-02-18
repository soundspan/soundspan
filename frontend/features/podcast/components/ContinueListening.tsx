"use client";

import { Play, Pause, Loader2 } from "lucide-react";
import { Podcast, Episode } from "../types";
import { formatDuration } from "@/utils/formatTime";
import { formatDate } from "../utils";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";

interface ContinueListeningProps {
    podcast: Podcast;
    inProgressEpisodes: Episode[];
    sortedEpisodes: Episode[];
    isEpisodePlaying: (episodeId: string) => boolean;
    isPlaying: boolean;
    onPlayEpisode: (episode: Episode) => void;
    onPlayPause: (episode: Episode) => void;
}

export function ContinueListening({
    podcast: _podcast,
    inProgressEpisodes,
    sortedEpisodes,
    isEpisodePlaying,
    isPlaying,
    onPlayEpisode,
    onPlayPause,
}: ContinueListeningProps) {
    const { showSpinner, triggerPlayFeedback } = usePlayButtonFeedback();

    if (inProgressEpisodes.length === 0) {
        return null;
    }

    // Get the most recently played episode
    const recentEpisode = inProgressEpisodes.reduce((prev, current) => {
        const prevDate = new Date(prev.progress?.lastPlayedAt || 0);
        const currentDate = new Date(current.progress?.lastPlayedAt || 0);
        return currentDate > prevDate ? current : prev;
    });

    // Find the index in sorted episodes
    const currentIndex = sortedEpisodes.findIndex(
        (ep) => ep.id === recentEpisode.id
    );
    const previousEpisode =
        currentIndex > 0 ? sortedEpisodes[currentIndex - 1] : null;
    const nextEpisode =
        currentIndex < sortedEpisodes.length - 1
            ? sortedEpisodes[currentIndex + 1]
            : null;

    const isCurrentPlaying = isEpisodePlaying(recentEpisode.id);
    const handleCurrentEpisodePlayPause = () => {
        triggerPlayFeedback();
        onPlayPause(recentEpisode);
    };

    return (
        <section>
            <h2 className="text-xl font-bold mb-4">Continue Listening</h2>
            <div className="space-y-2">
                {/* Previous Episode - Faded */}
                {previousEpisode && (
                    <div
                        className="flex items-center gap-3 p-3 rounded-md hover:bg-white/5 transition-all cursor-pointer opacity-50 hover:opacity-70"
                        onClick={() => onPlayEpisode(previousEpisode)}
                    >
                        <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center shrink-0">
                            <Play className="w-3 h-3 text-white/70" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h3 className="font-medium text-white/80 truncate text-sm">
                                {previousEpisode.title}
                            </h3>
                            <p className="text-xs text-white/40">Previous episode</p>
                        </div>
                    </div>
                )}

                {/* Current Episode - Prominent */}
                <div
                    className="flex items-center gap-4 p-4 rounded-lg bg-white/5 border border-[#3b82f6]/30 hover:border-[#3b82f6]/50 transition-all cursor-pointer"
                    onClick={() => onPlayPause(recentEpisode)}
                >
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            handleCurrentEpisodePlayPause();
                        }}
                        className="w-12 h-12 rounded-full bg-[#60a5fa] hover:bg-[#93c5fd] hover:scale-105 transition-all flex items-center justify-center shrink-0"
                    >
                        {showSpinner ? (
                            <Loader2 className="w-5 h-5 text-black animate-spin" />
                        ) : isCurrentPlaying && isPlaying ? (
                            <Pause className="w-5 h-5 text-black" />
                        ) : (
                            <Play className="w-5 h-5 text-black ml-0.5" fill="black" />
                        )}
                    </button>
                    <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-white truncate">
                            {recentEpisode.title}
                        </h3>
                        <div className="flex items-center gap-3 mt-1 text-xs text-white/50">
                            <span>{formatDuration(recentEpisode.duration)}</span>
                            <span>•</span>
                            <span>{formatDate(recentEpisode.publishedAt)}</span>
                        </div>
                        {/* Progress Bar */}
                        {recentEpisode.progress && (
                            <div className="mt-2">
                                <div className="flex items-center gap-2">
                                    <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-[#3b82f6] rounded-full transition-all"
                                            style={{
                                                width: `${recentEpisode.progress.progress}%`,
                                            }}
                                        />
                                    </div>
                                    <span className="text-xs text-[#3b82f6]">
                                        {Math.floor(recentEpisode.progress.progress)}%
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Next Episode - Faded */}
                {nextEpisode && (
                    <div
                        className="flex items-center gap-3 p-3 rounded-md hover:bg-white/5 transition-all cursor-pointer opacity-50 hover:opacity-70"
                        onClick={() => onPlayEpisode(nextEpisode)}
                    >
                        <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center shrink-0">
                            <Play className="w-3 h-3 text-white/70" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h3 className="font-medium text-white/80 truncate text-sm">
                                {nextEpisode.title}
                            </h3>
                            <p className="text-xs text-white/40">Next episode</p>
                        </div>
                    </div>
                )}
            </div>
        </section>
    );
}
