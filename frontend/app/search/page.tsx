"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SectionHeader } from "@/components/layout/SectionHeader";
import { useSearchParams, useRouter } from "next/navigation";
import { SearchIcon } from "lucide-react";
import { useSearchData } from "@/features/search/hooks/useSearchData";
import { dedupeDiscoverTracks } from "@/features/search/songDedup";
import { useSoulseekSearch } from "@/features/search/hooks/useSoulseekSearch";
import { useYouTubeUrl } from "@/features/search/hooks/useYouTubeUrl";
import { YouTubePreviewCard } from "@/features/search/components/YouTubePreviewCard";
import { useYouTubePlaylist } from "@/features/search/hooks/useYouTubePlaylist";
import { YouTubePlaylistPreviewCard } from "@/features/search/components/YouTubePlaylistPreviewCard";
import { SearchFilters } from "@/features/search/components/SearchFilters";
import { TopResult } from "@/features/search/components/TopResult";
import { EmptyState } from "@/features/search/components/EmptyState";
import { LibraryAlbumsGrid } from "@/features/search/components/LibraryAlbumsGrid";
import { LibraryPodcastsGrid } from "@/features/search/components/LibraryPodcastsGrid";
import { DiscoverPodcastsGrid } from "@/features/search/components/DiscoverPodcastsGrid";
import { LibraryAudiobooksGrid } from "@/features/search/components/LibraryAudiobooksGrid";
import { LibraryTracksList } from "@/features/search/components/LibraryTracksList";
import { SimilarArtistsGrid } from "@/features/search/components/SimilarArtistsGrid";
import { DiscoverTracksList } from "@/features/search/components/DiscoverTracksList";
import {
    deriveDiscoverySelection,
    normalizeArtistName,
} from "@/features/search/discoverySelection";
import { AliasResolutionBanner } from "@/features/search/components/AliasResolutionBanner";
import { SoulseekSongsList } from "@/features/search/components/SoulseekSongsList";
import { TVSearchInput } from "@/features/search/components/TVSearchInput";
import { useAuth } from "@/lib/auth-context";
import type { FilterTab } from "@/features/search/types";
import { useFeatures } from "@/lib/features-context";

type SearchSectionView = "tracks" | "albums" | "artists" | null;

/**
 * Renders the SearchPage component.
 */
