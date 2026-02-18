"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { usePlaylistsQuery } from "@/hooks/useQueries";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/useQueries";
import { useAuth } from "@/lib/auth-context";
import { useAudioControls } from "@/lib/audio-context";
import { Play, Music, Eye, EyeOff, Loader2 } from "lucide-react";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { PageHeader } from "@/components/layout/PageHeader";

// soundspan brand blue for play buttons
const BRAND_PLAY = "#60a5fa";

interface PlaylistItem {
    id: string;
    track: {
        album?: {
            coverArt?: string;
        };
    };
}

interface Playlist {
    id: string;
    name: string;
    trackCount?: number;
    items?: PlaylistItem[];
    isOwner?: boolean;
    isHidden?: boolean;
    user?: {
        username: string;
    };
}

// Generate mosaic cover from playlist tracks
function PlaylistMosaic({
    items,
    size = 4,
    greyed = false,
}: {
    items?: PlaylistItem[];
    size?: number;
    greyed?: boolean;
}) {
    const coverUrls = useMemo(() => {
        if (!items || items.length === 0) return [];

        const tracksWithCovers = items.filter(
            (item) => item.track?.album?.coverArt
        );
        if (tracksWithCovers.length === 0) return [];

        // Get unique cover arts (up to 4)
        const uniqueCovers = Array.from(
            new Set(tracksWithCovers.map((item) => item.track.album!.coverArt))
        ).slice(0, size);

        return uniqueCovers.map((cover) => api.getCoverArtUrl(cover!, 200));
    }, [items, size]);

    if (coverUrls.length === 0) {
        return (
            <div
                className={cn(
                    "w-full h-full flex items-center justify-center bg-gradient-to-br from-[#282828] to-[#181818]",
                    greyed && "opacity-50"
                )}
            >
                <Music className="w-10 h-10 text-gray-600" />
            </div>
        );
    }

    if (coverUrls.length === 1) {
        return (
            <Image
                src={coverUrls[0]}
                alt=""
                fill
                className={cn("object-cover", greyed && "opacity-50 grayscale")}
                sizes="200px"
                unoptimized
            />
        );
    }

    return (
        <div
            className={cn(
                "grid grid-cols-2 w-full h-full",
                greyed && "opacity-50 grayscale"
            )}
        >
            {coverUrls.slice(0, 4).map((url, index) => (
                <div key={index} className="relative">
                    <Image
                        src={url}
                        alt=""
                        fill
                        className="object-cover"
                        sizes="100px"
                        unoptimized
                    />
                </div>
            ))}
            {Array.from({ length: Math.max(0, 4 - coverUrls.length) }).map(
                (_, index) => (
                    <div
                        key={`empty-${index}`}
                        className="relative bg-[#282828] flex items-center justify-center"
                    >
                        <Music className="w-5 h-5 text-gray-600" />
                    </div>
                )
            )}
        </div>
    );
}

