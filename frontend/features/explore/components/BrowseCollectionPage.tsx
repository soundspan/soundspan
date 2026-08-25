"use client";

import { Suspense } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import {
    ArrowLeft,
    Play,
    Pause,
    Music2,
    ListMusic,
    Shuffle,
    Plus,
    Heart,
    Loader2,
} from "lucide-react";
import { api } from "@/lib/api";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { cn } from "@/utils/cn";
import { decodeRouteId } from "@/utils/routeId";
import {
    BrowseTrackList,
    type TidalBrowseCollection,
} from "@/features/explore/browseTrack";
import {
    browseCollectionCopy,
    formatTotalDuration,
    type BrowseCollectionKind,
} from "@/features/explore/browseCollectionCopy";
import { useBrowseCollection } from "@/features/explore/hooks/useBrowseCollection";
import { useBrowseCollectionActions } from "@/features/explore/hooks/useBrowseCollectionActions";

export type { BrowseCollectionKind } from "@/features/explore/browseCollectionCopy";

export interface BrowseCollectionPageProps {
    /** Lowercase collection noun used in user-facing copy. */
    kind: BrowseCollectionKind;
    /** Fetch the collection by its decoded route id. */
    fetchCollection: (id: string) => Promise<TidalBrowseCollection>;
}

type Copy = ReturnType<typeof browseCollectionCopy>;
type Actions = ReturnType<typeof useBrowseCollectionActions>;

/**
 * Shared detail page for TIDAL browse collections (playlists and mixes).
 * The per-route pages are thin wrappers that supply the fetcher and noun.
 */
export function BrowseCollectionPage(props: BrowseCollectionPageProps) {
    return (
        <Suspense
            fallback={
                <div className="min-h-screen flex items-center justify-center">
                    <GradientSpinner size="lg" />
                </div>
            }
        >
            <BrowseCollectionPageContent {...props} />
        </Suspense>
    );
}

function BrowseCollectionPageContent({
    kind,
    fetchCollection,
}: BrowseCollectionPageProps) {
    const params = useParams();
    const router = useRouter();
    const collectionId = decodeRouteId(params.id as string);
    const copy = browseCollectionCopy(kind);

    const { collection, isLoading, error } = useBrowseCollection(
        collectionId,
        fetchCollection,
        copy.loadErrorFallback,
    );
    const actions = useBrowseCollectionActions(
        collection,
        copy.noPlayableTracks,
    );

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (error || !collection) {
        return <CollectionNotFound copy={copy} error={error} router={router} />;
    }

    return (
        <div className="min-h-screen">
            <CollectionHero collection={collection} copy={copy} />
            <CollectionActionBar
                collection={collection}
                actions={actions}
                router={router}
            />
            <div className="px-2 md:px-8 pb-32">
                {collection.tracks.length > 0 ? (
                    <BrowseTrackList
                        tracks={collection.tracks}
                        onPlayTrack={actions.handlePlayTrack}
                    />
                ) : (
                    <EmptyTracks message={copy.emptyMessage} />
                )}
            </div>

            <PlaylistSelector
                isOpen={actions.showPlaylistSelector}
                onClose={() => actions.setShowPlaylistSelector(false)}
                onSelectPlaylist={actions.handlePlaylistSelected}
                isLoading={actions.isAddingToPlaylist}
                loadingMessage="Adding tracks..."
            />
        </div>
    );
}

function CollectionNotFound({
    copy,
    error,
    router,
}: {
    copy: Copy;
    error: string | null;
    router: ReturnType<typeof useRouter>;
}) {
    return (
        <div className="min-h-screen relative">
            <div className="absolute inset-0 pointer-events-none">
                <div
                    className="absolute inset-0 bg-gradient-to-b from-[#00BFFF]/15 via-[#00BFFF]/10 to-transparent"
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
                        <Music2 className="w-8 h-8 text-gray-400" />
                    </div>
                    <h3 className="text-lg font-medium text-white mb-2">
                        {copy.notFoundTitle}
                    </h3>
                    <p className="text-sm text-gray-400 mb-6 max-w-sm">
                        {error || copy.notFoundFallback}
                    </p>
                    <button
                        onClick={() => router.push("/explore")}
                        className="px-6 py-2.5 rounded-full bg-white text-black text-sm font-medium hover:scale-105 transition-transform"
                    >
                        Explore playlists
                    </button>
                </div>
            </div>
        </div>
    );
}

