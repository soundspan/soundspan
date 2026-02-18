"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
    useAudioState,
    useAudioPlayback,
    useAudioControls,
} from "@/lib/audio-context";
import { useDownloadContext } from "@/lib/download-context";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { ReleaseSelectionModal } from "@/components/ui/ReleaseSelectionModal";
import { useImageColor } from "@/hooks/useImageColor";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { useListenTogether } from "@/lib/listen-together-context";

// Hooks
import { useArtistData } from "@/features/artist/hooks/useArtistData";
import { useArtistActions } from "@/features/artist/hooks/useArtistActions";
import { useDownloadActions } from "@/features/artist/hooks/useDownloadActions";
import { useYtMusicTopTracks } from "@/features/artist/hooks/useYtMusicTopTracks";
import { useTidalTopTracks } from "@/features/artist/hooks/useTidalTopTracks";
import type { Track, Album } from "@/features/artist/types";
import { useTrackPreview } from "@/hooks/useTrackPreview";

// Components
import { ArtistHero } from "@/features/artist/components/ArtistHero";
import { ArtistActionBar } from "@/features/artist/components/ArtistActionBar";
import { ArtistBio } from "@/features/artist/components/ArtistBio";
import { PopularTracks } from "@/features/artist/components/PopularTracks";
import { Discography } from "@/features/artist/components/Discography";
import { AvailableAlbums } from "@/features/artist/components/AvailableAlbums";
import { SimilarArtists } from "@/features/artist/components/SimilarArtists";

function ListSectionSkeleton({ title, rows = 5 }: { title: string; rows?: number }) {
    return (
        <section>
            <h2 className="text-xl font-bold mb-4">{title}</h2>
            <div className="space-y-2">
                {Array.from({ length: rows }).map((_, index) => (
                    <div
                        key={`${title}-row-${index}`}
                        className="h-12 rounded-md bg-white/5 animate-pulse"
                    />
                ))}
            </div>
        </section>
    );
}

function GridSectionSkeleton({
    title,
    columns = 5,
}: {
    title: string;
    columns?: number;
}) {
    return (
        <section>
            <h2 className="text-xl font-bold mb-4">{title}</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {Array.from({ length: columns }).map((_, index) => (
                    <div
                        key={`${title}-grid-${index}`}
                        className="aspect-square rounded-md bg-white/5 animate-pulse"
                    />
                ))}
            </div>
        </section>
    );
}

