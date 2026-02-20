"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { useAudioState, useAudioPlayback, useAudioControls } from "@/lib/audio-context";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { useImageColor } from "@/hooks/useImageColor";
import { api } from "@/lib/api";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { useDownloadContext } from "@/lib/download-context";
import { useListenTogether } from "@/lib/listen-together-context";

// Custom hooks
import { useAlbumData } from "@/features/album/hooks/useAlbumData";
import { useAlbumActions } from "@/features/album/hooks/useAlbumActions";
import { useYtMusicGapFill } from "@/features/album/hooks/useYtMusicGapFill";
import { useTidalGapFill } from "@/features/album/hooks/useTidalGapFill";
import { useTrackPreview } from "@/hooks/useTrackPreview";
import type { Track as AlbumTrack } from "@/features/album/types";

// Components
import { AlbumHero } from "@/features/album/components/AlbumHero";
import { AlbumActionBar } from "@/features/album/components/AlbumActionBar";
import { TrackList } from "@/features/album/components/TrackList";
import { SimilarAlbums } from "@/features/album/components/SimilarAlbums";

interface AlbumPageProps {
    params: Promise<{
        id: string;
    }>;
}

function AlbumTracksSkeleton() {
    return (
        <section>
            <div className="rounded-xl border border-white/10 bg-[#111111]/60 overflow-hidden">
                <div className="space-y-2 p-4 md:p-5">
                    {Array.from({ length: 8 }).map((_, index) => (
                        <div
                            key={index}
                            className="h-12 animate-pulse rounded-lg bg-white/[0.07]"
                        />
                    ))}
                </div>
            </div>
        </section>
    );
}

