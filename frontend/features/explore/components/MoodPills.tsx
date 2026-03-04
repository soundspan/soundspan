/**
 * Mood gradient pills row for the Explore page.
 *
 * Horizontally scrollable row of mood pills that generate and play
 * mood-based mixes from the user's library. Styled after YouTube Music
 * mood chips with gradient backgrounds.
 */

"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { api, type MoodType, type MoodBucketPreset } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import type { Track } from "@/lib/audio-state-context";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

const MOOD_PILLS: {
    mood: MoodType;
    label: string;
    gradient: string;
}[] = [
    { mood: "sad", label: "Sad", gradient: "from-blue-600 to-indigo-700" },
    { mood: "melancholy", label: "Melancholy", gradient: "from-slate-500 to-gray-600" },
    { mood: "acoustic", label: "Acoustic", gradient: "from-amber-600 to-yellow-700" },
    { mood: "chill", label: "Chill", gradient: "from-teal-500 to-cyan-600" },
    { mood: "focus", label: "Focus", gradient: "from-emerald-500 to-green-600" },
    { mood: "happy", label: "Happy", gradient: "from-yellow-500 to-orange-500" },
    { mood: "energetic", label: "Energetic", gradient: "from-orange-500 to-red-500" },
    { mood: "party", label: "Party", gradient: "from-pink-500 to-purple-600" },
    { mood: "aggressive", label: "Aggressive", gradient: "from-red-600 to-rose-700" },
];

/**
 * Renders a horizontally scrollable row of mood gradient pills.
 */
export function MoodPills() {
    const { playTracks } = useAudioControls();
    const queryClient = useQueryClient();
    const [presets, setPresets] = useState<MoodBucketPreset[]>([]);
    const [presetsLoaded, setPresetsLoaded] = useState(false);
    const [generating, setGenerating] = useState<MoodType | null>(null);

    useEffect(() => {
        api.getMoodBucketPresets()
            .then((data) => {
                setPresets(data);
                setPresetsLoaded(true);
            })
            .catch((error) => {
                sharedFrontendLogger.error("Failed to load mood presets:", error);
                setPresetsLoaded(true);
            });
    }, []);

    const getTrackCount = (mood: MoodType): number => {
        const preset = presets.find((p) => p.id === mood);
        return preset?.trackCount || 0;
    };

    const handleMoodClick = async (mood: MoodType, label: string) => {
        if (generating) return;
        const trackCount = getTrackCount(mood);
        if (trackCount < 5) {
            toast.error(`Not enough ${label} tracks`, {
                description: `Need at least 5 tracks (have ${trackCount})`,
            });
            return;
        }

        setGenerating(mood);
        try {
            const mix = await api.getMoodBucketMix(mood);
            if (mix.tracks && mix.tracks.length > 0) {
                const tracks: Track[] = mix.tracks.map((t) => ({
                    id: t.id,
                    title: t.title,
                    artist: {
                        name: t.album?.artist?.name || "Unknown Artist",
                        id: t.album?.artist?.id,
                    },
                    album: {
                        title: t.album?.title || "Unknown Album",
                        coverArt: t.album?.coverUrl,
                        id: t.albumId,
                    },
                    duration: t.duration,
                }));
                playTracks(tracks, 0);
                await api.saveMoodBucketMix(mood);
                toast.success(`${label} Mix`, {
                    description: `Playing ${tracks.length} tracks`,
                });
                await queryClient.refetchQueries({ queryKey: ["mixes"] });
                window.dispatchEvent(new CustomEvent("mix-generated"));
                window.dispatchEvent(new CustomEvent("mixes-updated"));
            } else {
                toast.error("Not enough tracks for this mood", {
                    description: "Try analyzing more music or choose a different mood",
                });
            }
        } catch (error: unknown) {
            sharedFrontendLogger.error("Failed to generate mood mix:", error);
            const errorMessage = error instanceof Error ? error.message : "Failed to generate mix";
            toast.error(errorMessage);
        } finally {
            setGenerating(null);
        }
    };

    return (
        <div className="flex flex-wrap gap-2">
            {MOOD_PILLS.map(({ mood, label, gradient }) => {
                const isGenerating = generating === mood;
                const trackCount = getTrackCount(mood);
                const isDisabled = !presetsLoaded || trackCount < 5;

                return (
                    <button
                        key={mood}
                        onClick={() => handleMoodClick(mood, label)}
                        disabled={generating !== null || isDisabled}
                        title={isDisabled ? `Need at least 5 tracks (have ${trackCount})` : `Play ${label} mix`}
                        className={`
                            px-4 py-2 rounded-full text-sm font-medium text-white
                            bg-gradient-to-r ${gradient}
                            transition-all duration-150
                            hover:opacity-90 hover:scale-[1.03] active:scale-[0.97]
                            disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100
                            flex items-center gap-1.5
                        `}
                    >
                        {isGenerating ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : null}
                        {label}
                    </button>
                );
            })}
        </div>
    );
}