function PlaylistCard({
    playlist,
    index,
    onPlay,
    onToggleHide,
    isHiddenView = false,
}: {
    playlist: Playlist;
    index: number;
    onPlay: (playlistId: string) => void;
    onToggleHide: (playlistId: string, hide: boolean) => void;
    isHiddenView?: boolean;
}) {
    const isShared = playlist.isOwner === false;
    const [isHiding, setIsHiding] = useState(false);
    const { showSpinner: showPlaySpinner, trigger: triggerPlayFeedback } =
        usePlayButtonFeedback();

    const handleToggleHide = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsHiding(true);
        try {
            await onToggleHide(playlist.id, !playlist.isHidden);
        } finally {
            setIsHiding(false);
        }
    };

    return (
        <Link href={`/playlist/${playlist.id}`}>
            <div
                className={cn(
                    "group cursor-pointer p-3 rounded-md transition-colors hover:bg-white/5",
                    isHiddenView && "opacity-60 hover:opacity-100"
                )}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
            >
                {/* Cover Image */}
                <div className="relative aspect-square mb-3 rounded-md overflow-hidden bg-[#282828] shadow-lg">
                    <PlaylistMosaic
                        items={playlist.items}
                        greyed={isHiddenView}
                    />

                    {/* Hide/Unhide button for shared playlists */}
                    {isShared && (
                        <button
                            onClick={handleToggleHide}
                            disabled={isHiding}
                            className={cn(
                                "absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center",
                                "bg-black/60  transition-all duration-200",
                                "opacity-0 group-hover:opacity-100",
                                playlist.isHidden
                                    ? "text-green-400"
                                    : "text-gray-400",
                                isHiding && "opacity-50 cursor-not-allowed"
                            )}
                            title={
                                playlist.isHidden
                                    ? "Show playlist"
                                    : "Hide playlist"
                            }
                        >
                            {playlist.isHidden ? (
                                <Eye className="w-3.5 h-3.5" />
                            ) : (
                                <EyeOff className="w-3.5 h-3.5" />
                            )}
                        </button>
                    )}

                    {/* Play button overlay */}
                    <button
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            triggerPlayFeedback();
                            onPlay(playlist.id);
                        }}
                        style={{ backgroundColor: BRAND_PLAY }}
                        className={cn(
                            "absolute bottom-2 right-2 w-10 h-10 rounded-full flex items-center justify-center",
                            "shadow-lg shadow-black/40 transition-all duration-200",
                            "hover:scale-105 hover:brightness-110",
                            "opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0"
                        )}
                        title="Play playlist"
                    >
                        {showPlaySpinner ? (
                            <Loader2 className="w-4 h-4 animate-spin text-black" />
                        ) : (
                            <Play className="w-4 h-4 fill-current ml-0.5 text-black" />
                        )}
                    </button>
                </div>

                {/* Title and info */}
                <h3
                    className={cn(
                        "text-sm font-semibold truncate",
                        isHiddenView ? "text-gray-400" : "text-white"
                    )}
                >
                    {playlist.name}
                </h3>
                <p className="text-xs text-gray-400 mt-0.5 truncate">
                    {isShared && playlist.user?.username ? (
                        <span className="text-gray-500">
                            By {playlist.user.username} ·{" "}
                        </span>
                    ) : null}
                    {playlist.trackCount || 0}{" "}
                    {playlist.trackCount === 1 ? "song" : "songs"}
                </p>
            </div>
        </Link>
    );
}