function CollectionHero({
    collection,
    copy,
}: {
    collection: TidalBrowseCollection;
    copy: Copy;
}) {
    const totalDuration =
        collection.tracks.reduce((sum, track) => sum + track.duration, 0) || 0;

    return (
        <div className="relative bg-gradient-to-b from-[#00BFFF]/20 via-surface-hover to-transparent pt-16 pb-10 px-4 md:px-8">
            <div className="flex items-end gap-6">
                <div className="relative w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-surface-highlight rounded shadow-2xl shrink-0 overflow-hidden">
                    {collection.thumbnailUrl ? (
                        <Image
                            src={api.getTidalBrowseImageUrl(
                                collection.thumbnailUrl,
                            )}
                            alt={collection.title}
                            fill
                            sizes="(max-width: 768px) 140px, 192px"
                            className="object-cover"
                            unoptimized
                        />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#00BFFF]/30 to-[#00BFFF]/10">
                            <Music2 className="w-16 h-16 text-gray-400" />
                        </div>
                    )}
                </div>

                <div className="flex-1 min-w-0 pb-1">
                    <div className="flex items-center gap-2 mb-1">
                        <svg
                            viewBox="0 0 12 8"
                            className="w-4 h-4 text-[#00BFFF]"
                            fill="currentColor"
                        >
                            <path d="M2 0 L4 2 L2 4 L0 2Z" />
                            <path d="M6 0 L8 2 L6 4 L4 2Z" />
                            <path d="M10 0 L12 2 L10 4 L8 2Z" />
                            <path d="M6 4 L8 6 L6 8 L4 6Z" />
                        </svg>
                        <p className="text-xs font-medium text-white/90">
                            {copy.heroLabel}
                        </p>
                    </div>
                    <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2">
                        {collection.title}
                    </h1>
                    <div className="flex items-center gap-1 text-sm text-white/70">
                        <span>{collection.trackCount} songs</span>
                        {totalDuration > 0 && (
                            <span>, {formatTotalDuration(totalDuration)}</span>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

function CollectionActionBar({
    collection,
    actions,
    router,
}: {
    collection: TidalBrowseCollection;
    actions: Actions;
    router: ReturnType<typeof useRouter>;
}) {
    return (
        <div className="bg-gradient-to-b from-surface-hover/60 to-transparent px-4 md:px-8 py-4">
            <div className="flex items-center gap-4">
                <button
                    onClick={actions.handleTogglePlay}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#00BFFF] hover:bg-[#00BFFF]/80 hover:scale-105 shadow-lg transition-all font-semibold text-sm text-white"
                >
                    {actions.showPlaySpinner ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                    ) : actions.isThisCollectionPlaying && actions.isPlaying ? (
                        <Pause className="w-5 h-5 fill-current" />
                    ) : (
                        <Play className="w-5 h-5 fill-current ml-0.5" />
                    )}
                    <span>
                        {actions.isThisCollectionPlaying && actions.isPlaying
                            ? "Pause"
                            : "Play All"}
                    </span>
                </button>

                {collection.tracks.length > 1 && (
                    <button
                        onClick={actions.handleShuffle}
                        className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                        title="Shuffle play"
                    >
                        <Shuffle className="w-5 h-5" />
                    </button>
                )}

                <button
                    onClick={actions.handleAddToQueue}
                    className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                    title="Add all to queue"
                >
                    <ListMusic className="w-5 h-5" />
                </button>

                <button
                    onClick={() => actions.setShowPlaylistSelector(true)}
                    className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                    title="Add all to playlist"
                >
                    <Plus className="w-5 h-5" />
                </button>

                {actions.likeableTracks.length > 0 && (
                    <LikeAllButton actions={actions} />
                )}

                <div className="flex-1" />

                <button
                    onClick={() => router.back()}
                    className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors"
                >
                    <ArrowLeft className="w-4 h-4" />
                    <span className="hidden sm:inline">Back</span>
                </button>
            </div>
        </div>
    );
}

function LikeAllButton({ actions }: { actions: Actions }) {
    return (
        <button
            onClick={actions.toggleLikeAll}
            disabled={actions.isApplyingLikeAll}
            className={cn(
                "h-8 w-8 rounded-full flex items-center justify-center transition-all",
                actions.isApplyingLikeAll
                    ? "cursor-not-allowed text-white/35"
                    : actions.isAllLiked
                      ? "text-brand hover:bg-white/10"
                      : "text-white/60 hover:bg-white/10 hover:text-white",
            )}
            title={actions.isAllLiked ? "Unlike all tracks" : "Like all tracks"}
        >
            {actions.isApplyingLikeAll ? (
                <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
                <Heart
                    className={cn(
                        "h-4 w-4",
                        actions.isAllLiked && "fill-current",
                    )}
                />
            )}
        </button>
    );
}

function EmptyTracks({ message }: { message: string }) {
    return (
        <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-20 h-20 bg-surface-highlight rounded-full flex items-center justify-center mb-4">
                <Music2 className="w-10 h-10 text-gray-400" />
            </div>
            <h3 className="text-lg font-medium text-white mb-1">
                No tracks found
            </h3>
            <p className="text-sm text-gray-400">{message}</p>
        </div>
    );
}
