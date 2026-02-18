"use client";

import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useImageColor } from "@/hooks/useImageColor";
import { formatTime } from "@/utils/formatTime";

// Hooks
import { useAudiobookData } from "@/features/audiobook/hooks/useAudiobookData";
import { useAudiobookActions } from "@/features/audiobook/hooks/useAudiobookActions";

// Components
import { AudiobookHero } from "@/features/audiobook/components/AudiobookHero";
import { AudiobookActionBar } from "@/features/audiobook/components/AudiobookActionBar";

export default function AudiobookDetailPage() {
    // Data hook
    const { audiobookId, audiobook, isLoading, refetch, heroImage, colorExtractionImage, metadata } =
        useAudiobookData();

    // Extract colors from the hero image (uses token for CORS canvas access)
    const { colors } = useImageColor(colorExtractionImage);

    // Action hooks
    const {
        isThisBookPlaying,
        isPlaying,
        currentTime,
        handlePlayPause,
        handleMarkAsCompleted,
        handleResetProgress,
    } = useAudiobookActions(audiobookId, audiobook, refetch);

    // Loading state
    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!audiobook) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <p className="text-gray-500">Audiobook not found</p>
            </div>
        );
    }

    // Clean up description - strip HTML and clean whitespace
    const cleanDescription = audiobook.description
        ? audiobook.description
              .replace(/<[^>]*>/g, " ")
              .replace(/\s+/g, " ")
              .trim()
        : null;

    const showDescription =
        cleanDescription &&
        !cleanDescription.match(/^(Read by|Narrated by):/i) &&
        cleanDescription.length > 20;

    return (
        <div className="min-h-screen flex flex-col">
            <AudiobookHero
                audiobook={audiobook}
                heroImage={heroImage}
                colors={colors}
                metadata={metadata}
                formatTime={formatTime}
            >
                <AudiobookActionBar
                    audiobook={audiobook}
                    isThisBookPlaying={isThisBookPlaying}
                    isPlaying={isPlaying}
                    currentTime={currentTime}
                    onPlayPause={handlePlayPause}
                    onResetProgress={handleResetProgress}
                    onMarkAsCompleted={handleMarkAsCompleted}
                    formatTime={formatTime}
                />
            </AudiobookHero>

            {/* Main Content */}
            <div className="relative flex-1">
                <div
                    className="absolute inset-0 pointer-events-none"
                    style={{
                        background: colors
                            ? `linear-gradient(to bottom, ${colors.vibrant}15 0%, ${colors.vibrant}08 15%, ${colors.darkVibrant}05 30%, transparent 50%)`
                            : "transparent",
                    }}
                />

                <div className="relative px-4 md:px-8 py-8 space-y-6">
                    {/* Description / About */}
                    {showDescription && (
                        <section className="hidden md:block">
                            <h2 className="text-xl font-bold mb-4">About</h2>
                            <div className="bg-white/5 rounded-md p-4">
                                <p className="text-sm text-white/70 leading-relaxed">
                                    {cleanDescription}
                                </p>
                            </div>
                        </section>
                    )}

                    {/* Series info */}
                    {audiobook.series && (
                        <section>
                            <h2 className="text-xl font-bold mb-4">Series</h2>
                            <div className="flex items-center gap-3 text-sm">
                                <span className="text-[#3b82f6] font-medium">
                                    {audiobook.series.name}
                                </span>
                                <span className="text-white/40">•</span>
                                <span className="text-white/70">
                                    Book {audiobook.series.sequence}
                                </span>
                            </div>
                        </section>
                    )}

                    {/* Playback hint - more subtle */}
                    <p className="text-xs text-white/40 pt-4">
                        Use the player controls in the bottom bar for playback
                        speed, seeking, and volume.
                    </p>
                </div>
            </div>
        </div>
    );
}
