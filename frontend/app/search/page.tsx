"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { SearchIcon } from "lucide-react";
import { useSearchData } from "@/features/search/hooks/useSearchData";
import { useSoulseekSearch } from "@/features/search/hooks/useSoulseekSearch";
import { SearchFilters } from "@/features/search/components/SearchFilters";
import { TopResult } from "@/features/search/components/TopResult";
import { EmptyState } from "@/features/search/components/EmptyState";
import { LibraryAlbumsGrid } from "@/features/search/components/LibraryAlbumsGrid";
import { LibraryPodcastsGrid } from "@/features/search/components/LibraryPodcastsGrid";
import { DiscoverPodcastsGrid } from "@/features/search/components/DiscoverPodcastsGrid";
import { LibraryAudiobooksGrid } from "@/features/search/components/LibraryAudiobooksGrid";
import { LibraryTracksList } from "@/features/search/components/LibraryTracksList";
import { SimilarArtistsGrid } from "@/features/search/components/SimilarArtistsGrid";
import { AliasResolutionBanner } from "@/features/search/components/AliasResolutionBanner";
import { SoulseekSongsList } from "@/features/search/components/SoulseekSongsList";
import { TVSearchInput } from "@/features/search/components/TVSearchInput";
import type { FilterTab } from "@/features/search/types";

type SearchSectionView = "tracks" | "albums" | "artists" | null;

