"use client";

import { useState, useEffect, useRef } from "react";
import { formatTime } from "@/utils/formatTime";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import {
    ArrowLeft,
    Play,
    Pause,
    Download,
    Loader2,
    ExternalLink,
    Music2,
    Volume2,
    VolumeX,
} from "lucide-react";
import { api } from "@/lib/api";
import { useDownloadContext } from "@/lib/download-context";
import { useToast } from "@/lib/toast-context";
import { cn } from "@/utils/cn";
import { GradientSpinner } from "@/components/ui/GradientSpinner";

// Deezer icon component
const DeezerIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M18.81 4.16v3.03H24V4.16h-5.19zM6.27 8.38v3.027h5.189V8.38h-5.19zm12.54 0v3.027H24V8.38h-5.19zM6.27 12.595v3.027h5.189v-3.027h-5.19zm6.27 0v3.027h5.19v-3.027h-5.19zm6.27 0v3.027H24v-3.027h-5.19zM0 16.81v3.029h5.19v-3.03H0zm6.27 0v3.029h5.189v-3.03h-5.19zm6.27 0v3.029h5.19v-3.03h-5.19zm6.27 0v3.029H24v-3.03h-5.19z" />
    </svg>
);

// Types for Deezer playlist
interface DeezerTrack {
    deezerId: string;
    title: string;
    artist: string;
    artistId: string;
    album: string;
    albumId: string;
    durationMs: number;
    previewUrl: string | null;
    coverUrl: string | null;
}

interface DeezerPlaylistFull {
    id: string;
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    tracks: DeezerTrack[];
    isPublic: boolean;
    source: string;
    url: string;
}