export default function AlbumPage({ params }: AlbumPageProps) {
    const { id } = use(params);
    const router = useRouter();
    // Use split hooks to avoid re-renders from currentTime updates
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { pause } = useAudioControls();
    const { isInGroup } = useListenTogether();

    // State
    const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
    const [pendingTrackIds, setPendingTrackIds] = useState<string[]>([]);
    const [, setIsBulkAdd] = useState(false);
    const [, setIsAddingToPlaylist] = useState(false);

    // Custom hooks
    const {
        album: rawAlbum,
        source,
        loading,
        detailsLoading,
        reloadAlbum,
    } = useAlbumData(id);
    const { enrichedTracks: tidalEnrichedTracks } = useTidalGapFill(rawAlbum, source);
    const tidalAlbum = rawAlbum ? { ...rawAlbum, tracks: tidalEnrichedTracks || rawAlbum.tracks } : rawAlbum;
    const { enrichedTracks } = useYtMusicGapFill(tidalAlbum, source);
    const {
        playAlbum,
        shufflePlay,
        playTrackNow,
        addAllToQueue,
        downloadAlbum,
        setAlbumPreference,
        isApplyingAlbumPreference,
    } = useAlbumActions();
    const { isPendingByMbid, downloadsEnabled } = useDownloadContext();
    const { previewTrack, previewPlaying, handlePreview } = useTrackPreview();

    // Use enriched tracks (with TIDAL + YT Music gap-fill) when available
    const album = rawAlbum ? { ...rawAlbum, tracks: enrichedTracks || rawAlbum.tracks } : rawAlbum;
    const hasTracks = Boolean(album?.tracks && album.tracks.length > 0);
    const showTrackPlaceholder = detailsLoading && !hasTracks;

    // Get cover URL for display and color extraction
    // Proxy through API to handle native: URLs and CORS
    const rawCoverUrl =
        album?.coverUrl || album?.coverArt || "/placeholder-album.png";
    const coverUrl =
        rawCoverUrl === "/placeholder-album.png"
            ? rawCoverUrl
            : api.getCoverArtUrl(rawCoverUrl, 1200);
    // Separate URL with token for color extraction (CORS access for canvas)
    const colorExtractionUrl =
        rawCoverUrl === "/placeholder-album.png"
            ? rawCoverUrl
            : api.getCoverArtUrl(rawCoverUrl, 300, true);

    // Extract colors
    const { colors } = useImageColor(colorExtractionUrl);

    // Loading and error states
    if (loading) {
        return <LoadingScreen />;
    }

    if (!album) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="text-center">
                    <h1 className="text-2xl font-bold mb-4">
                        Error Loading Album
                    </h1>
                    <p className="text-gray-400 mb-4">Album not found</p>
                    <button
                        onClick={() => router.push("/albums")}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                    >
                        Back to Albums
                    </button>
                </div>
            </div>
        );
    }

    // Event handlers
    const handlePlayTrack = (track: AlbumTrack, _index: number) => {
        playTrackNow(track, album);
    };

    const openPlaylistSelector = (trackIds: string[], bulk = false) => {
        if (!trackIds.length) return;
        setPendingTrackIds(trackIds);
        setIsBulkAdd(bulk);
        setShowPlaylistSelector(true);
    };

    const handleAddAlbumToPlaylist = () => {
        if (!album?.tracks?.length) return;
        const trackIds = album.tracks
            .map((track: AlbumTrack) => track.id)
            .filter(Boolean);
        openPlaylistSelector(trackIds, true);
    };

    const handlePlaylistSelected = async (playlistId: string) => {
        if (!pendingTrackIds.length) return;

        try {
            setIsAddingToPlaylist(true);
            for (const trackId of pendingTrackIds) {
                await api.addTrackToPlaylist(playlistId, trackId);
            }
            setPendingTrackIds([]);
            setIsBulkAdd(false);
            setShowPlaylistSelector(false);
        } catch (error) {
            console.error("Failed to add track(s) to playlist:", error);
        } finally {
            setIsAddingToPlaylist(false);
        }
    };

    return (
        <div className="min-h-screen flex flex-col">
            <AlbumHero
                album={album}
                source={source || "discovery"}
                coverUrl={coverUrl}
                colors={colors}
                onReload={reloadAlbum}
            >
                <AlbumActionBar
                    album={album}
                    source={source || "discovery"}
                    colors={colors}
                    onPlayAll={() => {
                        if (!hasTracks) return;
                        playAlbum(album, 0);
                    }}
                    onAddAllToQueue={() => {
                        if (!hasTracks) return;
                        addAllToQueue(album);
                    }}
                    onShuffle={() => {
                        if (!hasTracks) return;
                        shufflePlay(album);
                    }}
                    onDownloadAlbum={() => downloadAlbum(album)}
                    onAddToPlaylist={handleAddAlbumToPlaylist}
                    onThumbsDownAlbum={() => {
                        if (!hasTracks) return;
                        void setAlbumPreference(album, "thumbs_down");
                    }}
                    onThumbsUpAlbum={() => {
                        if (!hasTracks) return;
                        void setAlbumPreference(album, "thumbs_up");
                    }}
                    isPendingDownload={isPendingByMbid(
                        album?.mbid || album?.rgMbid || ""
                    )}
                    isApplyingAlbumPreference={isApplyingAlbumPreference}
                    isPlaying={isPlaying}
                    isPlayingThisAlbum={currentTrack?.album?.id === album.id}
                    onPause={pause}
                    downloadsEnabled={downloadsEnabled}
                    isInListenTogetherGroup={isInGroup}
                />
            </AlbumHero>

            {/* Main Content - fills remaining viewport height */}
            <div className="relative min-h-[50vh] flex-1">
                {/* Dynamic color gradient */}
                <div
                    className="absolute inset-0 pointer-events-none"
                    style={{
                        background: `linear-gradient(180deg,
              ${(colors || {}).vibrant}15 0%,
              ${(colors || {}).darkVibrant}08 50%,
              transparent 100%)`,
                    }}
                />

                {/* Texture overlay */}
                <div
                    className="absolute inset-0 pointer-events-none opacity-[0.015]"
                    style={{
                        backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
                        backgroundSize: "30px 30px",
                    }}
                />

                <div className="relative px-2 md:px-8 py-6 space-y-8">
                    {hasTracks && (
                        <TrackList
                            tracks={album.tracks}
                            album={album}
                            source={source || "discovery"}
                            currentTrackId={currentTrack?.id}
                            colors={colors}
                            onPlayTrack={handlePlayTrack}
                            previewTrack={previewTrack}
                            previewPlaying={previewPlaying}
                            onPreview={(track: AlbumTrack, e: React.MouseEvent) =>
                                handlePreview(
                                    track,
                                    album.artist?.name || "",
                                    e
                                )
                            }
                            isInListenTogetherGroup={isInGroup}
                        />
                    )}
                    {showTrackPlaceholder && <AlbumTracksSkeleton />}

                    {album.similarAlbums && album.similarAlbums.length > 0 && (
                        <SimilarAlbums
                            similarAlbums={album.similarAlbums}
                            colors={colors}
                            onNavigate={(id) => router.push(`/album/${id}`)}
                        />
                    )}
                </div>
            </div>

            <PlaylistSelector
                isOpen={showPlaylistSelector}
                onClose={() => {
                    setShowPlaylistSelector(false);
                    setPendingTrackIds([]);
                    setIsBulkAdd(false);
                }}
                onSelectPlaylist={handlePlaylistSelected}
            />
        </div>
    );
}