export default function ArtistPage() {
    const router = useRouter();
    // Use split hooks to avoid re-renders from currentTime updates
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { playTracks, playTrack, pause } = useAudioControls();
    const { isPendingByMbid, downloadsEnabled } = useDownloadContext();
    const { isInGroup } = useListenTogether();

    // Data hook
    const {
        artist,
        albums,
        loading,
        detailsLoading,
        error,
        source,
        sortBy,
        setSortBy,
        reloadArtist,
    } = useArtistData();

    // Action hooks
    const { playAll, shufflePlay, addAllToQueue } = useArtistActions();
    const { downloadArtist, downloadAlbum } = useDownloadActions();
    const { previewTrack, previewPlaying, handlePreview } = useTrackPreview();

    // Enrich unowned top tracks with TIDAL streaming, then YT Music for remaining gaps
    const artistWithTopTracks = artist?.topTracks?.length ? artist : null;
    const { enrichedTopTracks: tidalEnrichedTopTracks } =
        useTidalTopTracks(artistWithTopTracks);
    const tidalArtist =
        artistWithTopTracks ?
            {
                ...artistWithTopTracks,
                topTracks:
                    tidalEnrichedTopTracks || artistWithTopTracks.topTracks,
            }
        :   null;
    const { enrichedTopTracks } = useYtMusicTopTracks(tidalArtist);

    // Separate owned and available albums
    const ownedAlbums = albums.filter((a) => a.owned);
    const availableAlbums = albums.filter((a) => !a.owned);

    // Get image URLs for display and color extraction
    const rawImageUrl =
        artist && source === "library" ?
            artist.coverArt
        :   artist?.image || null;

    // Use a high-res image for the hero section
    const heroImage =
        rawImageUrl ? api.getCoverArtUrl(rawImageUrl, 1200) : null;

    // Use a low-res image for color extraction and background blur to save CPU
    // Include token for CORS access needed by canvas color extraction
    const lowResImage =
        rawImageUrl ? api.getCoverArtUrl(rawImageUrl, 300, true) : null;

    const { colors } = useImageColor(lowResImage || rawImageUrl);

    const isLibraryArtist = source === "library";
    const showProgressivePlaceholders = isLibraryArtist && detailsLoading;

    // Play album handler
    async function handlePlayAlbum(albumId: string, albumTitle: string) {
        try {
            const albumData = await api.getAlbum(albumId);
            if (albumData.tracks && albumData.tracks.length > 0) {
                const tracksWithAlbum = albumData.tracks.map((track: Record<string, unknown>) => ({
                    ...track,
                    album: {
                        id: albumData.id,
                        title: albumData.title,
                        coverArt: albumData.coverArt,
                    },
                    artist: albumData.artist,
                }));
                playTracks(tracksWithAlbum, 0);
                toast.success(`Playing ${albumTitle}`);
            }
        } catch {
            toast.error("Failed to play album");
        }
    }

    const formatTrackForPlayback = (t: Track) => ({
        id: t.id,
        title: t.title,
        artist: {
            name: t.artist?.name || artist!.name,
            id: t.artist?.id || artist!.id,
        },
        album: {
            title: t.album?.title || "Unknown",
            coverArt: t.album?.coverArt,
            id: t.album?.id,
        },
        duration: t.duration,
        filePath: t.filePath,
        ...(t.streamSource === "tidal" && {
            streamSource: "tidal" as const,
            tidalTrackId: t.tidalTrackId,
        }),
        ...(t.streamSource === "youtube" && {
            streamSource: "youtube" as const,
            youtubeVideoId: t.youtubeVideoId,
        }),
    });

    // Play track handler (for popular tracks)
    function handlePlayTrack(track: Track) {
        const topTracks = (enrichedTopTracks || artist?.topTracks) || [];
        if (!topTracks.length) return;

        if (isInGroup) {
            // In Listen Together, clicking a popular track should queue only that track.
            playTrack(formatTrackForPlayback(track));
            return;
        }

        // Include owned tracks AND TIDAL/YouTube Music-enriched tracks
        const playableTracks = topTracks.filter(
            (t: Track) =>
                t.album?.id ||
                t.streamSource === "tidal" ||
                t.streamSource === "youtube"
        );
        const formattedTracks = playableTracks.map(formatTrackForPlayback);

        const startIndex = formattedTracks.findIndex((t) => t.id === track.id);
        playTracks(formattedTracks, Math.max(0, startIndex));
    }

    function handleAddAllPopularToQueue() {
        const topTracks = (enrichedTopTracks || artist?.topTracks) || [];
        if (!topTracks.length) return;

        const visiblePopularTracks = topTracks.slice(0, 5);
        const formattedTracks = visiblePopularTracks.map(formatTrackForPlayback);
        playTracks(formattedTracks, 0);
    }

    // Download album handler
    function handleDownloadAlbum(album: Album, e: React.MouseEvent) {
        downloadAlbum(album, artist?.name || "", e);
    }

    const [searchAlbum, setSearchAlbum] = useState<Album | null>(null);
    function handleSearchAlbum(album: Album, e: React.MouseEvent) {
        e.preventDefault();
        e.stopPropagation();
        setSearchAlbum(album);
    }

    // Start artist radio handler
    async function handleStartRadio() {
        if (!artist) return;

        try {
            toast.success(`Starting ${artist.name} Radio...`);
            const response = await api.getRadioTracks("artist", artist.id);

            if (response.tracks && response.tracks.length > 0) {
                if (isInGroup && typeof window !== "undefined") {
                    const trackLabel =
                        response.tracks.length === 1 ?
                            "1 song"
                        :   `${response.tracks.length} songs`;
                    const confirmed = window.confirm(
                        `You're in a Listen Together group. Starting artist radio will add ${trackLabel} to the shared queue. Continue?`
                    );
                    if (!confirmed) {
                        toast.info("Artist radio cancelled");
                        return;
                    }
                }

                // Backend already returns properly formatted tracks - just pass them through
                playTracks(response.tracks, 0);
                toast.success(
                    `Playing ${artist.name} Radio (${response.tracks.length} tracks)`
                );
            } else {
                toast.error(
                    "Not enough similar music in your library for artist radio"
                );
            }
        } catch {
            toast.error("Failed to start artist radio");
        }
    }

    // Loading state for initial/core request only
    if (loading) {
        return <LoadingScreen message="Loading artist..." />;
    }

    // Error or not found state
    if (error || !artist) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="text-center space-y-4">
                    <div className="text-6xl text-white/20">♪</div>
                    <h1 className="text-2xl font-semibold text-white">
                        Artist Not Found
                    </h1>
                    <p className="text-neutral-400">
                        This artist isn&apos;t in your library yet.
                    </p>
                    <button
                        onClick={() => router.back()}
                        className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-lg text-white transition-colors"
                    >
                        Go Back
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex flex-col">
            <ArtistHero
                artist={artist}
                source={source || "discovery"}
                albums={albums}
                heroImage={heroImage}
                backgroundImage={lowResImage}
                colors={colors}
                onReload={reloadArtist}
            >
                {/* Action bar inside hero for visual continuity */}
                <ArtistActionBar
                    artist={artist}
                    albums={albums}
                    source={source || "discovery"}
                    colors={colors}
                    onPlayAll={() => playAll(artist, albums)}
                    onAddAllToQueue={() => addAllToQueue(artist, albums)}
                    onShuffle={() => shufflePlay(artist, albums)}
                    onDownloadAll={() => downloadArtist(artist)}
                    onStartRadio={handleStartRadio}
                    isPendingDownload={isPendingByMbid(artist.mbid || "")}
                    isPlaying={isPlaying}
                    isPlayingThisArtist={
                        currentTrack?.artist?.id === artist.id ||
                        currentTrack?.artist?.name === artist.name
                    }
                    onPause={pause}
                    downloadsEnabled={downloadsEnabled}
                    isInListenTogetherGroup={isInGroup}
                />
            </ArtistHero>

            {/* Main Content - fills remaining viewport height */}
            <div className="relative min-h-[50vh] flex-1">
                {/* Dynamic color gradient background */}
                <div
                    className="absolute inset-0 pointer-events-none"
                    style={{
                        background:
                            colors ?
                                `linear-gradient(to bottom, ${colors.vibrant}15 0%, ${colors.vibrant}08 15%, ${colors.darkVibrant}05 30%, transparent 50%)`
                            :   "transparent",
                    }}
                />
                <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_0%,rgba(16,16,16,0.4)_100%)] pointer-events-none" />

                <div className="relative px-4 md:px-8 py-6 space-y-8">
                    {/* Bio / About */}
                    {(artist.bio || artist.summary) && (
                        <ArtistBio bio={artist.bio || artist.summary || ""} />
                    )}

                    {/* Popular Tracks */}
                    {artist.topTracks && artist.topTracks.length > 0 ? (
                        <PopularTracks
                            tracks={enrichedTopTracks || artist.topTracks}
                            artist={artist}
                            currentTrackId={currentTrack?.id}
                            colors={colors}
                            onPlayTrack={handlePlayTrack}
                            previewTrack={previewTrack}
                            previewPlaying={previewPlaying}
                            onPreview={(track: Track, e: React.MouseEvent) =>
                                handlePreview(track, artist.name, e)
                            }
                            isInListenTogetherGroup={isInGroup}
                            popularHref={`/artist/${artist.id}/popular`}
                            onAddAllToQueue={handleAddAllPopularToQueue}
                        />
                    ) : (
                        showProgressivePlaceholders && (
                            <ListSectionSkeleton title="Popular" />
                        )
                    )}

                    {/* Discography (Owned Albums) */}
                    <Discography
                        albums={ownedAlbums}
                        colors={colors}
                        onPlayAlbum={handlePlayAlbum}
                        sortBy={sortBy}
                        onSortChange={setSortBy}
                        isInListenTogetherGroup={isInGroup}
                    />

                    {/* Available Albums to Download */}
                    {availableAlbums.length > 0 ? (
                        <AvailableAlbums
                            albums={availableAlbums}
                            artistName={artist.name}
                            source={source || "discovery"}
                            colors={colors}
                            onDownloadAlbum={handleDownloadAlbum}
                            onSearchAlbum={handleSearchAlbum}
                            isPendingDownload={isPendingByMbid}
                            downloadsEnabled={downloadsEnabled}
                        />
                    ) : (
                        showProgressivePlaceholders && (
                            <GridSectionSkeleton title="Albums Available" />
                        )
                    )}

                    {/* Similar Artists */}
                    {artist.similarArtists && artist.similarArtists.length > 0 ? (
                        <SimilarArtists
                            similarArtists={artist.similarArtists}
                            onNavigate={(artistId) =>
                                router.push(`/artist/${artistId}`)
                            }
                        />
                    ) : (
                        showProgressivePlaceholders && (
                            <GridSectionSkeleton title="Fans Also Like" />
                        )
                    )}
                </div>
            </div>

            {searchAlbum && (
                <ReleaseSelectionModal
                    isOpen={Boolean(searchAlbum)}
                    onClose={() => setSearchAlbum(null)}
                    albumMbid={searchAlbum.rgMbid || searchAlbum.mbid || searchAlbum.id}
                    artistName={artist.name}
                    albumTitle={searchAlbum.title}
                />
            )}
        </div>
    );
}
