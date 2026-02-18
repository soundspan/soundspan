"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Search, Loader2, Music2, Link2, X, ChevronRight, Info, Globe } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { PageHeader } from "@/components/layout/PageHeader";

// Types
interface PlaylistPreview {
    id: string;
    source: "deezer" | "spotify";
    type: "playlist" | "radio";
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    url: string;
}

interface Genre {
    id: number;
    name: string;
    imageUrl: string | null;
}

// Deezer icon component
const DeezerIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M18.81 4.16v3.03H24V4.16h-5.19zM6.27 8.38v3.027h5.189V8.38h-5.19zm12.54 0v3.027H24V8.38h-5.19zM6.27 12.595v3.027h5.189v-3.027h-5.19zm6.27 0v3.027h5.19v-3.027h-5.19zm6.27 0v3.027H24v-3.027h-5.19zM0 16.81v3.029h5.19v-3.03H0zm6.27 0v3.029h5.189v-3.03h-5.19zm6.27 0v3.029h5.19v-3.03h-5.19zm6.27 0v3.029H24v-3.03h-5.19z" />
    </svg>
);

// Tab type (radios removed - now personal library content at /radio)
type BrowseTab = "playlists" | "genres";

// Loading skeleton for cards
const CardSkeleton = () => (
    <div className="animate-pulse">
        <div className="aspect-square rounded-md bg-white/10 mb-3" />
        <div className="h-4 w-3/4 bg-white/10 rounded mb-2" />
        <div className="h-3 w-1/2 bg-white/5 rounded" />
    </div>
);