export default function PlaylistsPage() {
    useRouter();
    useAuth();
    const { playTracks } = useAudioControls();
    const queryClient = useQueryClient();
    const [showHiddenTab, setShowHiddenTab] = useState(false);

    // Use React Query hook for playlists
    const { data: playlists = [], isLoading } = usePlaylistsQuery();

    // Separate visible and hidden playlists
    const { visiblePlaylists, hiddenPlaylists } = useMemo(() => {
        const visible: Playlist[] = [];
        const hidden: Playlist[] = [];

        playlists.forEach((p: Playlist) => {
            if (p.isHidden) {
                hidden.push(p);
            } else {
                visible.push(p);
            }
        });

        return { visiblePlaylists: visible, hiddenPlaylists: hidden };
    }, [playlists]);

    // Listen for playlist events and invalidate cache
    useEffect(() => {
        const handlePlaylistEvent = () => {
            queryClient.invalidateQueries({ queryKey: queryKeys.playlists() });
        };

        window.addEventListener("playlist-created", handlePlaylistEvent);
        window.addEventListener("playlist-updated", handlePlaylistEvent);
        window.addEventListener("playlist-deleted", handlePlaylistEvent);

        return () => {
            window.removeEventListener("playlist-created", handlePlaylistEvent);
            window.removeEventListener("playlist-updated", handlePlaylistEvent);
            window.removeEventListener("playlist-deleted", handlePlaylistEvent);
        };
    }, [queryClient]);

    const handlePlayPlaylist = async (playlistId: string) => {
        try {
            const playlist = await api.getPlaylist(playlistId);
            if (playlist?.items && playlist.items.length > 0) {
                const tracks = playlist.items.map((item: { track: { id: string; title: string; duration: number; album?: { id?: string; title?: string; coverArt?: string; artist?: { id?: string; name?: string } } } }) => ({
                    id: item.track.id,
                    title: item.track.title,
                    artist: {
                        name: item.track.album?.artist?.name || "Unknown",
                        id: item.track.album?.artist?.id,
                    },
                    album: {
                        title: item.track.album?.title || "Unknown",
                        coverArt: item.track.album?.coverArt,
                        id: item.track.album?.id,
                    },
                    duration: item.track.duration,
                }));
                playTracks(tracks, 0);
            }
        } catch (error) {
            console.error("Failed to play playlist:", error);
        }
    };

    const handleToggleHide = async (playlistId: string, hide: boolean) => {
        try {
            if (hide) {
                await api.hidePlaylist(playlistId);
            } else {
                await api.unhidePlaylist(playlistId);
            }
            // Invalidate and refetch playlists
            queryClient.invalidateQueries({ queryKey: queryKeys.playlists() });
        } catch (error) {
            console.error("Failed to toggle playlist visibility:", error);
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    const displayedPlaylists = showHiddenTab
        ? hiddenPlaylists
        : visiblePlaylists;

    return (
        <div className="min-h-screen relative">
            {/* Quick gradient fade - yellow to purple */}
            <div className="absolute inset-0 pointer-events-none">
                <div
                    className="absolute inset-0 bg-gradient-to-b from-[#3b82f6]/15 via-purple-900/10 to-transparent"
                    style={{ height: "35vh" }}
                />
                <div
                    className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--tw-gradient-stops))] from-[#3b82f6]/8 via-transparent to-transparent"
                    style={{ height: "25vh" }}
                />
            </div>

            {/* Header */}
            <div className="relative px-4 md:px-8 py-6">
                <PageHeader
                    title="Playlists"
                    subtitle={`${visiblePlaylists.length} ${
                        visiblePlaylists.length === 1 ? "playlist" : "playlists"
                    }`}
                    icon={Music}
                    className="mb-4"
                    actions={
                        <>
                            <Link
                                href="/browse/playlists"
                                className="px-4 py-2 rounded-full text-sm font-medium bg-[#3b82f6] text-black hover:brightness-110 transition-all"
                            >
                                Browse Playlists
                            </Link>

                            {hiddenPlaylists.length > 0 && (
                                <button
                                    onClick={() => setShowHiddenTab(!showHiddenTab)}
                                    className={cn(
                                        "px-4 py-2 rounded-full text-sm font-medium transition-all",
                                        showHiddenTab
                                            ? "bg-white/10 text-white"
                                            : "bg-transparent text-gray-400 hover:text-white hover:bg-white/5"
                                    )}
                                >
                                    {showHiddenTab
                                        ? "Show All"
                                        : `Hidden (${hiddenPlaylists.length})`}
                                </button>
                            )}
                        </>
                    }
                />
            </div>

            {/* Content */}
            <div className="relative px-4 pb-24">
                {/* Hidden playlists notice */}
                {showHiddenTab && (
                    <div className="mx-2 mb-4 px-4 py-3 bg-white/5 rounded-lg">
                        <p className="text-sm text-gray-400">
                            Hidden playlists won&apos;t appear in your library. Hover
                            and click the eye icon to restore.
                        </p>
                    </div>
                )}

                {displayedPlaylists.length > 0 ? (
                    <div
                        data-tv-section="playlists"
                        className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-2"
                    >
                        {displayedPlaylists.map(
                            (playlist: Playlist, index: number) => (
                                <PlaylistCard
                                    key={playlist.id}
                                    playlist={playlist}
                                    index={index}
                                    onPlay={handlePlayPlaylist}
                                    onToggleHide={handleToggleHide}
                                    isHiddenView={showHiddenTab}
                                />
                            )
                        )}
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-24 text-center">
                        <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
                            <Music className="w-8 h-8 text-gray-500" />
                        </div>
                        <h2 className="text-lg font-semibold text-white mb-1">
                            {showHiddenTab
                                ? "No hidden playlists"
                                : "No playlists yet"}
                        </h2>
                        <p className="text-sm text-gray-400 max-w-sm">
                            {showHiddenTab
                                ? "You haven't hidden any playlists"
                                : "Create your first playlist by adding songs from albums or artists"}
                        </p>
                        {!showHiddenTab && (
                            <Link
                                href="/browse/playlists"
                                className="mt-6 px-5 py-2.5 rounded-full text-sm font-medium bg-[#3b82f6] text-black hover:brightness-110 transition-all"
                            >
                                Browse Playlists
                            </Link>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