export default function SearchPage() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const [filterTab, setFilterTab] = useState<FilterTab>("all");
    const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
    const isPodcastTab = filterTab === "podcasts";
    const viewParam = searchParams.get("view");
    const sectionView: SearchSectionView =
        viewParam === "tracks" || viewParam === "albums" || viewParam === "artists"
            ? viewParam
            : null;
    const isTracksView = !isPodcastTab && sectionView === "tracks";
    const isAlbumsView = !isPodcastTab && sectionView === "albums";
    const isArtistsView = !isPodcastTab && sectionView === "artists";
    const isSectionView = !isPodcastTab && sectionView !== null;
    const sectionViewLinks = {
        tracks: `/search?q=${encodeURIComponent(query)}&view=tracks`,
        albums: `/search?q=${encodeURIComponent(query)}&view=albums`,
        artists: `/search?q=${encodeURIComponent(query)}&view=artists`,
    };
    const librarySearchType = isPodcastTab ? "podcasts" : "all";
    const discoverSearchType = isPodcastTab ? "podcasts" : "all";

    // Custom hooks
    const {
        libraryResults,
        discoverResults,
        similarArtists,
        aliasInfo,
        isLibrarySearching,
        isDiscoverSearching,
        hasSearched,
    } = useSearchData({
        query,
        libraryType: librarySearchType,
        discoverType: discoverSearchType,
        libraryLimit: isTracksView || isAlbumsView ? 100 : 20,
        discoverLimit: 20,
        similarArtistsLimit: isArtistsView ? 50 : 6,
    });
    const {
        soulseekResults,
        isSoulseekSearching,
        isSoulseekPolling,
        soulseekEnabled,
        downloadingFiles,
        handleDownload,
    } = useSoulseekSearch({ query });

    // Sync query from URL params on navigation (render-time adjustment)
    const urlQuery = searchParams.get("q") ?? "";
    const [prevUrlQuery, setPrevUrlQuery] = useState(urlQuery);
    if (urlQuery !== prevUrlQuery) {
        setPrevUrlQuery(urlQuery);
        if (urlQuery) {
            setQuery(urlQuery);
        }
    }

    // Derived state
    const topArtist = discoverResults.find((r) => r.type === "music");
    const isLoading =
        isLibrarySearching ||
        isDiscoverSearching ||
        isSoulseekSearching ||
        isSoulseekPolling;
    const showLibrary = filterTab === "all" || filterTab === "library";
    const showDiscover = filterTab === "all" || filterTab === "discover";
    const showSoulseek = filterTab === "all" || filterTab === "soulseek";
    const showPodcastResults = filterTab === "all" || isPodcastTab;
    const discoverPodcastResults = discoverResults.filter(
        (result) => result.type === "podcast"
    );
    const hasPodcastResults =
        (libraryResults?.podcasts?.length || 0) > 0 ||
        discoverPodcastResults.length > 0;

    // Determine if we should show the 2-column layout
    const hasTopResult = libraryResults?.artists?.[0] || topArtist;
    const hasTracks =
        libraryResults?.tracks?.length > 0 || soulseekResults.length > 0;
    const show2ColumnLayout =
        hasSearched &&
        hasTopResult &&
        hasTracks &&
        (showLibrary || showDiscover) &&
        !isSectionView &&
        !isPodcastTab;

    // Handle TV search
    const handleTVSearch = (searchQuery: string) => {
        setQuery(searchQuery);
        router.push(`/search?q=${encodeURIComponent(searchQuery)}`);
    };

    return (
        <div className="min-h-screen px-6 py-6">
            {/* TV Search Input - only visible in TV mode */}
            <TVSearchInput initialQuery={query} onSearch={handleTVSearch} />

            <SearchFilters
                filterTab={filterTab}
                onFilterChange={setFilterTab}
                soulseekEnabled={soulseekEnabled}
                hasSearched={hasSearched}
            />

            {hasSearched && isSectionView && (
                <div className="mb-6">
                    <Link
                        href={`/search?q=${encodeURIComponent(query)}`}
                        className="text-sm font-semibold text-gray-300 hover:text-white hover:underline"
                    >
                        Back to All Results
                    </Link>
                </div>
            )}

            <div className="pb-24 space-y-12">
                {hasSearched && aliasInfo && (
                    <AliasResolutionBanner aliasInfo={aliasInfo} />
                )}

                <EmptyState hasSearched={hasSearched} isLoading={isLoading} />

                {/* Loading spinner */}
                {hasSearched &&
                    (isLibrarySearching ||
                        isDiscoverSearching ||
                        isSoulseekSearching) &&
                    (!libraryResults || !libraryResults.artists?.length) &&
                    discoverResults.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-16 relative z-10">
                            <div className="relative w-16 h-16 mb-4">
                                <svg
                                    className="w-16 h-16 animate-spin"
                                    viewBox="0 0 64 64"
                                >
                                    <defs>
                                        <linearGradient
                                            id="spinnerGrad"
                                            x1="0%"
                                            y1="0%"
                                            x2="100%"
                                            y2="100%"
                                        >
                                            <stop
                                                offset="0%"
                                                style={{
                                                    stopColor: "#facc15",
                                                    stopOpacity: 1,
                                                }}
                                            />
                                            <stop
                                                offset="25%"
                                                style={{
                                                    stopColor: "#f59e0b",
                                                    stopOpacity: 1,
                                                }}
                                            />
                                            <stop
                                                offset="50%"
                                                style={{
                                                    stopColor: "#c026d3",
                                                    stopOpacity: 1,
                                                }}
                                            />
                                            <stop
                                                offset="75%"
                                                style={{
                                                    stopColor: "#a855f7",
                                                    stopOpacity: 1,
                                                }}
                                            />
                                            <stop
                                                offset="100%"
                                                style={{
                                                    stopColor: "#facc15",
                                                    stopOpacity: 1,
                                                }}
                                            />
                                        </linearGradient>
                                    </defs>
                                    <circle
                                        cx="32"
                                        cy="32"
                                        r="28"
                                        fill="none"
                                        stroke="url(#spinnerGrad)"
                                        strokeWidth="4"
                                        strokeLinecap="round"
                                        strokeDasharray="140 40"
                                    />
                                </svg>
                            </div>
                            <p className="text-gray-400 text-sm">
                                {isSoulseekSearching || isSoulseekPolling
                                    ? `Searching... (${soulseekResults.length} found)`
                                    : "Searching..."}
                            </p>
                        </div>
                    )}

                {/* 2-Column Layout: Top Result (left) + Songs (right) */}
                {show2ColumnLayout ? (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        {/* Left Column: Top Result */}
                        <div>
                            <TopResult
                                libraryArtist={libraryResults?.artists?.[0]}
                                discoveryArtist={topArtist}
                            />
                        </div>

                        {/* Right Column: Songs */}
                        <div>
                            <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-3">
                                {showSoulseek && soulseekResults.length > 0
                                    ? "Songs"
                                    : showSoulseek && (isSoulseekSearching || isSoulseekPolling)
                                    ? <>
                                        <span>Songs</span>
                                        <span className="inline-flex items-center gap-2 text-sm font-normal text-gray-400">
                                            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24">
                                                <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="40 20" />
                                            </svg>
                                            Searching...
                                        </span>
                                      </>
                                    : (
                                        <Link
                                            href={sectionViewLinks.tracks}
                                            className="hover:underline"
                                        >
                                            Songs in Your Library
                                        </Link>
                                    )}
                            </h2>
                            {showSoulseek && soulseekResults.length > 0 ? (
                                <SoulseekSongsList
                                    soulseekResults={soulseekResults}
                                    downloadingFiles={downloadingFiles}
                                    onDownload={handleDownload}
                                />
                            ) : showSoulseek && (isSoulseekSearching || isSoulseekPolling) ? (
                                <div className="space-y-2">
                                    {[1, 2, 3].map((i) => (
                                        <div key={i} className="flex items-center gap-4 p-3 rounded-lg bg-white/5 animate-pulse">
                                            <div className="w-10 h-10 rounded bg-white/10" />
                                            <div className="flex-1 space-y-2">
                                                <div className="h-4 bg-white/10 rounded w-3/4" />
                                                <div className="h-3 bg-white/10 rounded w-1/2" />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : showLibrary &&
                              libraryResults?.tracks?.length > 0 ? (
                                <LibraryTracksList
                                    tracks={libraryResults.tracks}
                                    limit={isTracksView ? null : 10}
                                />
                            ) : null}
                        </div>
                    </div>
                ) : (
                    <>
                        {/* Original single-column layout when not showing 2-column */}
                        {hasSearched &&
                            (showDiscover || showLibrary) &&
                            hasTopResult &&
                            !isPodcastTab && (
                                <div>
                                    <TopResult
                                        libraryArtist={
                                            libraryResults?.artists?.[0]
                                        }
                                        discoveryArtist={topArtist}
                                    />
                                </div>
                            )}

                        {/* Soulseek Songs */}
                        {hasSearched &&
                            showSoulseek &&
                            soulseekResults.length > 0 && (
                                <section>
                                    <SoulseekSongsList
                                        soulseekResults={soulseekResults}
                                        downloadingFiles={downloadingFiles}
                                        onDownload={handleDownload}
                                    />
                                </section>
                            )}

                        {/* Soulseek Loading State */}
                        {hasSearched &&
                            showSoulseek &&
                            soulseekResults.length === 0 &&
                            (isSoulseekSearching || isSoulseekPolling) && (
                                <section>
                                    <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-3">
                                        <span>Soulseek</span>
                                        <span className="inline-flex items-center gap-2 text-sm font-normal text-gray-400">
                                            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24">
                                                <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="40 20" />
                                            </svg>
                                            Searching P2P network... (~45s)
                                        </span>
                                    </h2>
                                    <div className="space-y-2">
                                        {[1, 2, 3].map((i) => (
                                            <div key={i} className="flex items-center gap-4 p-3 rounded-lg bg-white/5 animate-pulse">
                                                <div className="w-10 h-10 rounded bg-white/10" />
                                                <div className="flex-1 space-y-2">
                                                    <div className="h-4 bg-white/10 rounded w-3/4" />
                                                    <div className="h-3 bg-white/10 rounded w-1/2" />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </section>
                            )}

                        {/* Library Songs */}
                        {hasSearched &&
                            showLibrary &&
                            !isPodcastTab &&
                            (sectionView === null || isTracksView) &&
                            libraryResults?.tracks?.length > 0 && (
                                <section>
                                    <h2 className="text-2xl font-bold text-white mb-6">
                                        <Link
                                            href={sectionViewLinks.tracks}
                                            className="hover:underline"
                                        >
                                            Songs in Your Library
                                        </Link>
                                    </h2>
                                    <LibraryTracksList
                                        tracks={libraryResults.tracks}
                                        limit={isTracksView ? null : 10}
                                    />
                                </section>
                            )}
                    </>
                )}

                {/* Library Albums */}
                {hasSearched &&
                    showLibrary &&
                    !isPodcastTab &&
                    (sectionView === null || isAlbumsView) &&
                    libraryResults?.albums?.length > 0 && (
                        <section>
                            <h2 className="text-2xl font-bold text-white mb-6">
                                <Link
                                    href={sectionViewLinks.albums}
                                    className="hover:underline"
                                >
                                    Your Albums
                                </Link>
                            </h2>
                            <LibraryAlbumsGrid
                                albums={libraryResults.albums}
                                limit={isAlbumsView ? null : 6}
                            />
                        </section>
                    )}

                {/* Library Podcasts */}
                {hasSearched &&
                    showPodcastResults &&
                    !isSectionView &&
                    libraryResults?.podcasts?.length > 0 && (
                        <section>
                            <h2 className="text-2xl font-bold text-white mb-6">
                                Podcasts in Your Library
                            </h2>
                            <LibraryPodcastsGrid
                                podcasts={libraryResults.podcasts}
                                limit={isPodcastTab ? null : 6}
                            />
                        </section>
                    )}

                {/* Discover Podcasts */}
                {hasSearched &&
                    showPodcastResults &&
                    !isSectionView &&
                    discoverPodcastResults.length > 0 && (
                        <section>
                            <h2 className="text-2xl font-bold text-white mb-6">
                                Discover Podcasts
                            </h2>
                            <DiscoverPodcastsGrid
                                podcasts={discoverPodcastResults}
                                limit={isPodcastTab ? null : 6}
                            />
                        </section>
                    )}

                {/* Library Audiobooks */}
                {hasSearched &&
                    showLibrary &&
                    !isPodcastTab &&
                    !isSectionView &&
                    libraryResults?.audiobooks &&
                    libraryResults.audiobooks.length > 0 && (
                        <section>
                            <h2 className="text-2xl font-bold text-white mb-6">
                                Audiobooks
                            </h2>
                            <LibraryAudiobooksGrid
                                audiobooks={libraryResults.audiobooks}
                            />
                        </section>
                    )}

                {/* Related Artists */}
                {hasSearched &&
                    showDiscover &&
                    !isPodcastTab &&
                    (sectionView === null || isArtistsView) &&
                    similarArtists.length > 0 && (
                        <SimilarArtistsGrid
                            similarArtists={similarArtists}
                            titleHref={sectionViewLinks.artists}
                        />
                    )}

                {/* No Results */}
                {hasSearched &&
                    !isLoading &&
                    (isPodcastTab
                        ? !hasPodcastResults
                        : !topArtist &&
                          discoverPodcastResults.length === 0 &&
                          soulseekResults.length === 0 &&
                          (!libraryResults ||
                              (!libraryResults.artists?.length &&
                                  !libraryResults.albums?.length &&
                                  !libraryResults.tracks?.length &&
                                  !libraryResults.podcasts?.length &&
                                  !libraryResults.audiobooks?.length &&
                                  !libraryResults.episodes?.length))) && (
                        <div className="flex flex-col items-center justify-center py-24 text-center">
                            <SearchIcon className="w-16 h-16 text-gray-700 mb-4" />
                            <h3 className="text-xl font-bold text-white mb-2">
                                {isPodcastTab ? "No podcasts found" : "No results found"}
                            </h3>
                            <p className="text-gray-400">
                                {isPodcastTab
                                    ? "Try searching by podcast title or creator"
                                    : "Try searching for something else"}
                            </p>
                        </div>
                    )}
            </div>
        </div>
    );
}
