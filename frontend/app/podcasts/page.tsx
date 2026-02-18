"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { Mic2, Search, Plus, Link2 } from "lucide-react";
import { useToast } from "@/lib/toast-context";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { usePodcastsQuery, useTopPodcastsQuery } from "@/hooks/useQueries";
import Image from "next/image";
import { PageHeader } from "@/components/layout/PageHeader";

// Always proxy images through the backend for caching and mobile compatibility
const getProxiedImageUrl = (imageUrl: string | undefined): string | null => {
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 300);
};

interface SearchResult {
    type?: string;
    id: number;
    name?: string;
    artist?: string;
    title?: string;
    author?: string;
    coverUrl: string;
    feedUrl: string;
    trackCount?: number;
    itunesId?: number;
}

export default function PodcastsPage() {
    const [searchQuery, setSearchQuery] = useState("");
    const [rssUrl, setRssUrl] = useState("");
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [isAddingRss, setIsAddingRss] = useState(false);
    const [showDropdown, setShowDropdown] = useState(false);
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const { isAuthenticated } = useAuth();
    const router = useRouter();
    const { toast } = useToast();

    // Use React Query hooks
    const { data: podcasts = [], isLoading: isLoadingPodcasts } =
        usePodcastsQuery();
    const { data: topPodcasts = [], isLoading: isLoadingTopPodcasts } =
        useTopPodcastsQuery(12);

    // Fetch genre-based discovery podcasts
    const { data: relatedPodcasts = {}, isLoading: isLoadingRelatedPodcasts } = useQuery({
        queryKey: ["podcasts", "discovery", "genres"],
        queryFn: async () => {
            const genreIds = [1303, 1324, 1489, 1488, 1321, 1545, 1502];
            return api.getPodcastsByGenre(genreIds);
        },
        staleTime: 10 * 60 * 1000,
        enabled: isAuthenticated,
    });

    // Sorting and pagination state for "My Podcasts"
    type SortOption = 'title' | 'author' | 'recent';
    const [sortBy, setSortBy] = useState<SortOption>('title');
    const [itemsPerPage, setItemsPerPage] = useState<number>(50);
    const [currentPage, setCurrentPage] = useState(1);

    const showMyPodcastsSkeleton = isLoadingPodcasts && podcasts.length === 0;
    const showTopPodcastsSkeleton =
        isLoadingTopPodcasts && topPodcasts.length === 0;
    const showGenreDiscoverySkeleton =
        isAuthenticated &&
        isLoadingRelatedPodcasts &&
        Object.keys(relatedPodcasts).length === 0;

    // Sort and paginate "My Podcasts"
    const sortedPodcasts = useMemo(() => {
        const sorted = [...podcasts];
        switch (sortBy) {
            case 'title':
                sorted.sort((a, b) => a.title.localeCompare(b.title));
                break;
            case 'author':
                sorted.sort((a, b) => a.author.localeCompare(b.author));
                break;
            case 'recent':
                // Sort by episode count (most episodes = most likely actively listened)
                sorted.sort((a, b) => (b.episodeCount || 0) - (a.episodeCount || 0));
                break;
        }
        return sorted;
    }, [podcasts, sortBy]);

    const totalPages = Math.ceil(sortedPodcasts.length / itemsPerPage);
    const paginatedPodcasts = useMemo(() => {
        const start = (currentPage - 1) * itemsPerPage;
        return sortedPodcasts.slice(start, start + itemsPerPage);
    }, [sortedPodcasts, currentPage, itemsPerPage]);

    // Reset page when sort changes
    useEffect(() => {
        setCurrentPage(1);
    }, [sortBy]);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (
                dropdownRef.current &&
                !dropdownRef.current.contains(event.target as Node)
            ) {
                setShowDropdown(false);
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    // Debounced search
    useEffect(() => {
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }

        if (searchQuery.trim().length < 2) {
            setSearchResults([]);
            setShowDropdown(false);
            return;
        }

        setIsSearching(true);
        searchTimeoutRef.current = setTimeout(async () => {
            try {
                // Use discover endpoint to search iTunes for NEW podcasts
                const results = await api.discoverSearch(
                    searchQuery,
                    "podcasts",
                    8
                );

                // Filter for podcasts from the results array
                const podcastResults =
                    results?.results?.filter(
                        (r: { type: string }) => r.type === "podcast"
                    ) || [];
                setSearchResults(podcastResults);
                setShowDropdown(podcastResults.length > 0);
            } catch (error) {
                console.error("Podcast search failed:", error);
                setSearchResults([]);
                setShowDropdown(false);
            } finally {
                setIsSearching(false);
            }
        }, 500);

        return () => {
            if (searchTimeoutRef.current) {
                clearTimeout(searchTimeoutRef.current);
            }
        };
    }, [searchQuery]);

    const handleAddByRss = async () => {
        if (isAddingRss) return;

        const trimmedUrl = rssUrl.trim();
        if (!trimmedUrl) {
            toast.error("Enter an RSS feed URL");
            return;
        }

        try {
            const parsedUrl = new URL(trimmedUrl);
            if (
                parsedUrl.protocol !== "http:" &&
                parsedUrl.protocol !== "https:"
            ) {
                toast.error("RSS URL must start with http:// or https://");
                return;
            }
        } catch {
            toast.error("Enter a valid RSS feed URL");
            return;
        }

        try {
            setIsAddingRss(true);
            const response = await api.subscribePodcast(trimmedUrl);

            if (response.success && response.podcast?.id) {
                setRssUrl("");
                toast.success("Podcast subscribed");
                router.push(`/podcasts/${response.podcast.id}`);
                return;
            }

            toast.error("Failed to subscribe to RSS feed");
        } catch (error: unknown) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to subscribe to RSS feed"
            );
        } finally {
            setIsAddingRss(false);
        }
    };

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

            {/* Hero Section */}
            <div className="relative">
                <div className="px-4 md:px-8 py-6">
                    <PageHeader
                        title="Podcasts"
                        subtitle="Subscribe and stream your favorite shows"
                        icon={Mic2}
                        className="mb-4"
                    />

                    {/* Quick Search - Full Width on Mobile */}
                    <div
                        className="relative w-full md:w-96 md:ml-auto"
                        ref={dropdownRef}
                    >
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 z-10" />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Quick add..."
                            className="w-full pl-11 pr-4 py-3 bg-white/5 border border-white/10 rounded-full text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 focus:bg-white/10 transition-all text-sm"
                        />
                        {isSearching && (
                            <div className="absolute right-4 top-1/2 -translate-y-1/2 z-10">
                                <GradientSpinner size="sm" />
                            </div>
                        )}

                        {/* Dropdown Results */}
                        {showDropdown && searchResults.length > 0 && (
                            <div className="absolute top-full left-0 mt-2 w-full bg-[#121212] border border-white/10 rounded-lg shadow-2xl overflow-hidden z-50 max-h-96 overflow-y-auto">
                                {searchResults.map((result) => {
                                    const imageUrl = getProxiedImageUrl(result.coverUrl);
                                    return (
                                        <div
                                            key={result.id}
                                            className="flex items-center gap-3 p-3 hover:bg-white/5 transition-colors cursor-pointer border-b border-white/5 last:border-b-0"
                                            onClick={() => {
                                                router.push(
                                                    `/podcasts/${result.id}`
                                                );
                                                setShowDropdown(false);
                                            }}
                                        >
                                            {/* Cover Art */}
                                            <div className="w-12 h-12 rounded-full bg-[#181818] flex-shrink-0 overflow-hidden relative">
                                                {imageUrl ? (
                                                    <Image
                                                        src={imageUrl}
                                                        alt={result.name || "Podcast"}
                                                        fill
                                                        sizes="48px"
                                                        className="object-cover"
                                                        unoptimized
                                                    />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center">
                                                        <Mic2 className="w-6 h-6 text-gray-600" />
                                                    </div>
                                                )}
                                            </div>

                                            {/* Info */}
                                            <div className="flex-1 min-w-0">
                                                <h3 className="text-white font-semibold text-sm truncate">
                                                    {result.name}
                                                </h3>
                                                <p className="text-gray-400 text-xs truncate">
                                                    {result.artist}
                                                </p>
                                            </div>

                                            {/* Add Button */}
                                            <div className="flex-shrink-0">
                                                <div className="w-8 h-8 rounded-full bg-purple-500 hover:bg-purple-400 flex items-center justify-center transition-colors">
                                                    <Plus className="w-4 h-4 text-white" />
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* No Results */}
                        {showDropdown &&
                            searchResults.length === 0 &&
                            !isSearching &&
                            searchQuery.length >= 2 && (
                                <div className="absolute top-full left-0 mt-2 w-full bg-[#121212] border border-white/10 rounded-lg shadow-2xl p-4 z-50">
                                    <p className="text-gray-400 text-sm text-center">
                                        No podcasts found for &quot;{searchQuery}&quot;
                                    </p>
                                </div>
                            )}
                    </div>

                    {/* Add by RSS URL */}
                    <div className="w-full md:w-96 md:ml-auto mt-3">
                        <div className="flex items-center gap-2">
                            <div className="relative flex-1">
                                <Link2 className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 z-10" />
                                <input
                                    type="url"
                                    value={rssUrl}
                                    onChange={(e) => setRssUrl(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            e.preventDefault();
                                            handleAddByRss();
                                        }
                                    }}
                                    placeholder="Add by RSS URL..."
                                    className="w-full pl-11 pr-4 py-3 bg-white/5 border border-white/10 rounded-full text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 focus:bg-white/10 transition-all text-sm"
                                />
                            </div>
                            <button
                                onClick={handleAddByRss}
                                disabled={isAddingRss}
                                className="h-11 px-4 rounded-full bg-[#60a5fa] hover:bg-[#93c5fd] text-black font-semibold text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                                {isAddingRss ? "Adding..." : "Add RSS"}
                            </button>
                        </div>
                        <p className="mt-2 px-2 text-xs text-gray-400">
                            Example:{" "}
                            <span className="font-mono">
                                https://example.com/podcast/feed.xml
                            </span>
                        </p>
                    </div>
                </div>
            </div>

            <div className="relative px-4 md:px-8 pb-24 space-y-12">
                {/* My Podcasts */}
                {(podcasts.length > 0 || showMyPodcastsSkeleton) && (
                    <section>
                        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                            <h2 className="text-xl font-bold text-white">
                                My Podcasts
                            </h2>
                            <div className="flex flex-wrap items-center gap-2">
                                {/* Sort Dropdown */}
                                <select
                                    value={sortBy}
                                    onChange={(e) => setSortBy(e.target.value as SortOption)}
                                    className="px-4 py-2 bg-[#1a1a1a] border border-white/10 rounded-full text-white text-sm focus:outline-none focus:border-purple-500 [&>option]:bg-[#1a1a1a] [&>option]:text-white"
                                    disabled={showMyPodcastsSkeleton}
                                >
                                    <option value="title">Title (A-Z)</option>
                                    <option value="author">Author (A-Z)</option>
                                    <option value="recent">Most Episodes</option>
                                </select>

                                {/* Items per page */}
                                <select
                                    value={itemsPerPage}
                                    onChange={(e) => {
                                        setItemsPerPage(Number(e.target.value));
                                        setCurrentPage(1);
                                    }}
                                    className="px-4 py-2 bg-[#1a1a1a] border border-white/10 rounded-full text-white text-sm focus:outline-none focus:border-purple-500 [&>option]:bg-[#1a1a1a] [&>option]:text-white"
                                    disabled={showMyPodcastsSkeleton}
                                >
                                    <option value={25}>25 per page</option>
                                    <option value={50}>50 per page</option>
                                    <option value={100}>100 per page</option>
                                    <option value={250}>250 per page</option>
                                </select>

                                <span className="text-sm text-gray-400">
                                    {podcasts.length} {podcasts.length === 1 ? 'podcast' : 'podcasts'}
                                </span>
                            </div>
                        </div>
                        {showMyPodcastsSkeleton ? (
                            <PodcastGridSkeleton count={10} />
                        ) : (
                            <div
                                className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-5 2xl:grid-cols-5 3xl:grid-cols-5 gap-4"
                                data-tv-section="my-podcasts"
                            >
                                {paginatedPodcasts.map((podcast, index) => {
                                    const imageUrl = getProxiedImageUrl(podcast.coverUrl);
                                    return (
                                        <div
                                            key={podcast.id}
                                            onClick={() =>
                                                router.push(`/podcasts/${podcast.id}`)
                                            }
                                            data-tv-card
                                            data-tv-card-index={index}
                                            tabIndex={0}
                                            className="bg-transparent hover:bg-white/5 transition-all p-3 rounded-md cursor-pointer group"
                                        >
                                            <div className="w-full aspect-square bg-[#282828] rounded-full mb-2.5 overflow-hidden relative shadow-lg">
                                                {imageUrl ? (
                                                    <Image
                                                        src={imageUrl}
                                                        alt={podcast.title}
                                                        fill
                                                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 20vw"
                                                        className="object-cover group-hover:scale-105 transition-transform"
                                                        unoptimized
                                                    />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center">
                                                        <Mic2 className="w-16 h-16 text-gray-700" />
                                                    </div>
                                                )}
                                            </div>
                                            <h3 className="text-sm font-semibold text-white truncate mb-0.5">
                                                {podcast.title}
                                            </h3>
                                            <p className="text-xs text-gray-400 truncate">
                                                {podcast.author}
                                            </p>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* Pagination Controls */}
                        {!showMyPodcastsSkeleton && totalPages > 1 && (
                            <div className="flex items-center justify-center gap-2 mt-8 pt-4 border-t border-white/10">
                                <button
                                    onClick={() => setCurrentPage(1)}
                                    disabled={currentPage === 1}
                                    className="px-3 py-2 text-sm text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    First
                                </button>
                                <button
                                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                    disabled={currentPage === 1}
                                    className="px-3 py-2 text-sm text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    Prev
                                </button>
                                <span className="px-4 py-2 text-sm text-white">
                                    Page {currentPage} of {totalPages}
                                </span>
                                <button
                                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                                    disabled={currentPage === totalPages}
                                    className="px-3 py-2 text-sm text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    Next
                                </button>
                                <button
                                    onClick={() => setCurrentPage(totalPages)}
                                    disabled={currentPage === totalPages}
                                    className="px-3 py-2 text-sm text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    Last
                                </button>
                            </div>
                        )}
                    </section>
                )}

                {/* Top Podcasts */}
                {(topPodcasts.length > 0 || showTopPodcastsSkeleton) && (
                    <section>
                        <h2 className="text-xl font-bold text-white mb-6">
                            Top Podcasts
                        </h2>
                        {showTopPodcastsSkeleton ? (
                            <PodcastGridSkeleton count={10} />
                        ) : (
                            <div
                                className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-5 2xl:grid-cols-5 3xl:grid-cols-5 gap-4"
                                data-tv-section="top-podcasts"
                            >
                                {topPodcasts.map((podcast, index) => {
                                    const imageUrl = getProxiedImageUrl(podcast.coverUrl);
                                    return (
                                        <div
                                            key={podcast.id}
                                            onClick={() =>
                                                router.push(`/podcasts/${podcast.id}`)
                                            }
                                            data-tv-card
                                            data-tv-card-index={index}
                                            tabIndex={0}
                                            className="bg-transparent hover:bg-white/5 transition-all p-3 rounded-md cursor-pointer group"
                                        >
                                            <div className="w-full aspect-square bg-[#282828] rounded-full mb-2.5 overflow-hidden relative shadow-lg">
                                                {imageUrl ? (
                                                    <Image
                                                        src={imageUrl}
                                                        alt={podcast.title}
                                                        fill
                                                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 20vw"
                                                        className="object-cover group-hover:scale-105 transition-transform"
                                                        unoptimized
                                                    />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center">
                                                        <Mic2 className="w-16 h-16 text-gray-700" />
                                                    </div>
                                                )}
                                            </div>
                                            <h3 className="text-sm font-semibold text-white truncate mb-0.5">
                                                {podcast.title}
                                            </h3>
                                            <p className="text-xs text-gray-400 truncate">
                                                {podcast.author}
                                            </p>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </section>
                )}

                {showGenreDiscoverySkeleton && (
                    <section>
                        <h2 className="text-xl font-bold text-white mb-6">
                            Loading Discovery
                        </h2>
                        <PodcastGridSkeleton count={5} />
                    </section>
                )}

                {/* Genre-based Discovery - Ordered by popularity */}
                {[
                    { id: "1303", name: "Comedy" },
                    { id: "1324", name: "Society & Culture" },
                    { id: "1489", name: "News" },
                    { id: "1488", name: "True Crime" },
                    { id: "1321", name: "Business" },
                    { id: "1545", name: "Sports" },
                    { id: "1502", name: "Leisure" },
                ].map(({ id: genreId, name: genreName }) => {
                    const genrePodcasts = relatedPodcasts[genreId] || [];

                    return genrePodcasts.length > 0 ? (
                        <section key={genreId}>
                            <div className="flex items-center justify-between mb-6">
                                <h2 className="text-xl font-bold text-white">
                                    {genreName}
                                </h2>
                                <button
                                    onClick={() =>
                                        router.push(
                                            `/podcasts/genre/${genreId}`
                                        )
                                    }
                                    className="text-sm font-semibold text-gray-400 hover:text-white transition-colors"
                                >
                                    View More
                                </button>
                            </div>
                            <div
                                className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-5 2xl:grid-cols-5 3xl:grid-cols-5 gap-4"
                                data-tv-section={`genre-${genreId}`}
                            >
                                {genrePodcasts.map((podcast, index) => {
                                    const imageUrl = getProxiedImageUrl(podcast.coverUrl);
                                    return (
                                        <div
                                            key={podcast.id}
                                            onClick={() =>
                                                router.push(
                                                    `/podcasts/${podcast.id}`
                                                )
                                            }
                                            data-tv-card
                                            data-tv-card-index={index}
                                            tabIndex={0}
                                            className="bg-transparent hover:bg-white/5 transition-all p-3 rounded-md cursor-pointer group"
                                        >
                                            <div className="w-full aspect-square bg-[#282828] rounded-full mb-2.5 overflow-hidden relative shadow-lg">
                                                {imageUrl ? (
                                                    <Image
                                                        src={imageUrl}
                                                        alt={podcast.title}
                                                        fill
                                                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 20vw"
                                                        className="object-cover group-hover:scale-105 transition-transform"
                                                        unoptimized
                                                    />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center">
                                                        <Mic2 className="w-16 h-16 text-gray-700" />
                                                    </div>
                                                )}
                                            </div>
                                            <h3 className="font-bold text-white truncate text-sm">
                                                {podcast.title}
                                            </h3>
                                            <p className="text-xs text-gray-400 truncate">
                                                {podcast.author}
                                            </p>
                                        </div>
                                    );
                                })}
                            </div>
                        </section>
                    ) : null;
                })}

                {/* Empty State */}
                {!isLoadingPodcasts &&
                    !isLoadingTopPodcasts &&
                    !showGenreDiscoverySkeleton &&
                    podcasts.length === 0 &&
                    topPodcasts.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-24">
                        <Mic2 className="w-24 h-24 text-gray-700 mb-6" />
                        <h2 className="text-2xl font-bold text-white mb-2">
                            Discover Podcasts
                        </h2>
                        <p className="text-gray-400 text-center max-w-md">
                            Search for podcasts above to subscribe and start
                            listening
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}

function PodcastGridSkeleton({ count = 10 }: { count?: number }) {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-5 2xl:grid-cols-5 3xl:grid-cols-5 gap-4">
            {Array.from({ length: count }, (_, index) => (
                <div
                    key={`podcast-skeleton-${index}`}
                    className="animate-pulse bg-transparent p-3 rounded-md"
                >
                    <div className="w-full aspect-square rounded-full bg-white/10 mb-2.5" />
                    <div className="h-4 rounded bg-white/10 mb-2" />
                    <div className="h-3 w-2/3 rounded bg-white/10" />
                </div>
            ))}
        </div>
    );
}