export default function DeezerPlaylistDetailPage() {
    const params = useParams();
    const router = useRouter();
    const { toast } = useToast();
    const playlistId = params.id as string;

    // State
    const [playlist, setPlaylist] = useState<DeezerPlaylistFull | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isImporting] = useState(false);

    // Preview playback state
    const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
    const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
    const [previewVolume] = useState(0.5);
    const [isMuted, setIsMuted] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    // Fetch playlist data
    useEffect(() => {
        async function fetchPlaylist() {
            setIsLoading(true);
            setError(null);
            try {
                const data = await api.get<DeezerPlaylistFull>(
                    `/browse/playlists/${playlistId}`
                );
                setPlaylist(data);
            } catch (err) {
                const message =
                    err instanceof Error
                        ? err.message
                        : "Failed to load playlist";
                setError(message);
            } finally {
                setIsLoading(false);
            }
        }

        fetchPlaylist();
    }, [playlistId]);

    // Cleanup audio on unmount
    useEffect(() => {
        return () => {
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current = null;
            }
        };
    }, []);

    // Handle preview playback
    const handlePlayPreview = (track: DeezerTrack) => {
        if (!track.previewUrl) {
            toast.error("No preview available for this track");
            return;
        }

        // If clicking the same track, toggle play/pause
        if (playingTrackId === track.deezerId) {
            if (isPreviewPlaying && audioRef.current) {
                audioRef.current.pause();
                setIsPreviewPlaying(false);
            } else if (audioRef.current) {
                audioRef.current.play().catch(() => setIsPreviewPlaying(false));
                setIsPreviewPlaying(true);
            }
            return;
        }

        // Stop current preview
        if (audioRef.current) {
            audioRef.current.pause();
        }

        // Play new preview
        const audio = new Audio(track.previewUrl);
        audio.volume = isMuted ? 0 : previewVolume;
        audioRef.current = audio;

        audio.onended = () => {
            setPlayingTrackId(null);
            setIsPreviewPlaying(false);
        };

        audio.onerror = () => {
            toast.error("Failed to play preview");
            setPlayingTrackId(null);
            setIsPreviewPlaying(false);
        };

        audio.play().catch(() => {
            setPlayingTrackId(null);
            setIsPreviewPlaying(false);
        });
        setPlayingTrackId(track.deezerId);
        setIsPreviewPlaying(true);
    };

    // Stop preview
    const stopPreview = () => {
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current = null;
        }
        setPlayingTrackId(null);
        setIsPreviewPlaying(false);
    };

    // Toggle mute
    const toggleMute = () => {
        if (audioRef.current) {
            audioRef.current.volume = isMuted ? previewVolume : 0;
        }
        setIsMuted(!isMuted);
    };

    // Handle import/download
    const { downloadsEnabled } = useDownloadContext();
    const handleImport = () => {
        if (!playlist) return;
        // Navigate to import page with the Deezer URL
        router.push(
            `/import/spotify?url=${encodeURIComponent(playlist.url)}`
        );
    };


    // Calculate total duration
    const totalDuration = playlist?.tracks.reduce(
        (sum, track) => sum + track.durationMs,
        0
    ) || 0;

    const formatTotalDuration = (ms: number) => {
        const hours = Math.floor(ms / 3600000);
        const mins = Math.floor((ms % 3600000) / 60000);
        if (hours > 0) {
            return `about ${hours} hr ${mins} min`;
        }
        return `${mins} min`;
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (error || !playlist) {
        return (
            <div className="min-h-screen relative">
                <div className="absolute inset-0 pointer-events-none">
                    <div
                        className="absolute inset-0 bg-gradient-to-b from-[#AD47FF]/15 via-purple-900/10 to-transparent"
                        style={{ height: "35vh" }}
                    />
                </div>
                <div className="relative px-4 md:px-8 py-6">
                    <button
                        onClick={() => router.back()}
                        className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors mb-8"
                    >
                        <ArrowLeft className="w-5 h-5" />
                        Back
                    </button>
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                        <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
                            <Music2 className="w-8 h-8 text-gray-500" />
                        </div>
                        <h3 className="text-lg font-medium text-white mb-2">
                            Playlist not found
                        </h3>
                        <p className="text-sm text-gray-400 mb-6 max-w-sm">
                            {error || "This playlist may be private or no longer available."}
                        </p>
                        <button
                            onClick={() => router.push("/browse/playlists")}
                            className="px-6 py-2.5 rounded-full bg-white text-black text-sm font-medium hover:scale-105 transition-transform"
                        >
                            Browse playlists
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen">
            {/* Hero Section */}
            <div className="relative bg-gradient-to-b from-[#AD47FF]/20 via-[#1a1a1a] to-transparent pt-16 pb-10 px-4 md:px-8">
                <div className="flex items-end gap-6">
                    {/* Cover Art */}
                    <div className="relative w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#282828] rounded shadow-2xl shrink-0 overflow-hidden">
                        {playlist.imageUrl ? (
                            <Image
                                src={playlist.imageUrl}
                                alt={playlist.title}
                                fill
                                sizes="(max-width: 768px) 140px, 192px"
                                className="object-cover"
                                unoptimized
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#AD47FF]/30 to-[#AD47FF]/10">
                                <Music2 className="w-16 h-16 text-gray-600" />
                            </div>
                        )}
                    </div>

                    {/* Playlist Info */}
                    <div className="flex-1 min-w-0 pb-1">
                        <div className="flex items-center gap-2 mb-1">
                            <DeezerIcon className="w-4 h-4 text-[#AD47FF]" />
                            <p className="text-xs font-medium text-white/90">
                                Deezer Playlist
                            </p>
                        </div>
                        <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2">
                            {playlist.title}
                        </h1>
                        {playlist.description && (
                            <p className="text-sm text-gray-400 line-clamp-2 mb-2">
                                {playlist.description}
                            </p>
                        )}
                        <div className="flex items-center gap-1 text-sm text-white/70">
                            <span className="font-medium text-white">
                                {playlist.creator}
                            </span>
                            <span className="mx-1">•</span>
                            <span>{playlist.trackCount} songs</span>
                            {totalDuration > 0 && (
                                <>
                                    <span>, {formatTotalDuration(totalDuration)}</span>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Action Bar */}
            <div className="bg-gradient-to-b from-[#1a1a1a]/60 to-transparent px-4 md:px-8 py-4">
                <div className="flex items-center gap-4">
                    {/* Download/Import Button */}
                    {downloadsEnabled && (
                    <button
                        onClick={handleImport}
                        disabled={isImporting}
                        className="h-12 px-6 rounded-full bg-[#60a5fa] hover:bg-[#3b82f6] hover:scale-105 flex items-center justify-center gap-2 shadow-lg transition-all disabled:opacity-50 disabled:hover:scale-100"
                    >
                        {isImporting ? (
                            <Loader2 className="w-5 h-5 text-black animate-spin" />
                        ) : (
                            <Download className="w-5 h-5 text-black" />
                        )}
                        <span className="text-black font-medium">
                            {isImporting ? "Importing..." : "Download & Create Playlist"}
                        </span>
                    </button>
                    )}

                    {/* Volume Control (when playing preview) */}
                    {playingTrackId && (
                        <div className="flex items-center gap-2">
                            <button
                                onClick={toggleMute}
                                className="p-2 rounded-full hover:bg-white/10 text-white/60 hover:text-white transition-all"
                            >
                                {isMuted ? (
                                    <VolumeX className="w-5 h-5" />
                                ) : (
                                    <Volume2 className="w-5 h-5" />
                                )}
                            </button>
                            <button
                                onClick={stopPreview}
                                className="px-3 py-1.5 rounded-full bg-white/10 text-sm text-white hover:bg-white/20 transition-colors"
                            >
                                Stop Preview
                            </button>
                        </div>
                    )}

                    {/* Spacer */}
                    <div className="flex-1" />

                    {/* Open in Deezer */}
                    <a
                        href={playlist.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors"
                    >
                        <ExternalLink className="w-4 h-4" />
                        <span className="hidden sm:inline">Open in Deezer</span>
                    </a>
                </div>
            </div>

            {/* Track Listing */}
            <div className="px-4 md:px-8 pb-32">
                {playlist.tracks.length > 0 ? (
                    <div className="w-full">
                        {/* Table Header */}
                        <div className="hidden md:grid grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px] gap-4 px-4 py-2 text-xs text-gray-400 uppercase tracking-wider border-b border-white/10 mb-2">
                            <span className="text-center">#</span>
                            <span>Title</span>
                            <span>Album</span>
                            <span className="text-right">Duration</span>
                        </div>

                        {/* Track Rows */}
                        <div>
                            {playlist.tracks.map((track, index) => {
                                const isCurrentlyPlaying =
                                    playingTrackId === track.deezerId;
                                const hasPreview = !!track.previewUrl;

                                return (
                                    <div
                                        key={track.deezerId}
                                        onClick={() =>
                                            hasPreview && handlePlayPreview(track)
                                        }
                                        className={cn(
                                            "grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px] gap-4 px-4 py-2 rounded-md transition-colors group",
                                            hasPreview
                                                ? "hover:bg-white/5 cursor-pointer"
                                                : "opacity-60 cursor-not-allowed",
                                            isCurrentlyPlaying && "bg-white/10"
                                        )}
                                    >
                                        {/* Track Number / Play Icon */}
                                        <div className="flex items-center justify-center">
                                            {hasPreview ? (
                                                <>
                                                    <span
                                                        className={cn(
                                                            "text-sm group-hover:hidden",
                                                            isCurrentlyPlaying
                                                                ? "text-[#AD47FF]"
                                                                : "text-gray-400"
                                                        )}
                                                    >
                                                        {isCurrentlyPlaying &&
                                                        isPreviewPlaying ? (
                                                            <Pause className="w-4 h-4 text-[#AD47FF]" />
                                                        ) : (
                                                            index + 1
                                                        )}
                                                    </span>
                                                    <Play className="w-4 h-4 text-white hidden group-hover:block" />
                                                </>
                                            ) : (
                                                <span className="text-sm text-gray-600">
                                                    {index + 1}
                                                </span>
                                            )}
                                        </div>

                                        {/* Title + Artist */}
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="relative w-10 h-10 bg-[#282828] rounded shrink-0 overflow-hidden">
                                                {track.coverUrl ? (
                                                    <Image
                                                        src={track.coverUrl}
                                                        alt={track.title}
                                                        fill
                                                        sizes="40px"
                                                        className="object-cover"
                                                        unoptimized
                                                    />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center">
                                                        <Music2 className="w-5 h-5 text-gray-600" />
                                                    </div>
                                                )}
                                            </div>
                                            <div className="min-w-0">
                                                <p
                                                    className={cn(
                                                        "text-sm font-medium truncate",
                                                        isCurrentlyPlaying
                                                            ? "text-[#AD47FF]"
                                                            : "text-white"
                                                    )}
                                                >
                                                    {track.title}
                                                </p>
                                                <p className="text-xs text-gray-400 truncate">
                                                    {track.artist}
                                                </p>
                                            </div>
                                        </div>

                                        {/* Album (hidden on mobile) */}
                                        <p className="hidden md:flex items-center text-sm text-gray-400 truncate">
                                            {track.album}
                                        </p>

                                        {/* Duration */}
                                        <div className="flex items-center justify-end">
                                            <span className="text-sm text-gray-400">
                                                {formatTime(Math.round(track.durationMs / 1000))}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-24 text-center">
                        <div className="w-20 h-20 bg-[#282828] rounded-full flex items-center justify-center mb-4">
                            <Music2 className="w-10 h-10 text-gray-500" />
                        </div>
                        <h3 className="text-lg font-medium text-white mb-1">
                            No tracks found
                        </h3>
                        <p className="text-sm text-gray-500">
                            This playlist appears to be empty
                        </p>
                    </div>
                )}
            </div>

            {/* Preview indicator */}
            {playingTrackId && (
                <div className="fixed bottom-24 left-1/2 -translate-x-1/2 px-4 py-2 bg-[#AD47FF] rounded-full text-black text-sm font-medium shadow-lg flex items-center gap-2 z-50">
                    <div className="w-2 h-2 rounded-full bg-black animate-pulse" />
                    Playing 30s preview
                </div>
            )}
        </div>
    );
}