export default function SearchPage() {
    const searchParams = useSearchParams();
    const router = useRouter();
    // Downloads are admin-only app-wide (mirrors lib/download-context.tsx and
    // the backend's requireAdmin gate on /api/youtube download endpoints).
    const { user } = useAuth();
    const { federation } = useFeatures();
    const canDownloadYouTube = user?.role === "admin";
    const [filterTab, setFilterTab] = useState<FilterTab>("all");
    const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
    const isPodcastTab = filterTab === "podcasts";
    const viewParam = searchParams.get("view");
    const sectionView: SearchSectionView =
        viewParam === "tracks" ||
        viewParam === "albums" ||
        viewParam === "artists"
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
        source: filterTab === "peers" ? "peers" : "all",
    });
    const {
        soulseekResults,
        isSoulseekSearching,
        isSoulseekPolling,
        soulseekEnabled,
        downloadingFiles,
        handleDownload,
    } = useSoulseekSearch({ query });
    const {
        videoInfo,
        isLoading: isYtLoading,
        isDownloading,
        downloadProgress,
        handlePlay: handleYtPlay,
        handleDownload: handleYtDownload,
    } = useYouTubeUrl({ query });

    const {
        playlistInfo: ytPlaylistInfo,
        isLoading: isYtPlaylistLoading,
        error: ytPlaylistError,
        isDownloading: isYtPlaylistDownloading,
        progress: ytPlaylistProgress,
        handleDownloadAll: handleYtDownloadAll,
        handleCancel: handleYtPlaylistCancel,
    } = useYouTubePlaylist({ query });

    // Sync query from URL params on navigation.
    const urlQuery = searchParams.get("q") ?? "";
    useEffect(() => {
        if (urlQuery) {
            setQuery(urlQuery);
        }
    }, [urlQuery]);

    // Derived state
    const showLibrary =
        filterTab === "all" || filterTab === "library" || filterTab === "peers";
    const showDiscover = filterTab === "all" || filterTab === "discover";
    const showSoulseek = filterTab === "all" || filterTab === "soulseek";
    // Only offer the library artist as a top result when the active
    // filter shows library sources at all.
    const visibleLibraryTopArtist = showLibrary
        ? libraryResults?.artists?.[0]
        : undefined;
    // An exact-name external match beats a fuzzy library match, so
    // searching "Drake" surfaces Drake rather than an owned "Nick Drake".
    const {
        topArtist,
        preferDiscovery: preferDiscoveryTopResult,
        secondaryArtists: secondaryDiscoverArtists,
        tracks: discoverTracks,
    } = deriveDiscoverySelection({
        discoverResults,
        query,
        aliasCanonical: aliasInfo?.canonical,
        libraryTopName: visibleLibraryTopArtist?.name ?? null,
        showDiscover,
    });
    // Related Artists should never repeat the artist shown as top result.
    const visibleSimilarArtists = topArtist
        ? similarArtists.filter(
              (candidate) =>
                  normalizeArtistName(candidate.name) !==
                      normalizeArtistName(topArtist.name) &&
                  (!candidate.mbid || candidate.mbid !== topArtist.mbid),
          )
        : similarArtists;
    const isLoading =
        isLibrarySearching ||
        isDiscoverSearching ||
        isSoulseekSearching ||
        isSoulseekPolling;
    const showPodcastResults = filterTab === "all" || isPodcastTab;
    const discoverPodcastResults = discoverResults.filter(
        (result) => result.type === "podcast",
    );
    const libraryTracks = libraryResults?.tracks ?? [];
    const libraryAlbums = libraryResults?.albums ?? [];
    const libraryPodcasts = libraryResults?.podcasts ?? [];
    const hasPodcastResults =
        libraryPodcasts.length > 0 || discoverPodcastResults.length > 0;
    // One Songs section: external matches continue the owned list, minus
    // songs the library results already cover.
    const unownedDiscoverTracks = showDiscover
        ? dedupeDiscoverTracks(discoverTracks, libraryTracks)
        : [];

    // Determine if we should show the 2-column layout
    const hasTopResult = visibleLibraryTopArtist || topArtist;
    const hasTracks =
        libraryTracks.length > 0 ||
        soulseekResults.length > 0 ||
        unownedDiscoverTracks.length > 0;
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
                federationEnabled={federation}
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

                {/* YouTube single-video URL Preview Card */}
                {(videoInfo || isYtLoading) && (
                    <YouTubePreviewCard
                        videoInfo={videoInfo!}
                        isLoading={isYtLoading}
                        isDownloading={isDownloading}
                        downloadProgress={downloadProgress}
                        canDownload={canDownloadYouTube}
                        onPlay={handleYtPlay}
                        onDownload={handleYtDownload}
                    />
                )}

                {/* YouTube playlist/channel bulk-download Preview Card */}
                {(ytPlaylistInfo || isYtPlaylistLoading || ytPlaylistError) && (
                    <YouTubePlaylistPreviewCard
                        playlistInfo={ytPlaylistInfo}
                        isLoading={isYtPlaylistLoading}
                        error={ytPlaylistError}
                        isDownloading={isYtPlaylistDownloading}
                        progress={ytPlaylistProgress}
                        canDownload={canDownloadYouTube}
                        onDownloadAll={handleYtDownloadAll}
                        onCancel={handleYtPlaylistCancel}
                    />
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
                                                    stopColor: "#2323FF",
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
                                libraryArtist={visibleLibraryTopArtist}
                                discoveryArtist={topArtist}
                                preferDiscovery={preferDiscoveryTopResult}
                            />
                        </div>

                        {/* Right Column: Songs */}
                        <div>
                            <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-3">
                                {showSoulseek && soulseekResults.length > 0 ? (
                                    "Songs"
                                ) : showSoulseek &&
                                  (isSoulseekSearching || isSoulseekPolling) ? (
                                    <>
                                        <span>Songs</span>
                                        <span className="inline-flex items-center gap-2 text-sm font-normal text-gray-400">
                                            <svg
                                                className="w-4 h-4 animate-spin"
                                                viewBox="0 0 24 24"
                                            >
                                                <circle
                                                    cx="12"
                                                    cy="12"
                                                    r="10"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="2"
                                                    strokeDasharray="40 20"
                                                />
                                            </svg>
                                            Searching...
                                        </span>
                                    </>
                                ) : (
                                    <Link
                                        href={sectionViewLinks.tracks}
                                        className="hover:underline"
                                    >
                                        Songs
                                    </Link>
                                )}
                            </h2>
                            {showSoulseek && soulseekResults.length > 0 ? (
                                <SoulseekSongsList
                                    soulseekResults={soulseekResults}
                                    downloadingFiles={downloadingFiles}
                                    onDownload={handleDownload}
                                />
                            ) : showSoulseek &&
                              (isSoulseekSearching || isSoulseekPolling) ? (
                                <div className="space-y-2">
                                    {[1, 2, 3].map((i) => (
                                        <div
                                            key={i}
                                            className="flex items-center gap-4 p-3 rounded-lg bg-white/5 animate-pulse"
                                        >
                                            <div className="w-10 h-10 rounded bg-white/10" />
                                            <div className="flex-1 space-y-2">
                                                <div className="h-4 bg-white/10 rounded w-3/4" />
                                                <div className="h-3 bg-white/10 rounded w-1/2" />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <>
                                    {showLibrary &&
                                        libraryTracks.length > 0 && (
                                            <LibraryTracksList
                                                tracks={libraryTracks}
                                                limit={isTracksView ? null : 10}
                                            />
                                        )}
                                    {unownedDiscoverTracks.length > 0 && (
                                        <DiscoverTracksList
                                            tracks={unownedDiscoverTracks}
                                            limit={5}
                                        />
                                    )}
                                </>
                            )}
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
                                        libraryArtist={visibleLibraryTopArtist}
                                        discoveryArtist={topArtist}
                                        preferDiscovery={
                                            preferDiscoveryTopResult
                                        }
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
                                            <svg
                                                className="w-4 h-4 animate-spin"
                                                viewBox="0 0 24 24"
                                            >
                                                <circle
                                                    cx="12"
                                                    cy="12"
                                                    r="10"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="2"
                                                    strokeDasharray="40 20"
                                                />
                                            </svg>
                                            Searching P2P network... (~45s)
                                        </span>
                                    </h2>
                                    <div className="space-y-2">
                                        {[1, 2, 3].map((i) => (
                                            <div
                                                key={i}
                                                className="flex items-center gap-4 p-3 rounded-lg bg-white/5 animate-pulse"
                                            >
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

                        {/* Songs — owned results with unowned continuation */}
                        {hasSearched &&
                            !isPodcastTab &&
                            (sectionView === null || isTracksView) &&
                            ((showLibrary && libraryTracks.length > 0) ||
                                unownedDiscoverTracks.length > 0) && (
                                <section>
                                    <SectionHeader
                                        title={
                                            <Link
                                                href={sectionViewLinks.tracks}
                                                className="hover:underline"
                                            >
                                                Songs
                                            </Link>
                                        }
                                    />
                                    {showLibrary &&
                                        libraryTracks.length > 0 && (
                                            <LibraryTracksList
                                                tracks={libraryTracks}
                                                limit={isTracksView ? null : 10}
                                            />
                                        )}
                                    {unownedDiscoverTracks.length > 0 && (
                                        <DiscoverTracksList
                                            tracks={unownedDiscoverTracks}
                                            limit={isTracksView ? null : 5}
                                        />
                                    )}
                                </section>
                            )}
                    </>
                )}

                {/* Library Albums */}
                {hasSearched &&
                    showLibrary &&
                    !isPodcastTab &&
                    (sectionView === null || isAlbumsView) &&
                    libraryAlbums.length > 0 && (
                        <section>
                            <SectionHeader
                                title={
                                    <Link
                                        href={sectionViewLinks.albums}
                                        className="hover:underline"
                                    >
                                        Your Albums
                                    </Link>
                                }
                            />
                            <LibraryAlbumsGrid
                                albums={libraryAlbums}
                                limit={isAlbumsView ? null : 6}
                            />
                        </section>
                    )}

                {/* Library Podcasts */}
                {hasSearched &&
                    showPodcastResults &&
                    !isSectionView &&
                    libraryPodcasts.length > 0 && (
                        <section>
                            <SectionHeader title="Podcasts in Your Library" />
                            <LibraryPodcastsGrid
                                podcasts={libraryPodcasts}
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
                            <SectionHeader title="Discover Podcasts" />
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
                            <SectionHeader title="Audiobooks" />
                            <LibraryAudiobooksGrid
                                audiobooks={libraryResults.audiobooks}
                            />
                        </section>
                    )}

                {/* Discover Artists — external matches beyond the top result */}
                {hasSearched &&
                    showDiscover &&
                    !isPodcastTab &&
                    (sectionView === null || isArtistsView) &&
                    secondaryDiscoverArtists.length > 0 && (
                        <SimilarArtistsGrid
                            similarArtists={secondaryDiscoverArtists}
                            title="Artists"
                        />
                    )}

                {/* Songs to Discover merged into the unified Songs section
                    above; external rows continue the owned list with badges
                    instead of living four sections away. */}

                {/* Related Artists */}
                {hasSearched &&
                    showDiscover &&
                    !isPodcastTab &&
                    (sectionView === null || isArtistsView) &&
                    visibleSimilarArtists.length > 0 && (
                        <SimilarArtistsGrid
                            similarArtists={visibleSimilarArtists}
                            titleHref={sectionViewLinks.artists}
                        />
                    )}

                {/* No Results */}
                {hasSearched &&
                    !isLoading &&
                    (isPodcastTab
                        ? !hasPodcastResults
                        : !topArtist &&
                          secondaryDiscoverArtists.length === 0 &&
                          discoverTracks.length === 0 &&
                          (!showPodcastResults ||
                              discoverPodcastResults.length === 0) &&
                          (!showSoulseek || soulseekResults.length === 0) &&
                          (!showLibrary ||
                              !libraryResults ||
                              (!libraryResults.artists?.length &&
                                  !libraryResults.albums?.length &&
                                  !libraryResults.tracks?.length &&
                                  !libraryResults.audiobooks?.length &&
                                  // Library podcasts render only on the All
                                  // and Podcasts tabs; episodes only under
                                  // the podcast tab handled above.
                                  (!showPodcastResults ||
                                      !libraryResults.podcasts?.length)))) && (
                        <div className="flex flex-col items-center justify-center py-24 text-center">
                            <SearchIcon className="w-16 h-16 text-gray-400 mb-4" />
                            <h3 className="text-xl font-bold text-white mb-2">
                                {isPodcastTab
                                    ? "No podcasts found"
                                    : "No results found"}
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