export default function BrowsePlaylistsPage() {
    const router = useRouter();
    const { toast } = useToast();

    // UI State
    const [activeTab, setActiveTab] = useState<BrowseTab>("playlists");
    const [searchQuery, setSearchQuery] = useState("");
    const [isLoading, setIsLoading] = useState(true);
    const [isSearching, setIsSearching] = useState(false);
    const [hasSearched, setHasSearched] = useState(false);
    const [showUrlModal, setShowUrlModal] = useState(false);
    const [urlInput, setUrlInput] = useState("");
    const [isParsing, setIsParsing] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    // Data State
    const [playlists, setPlaylists] = useState<PlaylistPreview[]>([]);
    const [genres, setGenres] = useState<Genre[]>([]);
    const [selectedGenre, setSelectedGenre] = useState<Genre | null>(null);
    const [genrePlaylists, setGenrePlaylists] = useState<PlaylistPreview[]>([]);
    const { showSpinner, triggerPlayFeedback } = usePlayButtonFeedback();
    const [playFeedbackCardKey, setPlayFeedbackCardKey] = useState<string | null>(null);

    // Fetch all browse content on mount
    const fetchAllContent = useCallback(async () => {
        setIsLoading(true);
        setLoadError(null);
        try {
            const response = await api.get<{
                playlists: PlaylistPreview[];
                genres: Genre[];
            }>("/browse/all");

            setPlaylists(response.playlists);
            setGenres(response.genres);
        } catch (error) {
            console.error("Failed to fetch browse content:", error);
            setLoadError(
                "Couldn't load playlists. Check your connection and try again."
            );
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchAllContent();
    }, [fetchAllContent]);

    useEffect(() => {
        if (!showSpinner) {
            setPlayFeedbackCardKey(null);
        }
    }, [showSpinner]);

    // Search playlists
    const handleSearch = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!searchQuery.trim() || searchQuery.length < 2) {
            if (!searchQuery.trim()) {
                setHasSearched(false);
            }
            return;
        }

        setIsSearching(true);
        setHasSearched(true);
        setActiveTab("playlists"); // Switch to playlists for search results

        try {
            const response = await api.get<{
                playlists: PlaylistPreview[];
            }>(
                `/browse/playlists/search?q=${encodeURIComponent(
                    searchQuery
                )}&limit=100`
            );
            setPlaylists(response.playlists);
        } catch (error) {
            console.error("Search failed:", error);
            toast.error("Failed to search playlists");
        } finally {
            setIsSearching(false);
        }
    };

    // Clear search
    const clearSearch = () => {
        setSearchQuery("");
        setHasSearched(false);
        fetchAllContent();
    };

    // Parse URL and redirect to import
    const handleUrlSubmit = async () => {
        if (!urlInput.trim()) return;

        setIsParsing(true);

        try {
            const response = await api.post<{
                source: string;
                id: string;
                url: string;
            }>("/browse/playlists/parse", { url: urlInput.trim() });
            setShowUrlModal(false);
            setUrlInput("");
            router.push(
                `/import/spotify?url=${encodeURIComponent(response.url)}`
            );
        } catch (error: unknown) {
            const message =
                error instanceof Error ? error.message : "Invalid playlist URL";
            toast.error(message);
        } finally {
            setIsParsing(false);
        }
    };

    // Handle playlist click - navigate to detail page
    const handleItemClick = (item: PlaylistPreview) => {
        router.push(`/browse/playlists/${item.id}`);
    };

    // Handle genre click
    const handleGenreClick = async (genre: Genre) => {
        setSelectedGenre(genre);
        setIsLoading(true);

        try {
            const response = await api.get<{
                playlists: PlaylistPreview[];
            }>(`/browse/genres/${genre.id}/playlists?limit=50`);
            setGenrePlaylists(response.playlists);
        } catch (error) {
            console.error("Failed to fetch genre playlists:", error);
            toast.error("Failed to load genre playlists");
        } finally {
            setIsLoading(false);
        }
    };

    // Back from genre view
    const handleBackFromGenre = () => {
        setSelectedGenre(null);
        setGenrePlaylists([]);
    };

    // Render playlist card
    const renderCard = (
        item: PlaylistPreview,
        index: number,
        context?: string
    ) => {
        const cardKey = `${item.source}-${item.type}-${item.id}-${context || "main"}-${index}`;
        const showCardSpinner = showSpinner && playFeedbackCardKey === cardKey;

        return (
            <div
                key={cardKey}
                onClick={() => {
                    setPlayFeedbackCardKey(cardKey);
                    triggerPlayFeedback();
                    handleItemClick(item);
                }}
                className="group cursor-pointer"
            >
                <div className="relative aspect-square mb-3 rounded-md overflow-hidden bg-[#282828] shadow-lg">
                    {item.imageUrl ? (
                        <Image
                            src={item.imageUrl}
                            alt={item.title}
                            fill
                            sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, (max-width: 1280px) 20vw, (max-width: 1536px) 16vw, 14vw"
                            className="object-cover group-hover:scale-105 transition-transform duration-300"
                            unoptimized
                        />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#AD47FF]/30 to-[#AD47FF]/10">
                            <Music2 className="w-12 h-12 text-gray-600" />
                        </div>
                    )}
                    {/* Import button on hover */}
                    <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all duration-200">
                        <div className="w-12 h-12 rounded-full bg-[#60a5fa] flex items-center justify-center shadow-xl hover:scale-105 transition-transform">
                            {showCardSpinner ? (
                                <Loader2 className="w-5 h-5 text-black animate-spin" />
                            ) : (
                                <svg
                                    viewBox="0 0 24 24"
                                    className="w-5 h-5 text-black ml-0.5"
                                    fill="currentColor"
                                >
                                    <path d="M8 5v14l11-7z" />
                                </svg>
                            )}
                        </div>
                    </div>
                </div>
                <h3 className="text-sm font-semibold text-white truncate mb-1">
                    {item.title}
                </h3>
                <p className="text-xs text-gray-400 truncate">
                    {item.trackCount} songs • {item.creator}
                </p>
            </div>
        );
    };

    // Render genre card
    const renderGenreCard = (genre: Genre) => (
        <div
            key={genre.id}
            onClick={() => handleGenreClick(genre)}
            className="group cursor-pointer relative aspect-square rounded-lg overflow-hidden"
        >
            {genre.imageUrl ? (
                <Image
                    src={genre.imageUrl}
                    alt={genre.name}
                    fill
                    sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, (max-width: 1280px) 20vw, 16vw"
                    className="object-cover group-hover:scale-105 transition-transform duration-300"
                    unoptimized
                />
            ) : (
                <div className="w-full h-full bg-gradient-to-br from-[#AD47FF] to-[#3b82f6]" />
            )}
            <div className="absolute inset-0 bg-black/40 group-hover:bg-black/30 transition-colors" />
            <div className="absolute bottom-3 left-3 right-3">
                <h3 className="text-lg font-bold text-white">{genre.name}</h3>
            </div>
        </div>
    );

    return (
        <div className="min-h-screen relative">
            {/* Gradient - Same as home page (yellow → purple) */}
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

            <div className="relative px-4 md:px-8 py-6">
                {/* Header */}
                <PageHeader
                    title="Browse"
                    subtitle="Discover and import playlists from Deezer"
                    icon={Globe}
                    className="mb-6"
                    badge={
                        <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-[#3b82f6]/20 text-[#3b82f6] border border-[#3b82f6]/30">
                            Beta
                        </span>
                    }
                />

                {/* Beta Notice */}
                <div className="mb-6 flex items-start gap-3 px-4 py-3 rounded-lg bg-[#3b82f6]/10 border border-[#3b82f6]/20">
                    <Info className="w-5 h-5 text-[#3b82f6] shrink-0 mt-0.5" />
                    <p className="text-sm text-gray-300">
                        <span className="font-medium text-[#3b82f6]">Beta feature:</span>{" "}
                        Importing from Spotify and Deezer relies on matching tracks through Soulseek and your configured indexers.
                        Results may vary depending on track availability and metadata quality.
                    </p>
                </div>

                {/* Search Bar & Import URL */}
                <div className="flex items-center gap-3 mb-6">
                    <form
                        onSubmit={handleSearch}
                        className="relative flex-1 max-w-md"
                    >
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-900" />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search playlists..."
                            className="w-full bg-white rounded-full pl-11 pr-10 py-3 text-sm text-gray-900 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-white"
                        />
                        {searchQuery && (
                            <button
                                type="button"
                                onClick={clearSearch}
                                className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-900"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        )}
                    </form>

                    <button
                        onClick={() => setShowUrlModal(true)}
                        className="flex items-center gap-2 px-4 py-3 rounded-full bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors"
                    >
                        <Link2 className="w-4 h-4" />
                        <span className="hidden sm:inline">Import URL</span>
                    </button>
                </div>

                {/* Tabs */}
                {!selectedGenre && !hasSearched && (
                    <div className="flex items-center gap-2 mb-6">
                        <button
                            onClick={() => setActiveTab("playlists")}
                            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                                activeTab === "playlists"
                                    ? "bg-white text-black"
                                    : "bg-white/10 text-white hover:bg-white/20"
                            }`}
                        >
                            Playlists
                        </button>
                        <button
                            onClick={() => setActiveTab("genres")}
                            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                                activeTab === "genres"
                                    ? "bg-[#3b82f6] text-black"
                                    : "bg-white/10 text-white hover:bg-white/20"
                            }`}
                        >
                            Genres
                        </button>
                    </div>
                )}

                {/* Genre Breadcrumb */}
                {selectedGenre && (
                    <div className="flex items-center gap-2 mb-6">
                        <button
                            onClick={handleBackFromGenre}
                            className="text-sm text-gray-400 hover:text-white transition-colors"
                        >
                            Genres
                        </button>
                        <ChevronRight className="w-4 h-4 text-gray-600" />
                        <span className="text-sm text-white font-medium">
                            {selectedGenre.name}
                        </span>
                    </div>
                )}

                {/* Loading State with Skeleton Cards */}
                {(isLoading || isSearching) && !loadError && (
                    <div>
                        <div className="h-6 w-48 bg-white/10 rounded mb-4 animate-pulse" />
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-6">
                            {Array.from({ length: 14 }).map((_, i) => (
                                <CardSkeleton key={i} />
                            ))}
                        </div>
                    </div>
                )}

                {/* Error State */}
                {loadError && !isLoading && (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                        <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
                            <Music2 className="w-8 h-8 text-gray-500" />
                        </div>
                        <h3 className="text-lg font-medium text-white mb-2">
                            Couldn&apos;t load content
                        </h3>
                        <p className="text-sm text-gray-400 mb-6 max-w-sm">
                            {loadError}
                        </p>
                        <button
                            onClick={fetchAllContent}
                            className="px-6 py-2.5 rounded-full bg-white text-black text-sm font-medium hover:scale-105 transition-transform"
                        >
                            Try again
                        </button>
                    </div>
                )}

                {/* Search Results */}
                {!isLoading && !isSearching && hasSearched && (
                    <>
                        <h2 className="text-xl font-bold text-white mb-4">
                            Results for &ldquo;{searchQuery}&rdquo;
                        </h2>
                        {playlists.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-20 text-center">
                                <h3 className="text-lg font-medium text-white mb-2">
                                    No playlists found
                                </h3>
                                <p className="text-sm text-gray-400 mb-4">
                                    Try a different search or import a URL
                                    directly
                                </p>
                                <button
                                    onClick={() => setShowUrlModal(true)}
                                    className="px-6 py-2 rounded-full bg-white text-black text-sm font-medium hover:scale-105 transition-transform"
                                >
                                    Import by URL
                                </button>
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-6">
                                {playlists.map((item, idx) =>
                                    renderCard(item, idx, "search")
                                )}
                            </div>
                        )}
                    </>
                )}

                {/* Genre Playlists View */}
                {!isLoading && selectedGenre && (
                    <>
                        <h2 className="text-xl font-bold text-white mb-4">
                            {selectedGenre.name} Playlists
                        </h2>
                        {genrePlaylists.length === 0 ? (
                            <p className="text-gray-400">
                                No playlists found for this genre
                            </p>
                        ) : (
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-6">
                                {genrePlaylists.map((item, idx) =>
                                    renderCard(item, idx, "genre")
                                )}
                            </div>
                        )}
                    </>
                )}

                {/* Main Content (no search, no genre selected) */}
                {!isLoading &&
                    !isSearching &&
                    !hasSearched &&
                    !selectedGenre && (
                        <>
                            {/* Playlists Tab */}
                            {activeTab === "playlists" && (
                                <>
                                    <h2 className="text-xl font-bold text-white mb-4">
                                        Featured Playlists
                                    </h2>
                                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-6">
                                        {playlists.map((item, idx) =>
                                            renderCard(item, idx, "featured")
                                        )}
                                    </div>
                                    {playlists.length >= 20 && (
                                        <p className="text-center text-sm text-gray-500 mt-8">
                                            Showing {playlists.length} playlists
                                            • Search for more or import by URL
                                        </p>
                                    )}
                                </>
                            )}

                            {/* Genres Tab */}
                            {activeTab === "genres" && (
                                <>
                                    <h2 className="text-xl font-bold text-white mb-4">
                                        Browse by Genre
                                    </h2>
                                    <p className="text-sm text-gray-400 mb-6">
                                        Explore playlists organized by musical
                                        genre
                                    </p>
                                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                                        {genres.map(renderGenreCard)}
                                    </div>
                                </>
                            )}
                        </>
                    )}
            </div>

            {/* URL Import Modal - Modern Spotify-style */}
            {showUrlModal && (
                <div
                    className="fixed inset-0 bg-black/80  flex items-center justify-center z-50 p-4 animate-in fade-in duration-200"
                    onClick={() => setShowUrlModal(false)}
                >
                    <div
                        className="bg-[#0d0d0d] rounded-2xl max-w-lg w-full shadow-2xl border border-white/[0.03] animate-in zoom-in-95 duration-200"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header with gradient accent */}
                        <div className="relative px-6 pt-6 pb-4">
                            <button
                                onClick={() => setShowUrlModal(false)}
                                className="absolute top-4 right-4 p-2 hover:bg-white/10 rounded-full transition-colors group"
                            >
                                <X className="w-5 h-5 text-white/40 group-hover:text-white transition-colors" />
                            </button>

                            <div className="flex items-center gap-3 mb-2">
                                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#3b82f6] to-[#AD47FF] flex items-center justify-center">
                                    <Link2 className="w-5 h-5 text-white" />
                                </div>
                                <h3 className="text-xl font-bold text-white">
                                    Import Playlist
                                </h3>
                            </div>
                            <p className="text-sm text-white/40 ml-[52px]">
                                Paste a link to get started
                            </p>
                        </div>

                        {/* Supported platforms */}
                        <div className="px-6 pb-4">
                            <div className="flex items-center gap-3 p-3 bg-white/[0.03] rounded-xl border border-white/[0.03]">
                                <div className="flex items-center gap-2 px-3 py-1.5 bg-[#1DB954]/10 rounded-full">
                                    <svg
                                        viewBox="0 0 24 24"
                                        className="w-4 h-4 text-[#1DB954]"
                                        fill="currentColor"
                                    >
                                        <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
                                    </svg>
                                    <span className="text-xs font-medium text-[#1DB954]">
                                        Spotify
                                    </span>
                                </div>
                                <div className="flex items-center gap-2 px-3 py-1.5 bg-[#AD47FF]/10 rounded-full">
                                    <DeezerIcon className="w-4 h-4 text-[#AD47FF]" />
                                    <span className="text-xs font-medium text-[#AD47FF]">
                                        Deezer
                                    </span>
                                </div>
                                <span className="text-xs text-white/30 ml-auto">
                                    Supported
                                </span>
                            </div>
                        </div>

                        {/* Input area */}
                        <div className="px-6 pb-6">
                            <div className="relative">
                                <input
                                    type="text"
                                    value={urlInput}
                                    onChange={(e) =>
                                        setUrlInput(e.target.value)
                                    }
                                    placeholder="Paste playlist URL here..."
                                    className="w-full bg-black/40 border border-white/[0.06] rounded-xl px-4 py-4 text-white placeholder:text-white/30 focus:outline-none focus:border-[#3b82f6]/40 focus:ring-1 focus:ring-[#3b82f6]/20 transition-all text-sm"
                                    onKeyDown={(e) =>
                                        e.key === "Enter" && handleUrlSubmit()
                                    }
                                    autoFocus
                                />
                                {urlInput && (
                                    <button
                                        onClick={() => setUrlInput("")}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 hover:bg-white/10 rounded-full transition-colors"
                                    >
                                        <X className="w-4 h-4 text-white/40" />
                                    </button>
                                )}
                            </div>

                            <p className="text-xs text-white/30 mt-2 ml-1">
                                Example:
                                https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
                            </p>
                        </div>

                        {/* Actions */}
                        <div className="px-6 pb-6 flex gap-3">
                            <button
                                onClick={() => setShowUrlModal(false)}
                                className="flex-1 py-3.5 rounded-full bg-white/[0.03] border border-white/[0.06] text-white font-medium hover:bg-white/[0.06] transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleUrlSubmit}
                                disabled={isParsing || !urlInput.trim()}
                                className="flex-1 py-3.5 rounded-full bg-[#60a5fa] text-black font-semibold hover:bg-[#3b82f6] disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 shadow-lg shadow-[#60a5fa]/20"
                            >
                                {isParsing ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        <span>Importing...</span>
                                    </>
                                ) : (
                                    <>
                                        <ChevronRight className="w-4 h-4" />
                                        <span>Continue</span>
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
