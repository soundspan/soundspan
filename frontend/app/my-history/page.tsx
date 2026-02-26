"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { History, Music2 } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAudioState } from "@/lib/audio-state-context";
import { useToast } from "@/lib/toast-context";
import { formatTime } from "@/utils/formatTime";
import { cn } from "@/utils/cn";
import { PageHeader } from "@/components/layout/PageHeader";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

interface PlayHistoryTrack {
    id: string;
    title: string;
    displayTitle?: string | null;
    duration: number;
    filePath?: string;
    streamSource?: "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    album?: {
        id?: string;
        title?: string;
        coverArt?: string;
        coverUrl?: string;
        artist?: {
            id?: string;
            name?: string;
            mbid?: string;
        };
    };
}

interface PlayHistoryEntry {
    id: string;
    playedAt: string;
    track: PlayHistoryTrack;
}

function toAudioTrack(track: PlayHistoryTrack) {
    return {
        id: track.id,
        title: track.title,
        displayTitle: track.displayTitle,
        duration: track.duration,
        filePath: track.filePath,
        streamSource: track.streamSource,
        tidalTrackId: track.tidalTrackId,
        youtubeVideoId: track.youtubeVideoId,
        artist: {
            id: track.album?.artist?.id,
            name: track.album?.artist?.name || "Unknown Artist",
            mbid: track.album?.artist?.mbid,
        },
        album: {
            id: track.album?.id,
            title: track.album?.title || "Unknown Album",
            coverArt: track.album?.coverArt || track.album?.coverUrl || undefined,
        },
    };
}

function formatPlayedAt(isoDate: string): string {
    const parsed = Date.parse(isoDate);
    if (Number.isNaN(parsed)) return "";

    const diffMs = Date.now() - parsed;
    if (diffMs < 60_000) return "Just now";
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
    if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
    return new Date(parsed).toLocaleDateString();
}

export default function MyHistoryPage() {
    const router = useRouter();
    const { isAuthenticated } = useAuth();
    const { playTracks } = useAudioControls();
    const { currentTrack } = useAudioState();
    const { toast } = useToast();
    const [history, setHistory] = useState<PlayHistoryEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!isAuthenticated) {
            router.push("/login");
            return;
        }

        const loadHistory = async () => {
            try {
                setLoading(true);
                setError(null);
                const data = await api.get<PlayHistoryEntry[]>("/plays?limit=250");
                setHistory(Array.isArray(data) ? data.filter((entry) => Boolean(entry.track?.id)) : []);
            } catch (err) {
                sharedFrontendLogger.error("Failed to load play history:", err);
                setError("Failed to load your listening history");
            } finally {
                setLoading(false);
            }
        };

        void loadHistory();
    }, [isAuthenticated, router]);

    const audioTracks = useMemo(
        () => history.map((entry) => toAudioTrack(entry.track)),
        [history]
    );

    const handlePlayFromHistory = (index: number) => {
        if (audioTracks.length === 0) return;
        playTracks(audioTracks, index);
        toast.success("Playing from history");
    };

    if (!isAuthenticated) {
        return null;
    }

    return (
        <div className="min-h-screen bg-[#0a0a0a]">
            <div className="max-w-4xl mx-auto p-4 md:p-8 space-y-6">
                <PageHeader
                    title="My History"
                    subtitle={`${history.length} played track${
                        history.length !== 1 ? "s" : ""
                    }`}
                    icon={History}
                    className="mb-8"
                    actions={
                        <Button
                            variant="secondary"
                            onClick={() => router.push("/queue")}
                        >
                            Queue
                        </Button>
                    }
                />

                {loading && (
                    <div className="flex items-center justify-center py-12">
                        <div className="w-6 h-6 border-2 border-white/20 border-t-white/70 rounded-full animate-spin" />
                    </div>
                )}

                {!loading && error && (
                    <div className="bg-[#111] rounded-lg p-6 border border-red-500/20">
                        <p className="text-sm text-red-300">{error}</p>
                        <button
                            onClick={() => window.location.reload()}
                            className="mt-3 text-xs text-white/60 hover:text-white"
                        >
                            Retry
                        </button>
                    </div>
                )}

                {!loading && !error && history.length === 0 && (
                    <EmptyState
                        icon={<History />}
                        title="No listening history yet"
                        description="Play something and your recent listening will appear here."
                        action={{
                            label: "Browse Library",
                            onClick: () => router.push("/library"),
                        }}
                    />
                )}

                {!loading && !error && history.length > 0 && (
                    <section className="bg-[#111] rounded-lg p-6">
                        <h2 className="text-xl font-semibold text-white mb-4">
                            Recently Played ({history.length})
                        </h2>

                        <Card>
                            <div className="divide-y divide-[#1c1c1c]">
                                {history.map((entry, index) => {
                                    const track = entry.track;
                                    const isCurrentTrack = currentTrack?.id === track.id;
                                    const coverArt =
                                        track.album?.coverArt || track.album?.coverUrl;
                                    return (
                                        <div
                                            key={entry.id}
                                            onClick={() => handlePlayFromHistory(index)}
                                            className={cn(
                                                "flex items-center gap-4 p-4 hover:bg-[#1a1a1a] transition-colors group cursor-pointer",
                                                isCurrentTrack && "bg-[#3b82f6]/10"
                                            )}
                                        >
                                            <div className="relative flex-shrink-0 w-12 h-12">
                                                {coverArt ? (
                                                    <Image
                                                        src={api.getCoverArtUrl(coverArt, 100)}
                                                        alt={track.album?.title || "Album"}
                                                        fill
                                                        sizes="48px"
                                                        className="object-cover rounded-sm"
                                                        unoptimized
                                                    />
                                                ) : (
                                                    <div className="w-12 h-12 bg-[#0a0a0a] rounded-sm flex items-center justify-center">
                                                        <Music2 className="w-5 h-5 text-gray-600" />
                                                    </div>
                                                )}
                                            </div>

                                            <div className="flex-1 min-w-0">
                                                <p
                                                    className={cn(
                                                        "text-sm font-medium truncate",
                                                        isCurrentTrack ? "text-[#3b82f6]" : "text-white"
                                                    )}
                                                >
                                                    {track.displayTitle ?? track.title}
                                                </p>
                                                <p className="text-xs text-gray-400 truncate">
                                                    {track.album?.artist?.name || "Unknown Artist"}
                                                </p>
                                                <p className="text-[11px] text-gray-500 truncate">
                                                    {track.album?.title || "Unknown Album"}
                                                </p>
                                                <p className="text-[11px] text-gray-500 mt-1">
                                                    Played {formatPlayedAt(entry.playedAt)}
                                                </p>
                                            </div>

                                            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                                                <span className="text-xs text-gray-500 w-10 text-right tabular-nums">
                                                    {formatTime(track.duration)}
                                                </span>
                                                <TrackPreferenceButtons
                                                    trackId={track.id}
                                                    mode="up-only"
                                                    buttonSizeClassName="h-8 w-8"
                                                    iconSizeClassName="h-4 w-4"
                                                />
                                                <TrackOverflowMenu track={toAudioTrack(track)} />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </Card>
                    </section>
                )}
            </div>

        </div>
    );
}
