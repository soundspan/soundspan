"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
    Loader2,
    Music2,
    Link2,
    X,
    ChevronRight,
    Globe,
    TrendingUp,
    Sparkles,
    Lock,
    CheckCircle2,
    ArrowRight,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { PageHeader } from "@/components/layout/PageHeader";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { useAuth } from "@/lib/auth-context";

// ── Types ──────────────────────────────────────────────────────

interface YtMusicChartItem {
    videoId?: string;
    playlistId?: string;
    title?: string;
    artist?: string;
    artists?: Array<string | { name?: string }>;
    thumbnailUrl?: string | null;
    thumbnails?: Array<{ url?: string }>;
    album?: string;
}

interface YtMusicCategory {
    title: string;
    items: Array<{ title: string; params: string }>;
}

type BrowseProvider = "ytmusic" | "tidal";
type BrowseTab = "charts" | "categories";

// Loading skeleton for cards
const CardSkeleton = () => (
    <div className="animate-pulse">
        <div className="aspect-square rounded-md bg-white/10 mb-3" />
        <div className="h-4 w-3/4 bg-white/10 rounded mb-2" />
        <div className="h-3 w-1/2 bg-white/5 rounded" />
    </div>
);

// Deezer icon component (kept for URL import modal)
const DeezerIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M18.81 4.16v3.03H24V4.16h-5.19zM6.27 8.38v3.027h5.189V8.38h-5.19zm12.54 0v3.027H24V8.38h-5.19zM6.27 12.595v3.027h5.189v-3.027h-5.19zm6.27 0v3.027h5.19v-3.027h-5.19zm6.27 0v3.027H24v-3.027h-5.19zM0 16.81v3.029h5.19v-3.03H0zm6.27 0v3.029h5.189v-3.03h-5.19zm6.27 0v3.029h5.19v-3.03h-5.19zm6.27 0v3.029H24v-3.03h-5.19z" />
    </svg>
);

const PLAYLIST_ID_REGEX = /(?:^|[^A-Za-z0-9_-])VL([A-Za-z0-9_-]{8,})/;

function resolveChartArtist(item: YtMusicChartItem): string {
    if (typeof item.artist === "string" && item.artist.trim()) {
        return item.artist.trim();
    }

    if (Array.isArray(item.artists)) {
        for (const artist of item.artists) {
            if (typeof artist === "string" && artist.trim()) {
                return artist.trim();
            }

            if (
                artist &&
                typeof artist === "object" &&
                typeof artist.name === "string" &&
                artist.name.trim()
            ) {
                return artist.name.trim();
            }
        }
    }

    return "YouTube Music";
}

function resolveChartThumbnail(item: YtMusicChartItem): string | null {
    if (typeof item.thumbnailUrl === "string" && item.thumbnailUrl.trim()) {
        return item.thumbnailUrl;
    }

    if (Array.isArray(item.thumbnails)) {
        for (const thumb of item.thumbnails) {
            if (typeof thumb?.url === "string" && thumb.url.trim()) {
                return thumb.url;
            }
        }
    }

    return null;
}

function resolveChartRouteId(item: YtMusicChartItem): string | null {
    if (typeof item.playlistId === "string" && item.playlistId.trim()) {
        return item.playlistId.trim();
    }

    if (typeof item.videoId === "string" && item.videoId.trim()) {
        return item.videoId.trim();
    }

    return null;
}

function resolveCategoryRouteId(params: string): string | null {
    const trimmed = params.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith("VL") && trimmed.length > 2) {
        return trimmed.slice(2);
    }

    const playlistMatch = trimmed.match(PLAYLIST_ID_REGEX);
    if (playlistMatch?.[1]) {
        return playlistMatch[1];
    }

    return null;
}

interface TidalBrowseSignals {
    authLoading: boolean;
    isAuthenticated: boolean;
    statusResolved: boolean;
    enabled: boolean;
    available: boolean;
    authenticated: boolean;
}

export interface TidalBrowseAccessState {
    state: "checking" | "connected" | "disconnected";
    canBrowse: boolean;
    statusLabel: string;
    ctaLabel: string;
    ctaHref: string;
    message: string;
}

export interface BrowseProviderTabDescriptor {
    provider: BrowseProvider;
    label: string;
    statusLabel?: string;
    locked: boolean;
}

interface TidalSpotlight {
    title: string;
    subtitle: string;
    query: string;
}

const TIDAL_SPOTLIGHTS: TidalSpotlight[] = [
    {
        title: "Rising Tracks",
        subtitle: "Fresh releases and viral momentum",
        query: "TIDAL rising tracks",
    },
    {
        title: "Global Pop",
        subtitle: "Big hooks from around the world",
        query: "TIDAL global pop",
    },
    {
        title: "Rap Rotation",
        subtitle: "Current rap and hip-hop standouts",
        query: "TIDAL rap rotation",
    },
    {
        title: "Electronic Energy",
        subtitle: "Peak-hour electronic picks",
        query: "TIDAL electronic essentials",
    },
    {
        title: "Focus Mode",
        subtitle: "Low-distraction listening sessions",
        query: "TIDAL focus instrumental",
    },
    {
        title: "Late Night",
        subtitle: "Smooth R&B and after-hours picks",
        query: "TIDAL late night r&b",
    },
];

export function resolveTidalBrowseAccessState(
    signals: TidalBrowseSignals
): TidalBrowseAccessState {
    if (signals.authLoading) {
        return {
            state: "checking",
            canBrowse: false,
            statusLabel: "Checking...",
            ctaLabel: "Checking...",
            ctaHref: "/settings#integrations",
            message: "Checking your TIDAL connection status...",
        };
    }

    if (!signals.isAuthenticated) {
        return {
            state: "disconnected",
            canBrowse: false,
            statusLabel: "Sign in",
            ctaLabel: "Sign In",
            ctaHref: "/login",
            message: "Sign in to connect and browse TIDAL content.",
        };
    }

    if (!signals.statusResolved) {
        return {
            state: "checking",
            canBrowse: false,
            statusLabel: "Checking...",
            ctaLabel: "Checking...",
            ctaHref: "/settings#integrations",
            message: "Checking your TIDAL connection status...",
        };
    }

    const connected =
        signals.enabled && signals.available && signals.authenticated;

    if (connected) {
        return {
            state: "connected",
            canBrowse: true,
            statusLabel: "Connected",
            ctaLabel: "Browse",
            ctaHref: "/browse/playlists",
            message: "Your TIDAL account is connected.",
        };
    }

    if (!signals.enabled) {
        return {
            state: "disconnected",
            canBrowse: false,
            statusLabel: "Unavailable",
            ctaLabel: "Open Integrations",
            ctaHref: "/settings#integrations",
            message:
                "TIDAL integration is disabled. Ask your admin to enable it in Settings.",
        };
    }

    if (!signals.available) {
        return {
            state: "disconnected",
            canBrowse: false,
            statusLabel: "Offline",
            ctaLabel: "Open Integrations",
            ctaHref: "/settings#integrations",
            message:
                "TIDAL service is currently unavailable. Check your connection and try again.",
        };
    }

    return {
        state: "disconnected",
        canBrowse: false,
        statusLabel: "Connect",
        ctaLabel: "Connect TIDAL",
        ctaHref: "/settings#integrations",
        message:
            "Connect your TIDAL account in Settings to unlock the TIDAL browse tab.",
    };
}

export function getBrowseProviderTabs(
    tidalState: TidalBrowseAccessState
): BrowseProviderTabDescriptor[] {
    return [
        {
            provider: "ytmusic",
            label: "YouTube Music",
            locked: false,
        },
        {
            provider: "tidal",
            label: "TIDAL",
            statusLabel: tidalState.statusLabel,
            locked: !tidalState.canBrowse,
        },
    ];
}

export default function BrowsePlaylistsPage() {
    const router = useRouter();
    const { toast } = useToast();
    const { isAuthenticated, isLoading: authLoading } = useAuth();

    // UI State
    const [activeProvider, setActiveProvider] =
        useState<BrowseProvider>("ytmusic");
    const [activeTab, setActiveTab] = useState<BrowseTab>("charts");
    const [isLoading, setIsLoading] = useState(true);
    const [showUrlModal, setShowUrlModal] = useState(false);
    const [urlInput, setUrlInput] = useState("");
    const [isParsing, setIsParsing] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    // Data State
    const [charts, setCharts] = useState<Record<string, YtMusicChartItem[]>>({});
    const [categories, setCategories] = useState<YtMusicCategory[]>([]);
    const [tidalStatus, setTidalStatus] = useState<{
        statusResolved: boolean;
        enabled: boolean;
        available: boolean;
        authenticated: boolean;
    }>({
        statusResolved: false,
        enabled: false,
        available: false,
        authenticated: false,
    });
    const { showSpinner, triggerPlayFeedback } = usePlayButtonFeedback();
    const [playFeedbackCardKey, setPlayFeedbackCardKey] = useState<string | null>(null);

    const navigateToPlaylist = useCallback(
        (id: string) => {
            router.push(`/browse/playlists/${encodeURIComponent(id)}`);
        },
        [router]
    );

    const navigateToSearch = useCallback(
        (query: string) => {
            const normalized = query.trim();
            if (!normalized) return;
            router.push(`/search?q=${encodeURIComponent(normalized)}`);
        },
        [router]
    );

    // Fetch charts on mount
    const fetchCharts = useCallback(async () => {
        setIsLoading(true);
        setLoadError(null);
        try {
            const response = await api.get<{
                charts: Record<string, YtMusicChartItem[]>;
                country: string;
                source: string;
            }>("/browse/ytmusic/charts");
            setCharts(response.charts);
        } catch (error: unknown) {
            sharedFrontendLogger.error("Failed to fetch charts:", error);
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            if (errorMessage.includes("not enabled")) {
                setLoadError("YouTube Music integration is not enabled. Ask your admin to enable it in Settings.");
            } else {
                setLoadError("Couldn't load charts. Check your connection and try again.");
            }
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Fetch categories (lazy, on tab switch)
    const fetchCategories = useCallback(async () => {
        if (categories.length > 0) return; // already loaded
        setIsLoading(true);
        setLoadError(null);
        try {
            const response = await api.get<{
                categories: YtMusicCategory[];
                source: string;
            }>("/browse/ytmusic/categories");
            setCategories(response.categories);
        } catch (error: unknown) {
            sharedFrontendLogger.error("Failed to fetch categories:", error);
            setLoadError("Couldn't load categories. Check your connection and try again.");
        } finally {
            setIsLoading(false);
        }
    }, [categories.length]);

    useEffect(() => {
        fetchCharts();
    }, [fetchCharts]);

    useEffect(() => {
        if (activeProvider === "ytmusic" && activeTab === "categories") {
            fetchCategories();
        }
    }, [activeProvider, activeTab, fetchCategories]);

    useEffect(() => {
        let isActive = true;

        if (authLoading) {
            return () => {
                isActive = false;
            };
        }

        if (!isAuthenticated) {
            setTidalStatus({
                statusResolved: true,
                enabled: false,
                available: false,
                authenticated: false,
            });
            return () => {
                isActive = false;
            };
        }

        const checkTidalStatus = async () => {
            try {
                const status = await api.getTidalStreamingStatus();
                if (!isActive) return;
                setTidalStatus({
                    statusResolved: true,
                    enabled: !!status.enabled,
                    available: !!status.available,
                    authenticated: !!status.authenticated,
                });
            } catch {
                if (!isActive) return;
                setTidalStatus({
                    statusResolved: true,
                    enabled: false,
                    available: false,
                    authenticated: false,
                });
            }
        };

        checkTidalStatus();

        return () => {
            isActive = false;
        };
    }, [authLoading, isAuthenticated]);

    useEffect(() => {
        if (!showSpinner) {
            setPlayFeedbackCardKey(null);
        }
    }, [showSpinner]);

    const tidalBrowseState = resolveTidalBrowseAccessState({
        authLoading,
        isAuthenticated,
        statusResolved: tidalStatus.statusResolved,
        enabled: tidalStatus.enabled,
        available: tidalStatus.available,
        authenticated: tidalStatus.authenticated,
    });
    const providerTabs = getBrowseProviderTabs(tidalBrowseState);

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

    // Render chart song card
    const renderChartCard = (
        item: YtMusicChartItem,
        index: number,
        section: string,
    ) => {
        const cardKey = `chart-${section}-${item.videoId || index}`;
        const showCardSpinner = showSpinner && playFeedbackCardKey === cardKey;
        const thumbnailUrl = resolveChartThumbnail(item);
        const title = item.title?.trim() || "Untitled";
        const artist = resolveChartArtist(item);
        const routeId = resolveChartRouteId(item);

        return (
            <button
                type="button"
                key={cardKey}
                className="group cursor-pointer text-left"
                onClick={() => {
                    if (!routeId) {
                        navigateToSearch(`${title} ${artist}`);
                        return;
                    }

                    setPlayFeedbackCardKey(cardKey);
                    triggerPlayFeedback();
                    navigateToPlaylist(routeId);
                }}
            >
                <div className="relative aspect-square mb-3 rounded-md overflow-hidden bg-[#282828] shadow-lg">
                    {thumbnailUrl ? (
                        <Image
                            src={thumbnailUrl}
                            alt={title}
                            fill
                            sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, (max-width: 1280px) 20vw, (max-width: 1536px) 16vw, 14vw"
                            className="object-cover group-hover:scale-105 transition-transform duration-300"
                            unoptimized
                        />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-red-500/30 to-red-500/10">
                            <Music2 className="w-12 h-12 text-gray-600" />
                        </div>
                    )}
                    {/* Rank badge */}
                    <div className="absolute top-2 left-2 w-7 h-7 rounded-full bg-black/70 flex items-center justify-center">
                        <span className="text-xs font-bold text-white">{index + 1}</span>
                    </div>
                    <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all duration-200">
                        <div className="w-10 h-10 rounded-full bg-[#60a5fa] flex items-center justify-center shadow-xl">
                            {showCardSpinner ? (
                                <Loader2 className="w-4 h-4 text-black animate-spin" />
                            ) : (
                                <ChevronRight className="w-4 h-4 text-black" />
                            )}
                        </div>
                    </div>
                </div>
                <h3 className="text-sm font-semibold text-white truncate mb-1">
                    {title}
                </h3>
                <p className="text-xs text-gray-400 truncate">
                    {artist}
                    {item.album ? ` • ${item.album}` : ""}
                </p>
            </button>
        );
    };

    // Render category card
    const renderCategoryCard = (category: YtMusicCategory) => {
        // Generate a gradient from category title hash
        const hash = category.title.split("").reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0);
        const hue = Math.abs(hash) % 360;

        return (
            <div
                key={category.title}
                className="group cursor-pointer"
                onClick={() => navigateToSearch(category.title)}
            >
                <div
                    className="relative aspect-[4/3] rounded-lg overflow-hidden group-hover:scale-[1.02] transition-transform duration-200"
                    style={{
                        background: `linear-gradient(135deg, hsl(${hue}, 60%, 35%), hsl(${(hue + 40) % 360}, 50%, 25%))`,
                    }}
                >
                    <div className="absolute inset-0 bg-black/20 group-hover:bg-black/10 transition-colors" />
                    <div className="absolute bottom-3 left-3 right-3">
                        <h3 className="text-base font-bold text-white leading-tight">{category.title}</h3>
                        <p className="text-xs text-white/60 mt-0.5">
                            {category.items.length} playlist{category.items.length !== 1 ? "s" : ""}
                        </p>
                    </div>
                </div>
                {/* Sub-items */}
                {category.items.length > 0 && (
                    <div className="mt-2 space-y-1">
                        {category.items.slice(0, 4).map((item) => (
                            <button
                                key={item.params}
                                className="w-full text-left px-2 py-1.5 rounded text-xs text-gray-400 hover:text-white hover:bg-white/5 transition-colors truncate"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    const routeId = resolveCategoryRouteId(item.params);
                                    if (routeId) {
                                        navigateToPlaylist(routeId);
                                        return;
                                    }
                                    navigateToSearch(item.title);
                                }}
                            >
                                {item.title}
                            </button>
                        ))}
                        {category.items.length > 4 && (
                            <p className="text-[10px] text-gray-600 px-2">
                                +{category.items.length - 4} more
                            </p>
                        )}
                    </div>
                )}
            </div>
        );
    };

    const renderTidalSpotlightCard = (spotlight: TidalSpotlight) => {
        const hash = spotlight.title
            .split("")
            .reduce((acc, char) => ((acc << 5) - acc + char.charCodeAt(0)) | 0, 0);
        const hue = Math.abs(hash) % 360;

        return (
            <button
                key={spotlight.title}
                type="button"
                className="group text-left"
                onClick={() => navigateToSearch(spotlight.query)}
            >
                <div
                    className="relative aspect-[4/3] rounded-lg overflow-hidden shadow-lg group-hover:scale-[1.02] transition-transform duration-200"
                    style={{
                        background: `linear-gradient(135deg, hsl(${hue}, 72%, 32%), hsl(${(hue + 44) % 360}, 68%, 24%))`,
                    }}
                >
                    <div className="absolute inset-0 bg-black/25 group-hover:bg-black/15 transition-colors" />
                    <div className="absolute inset-0 p-4 flex flex-col justify-between">
                        <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/85">
                            <CheckCircle2 className="w-3.5 h-3.5 text-cyan-300" />
                            <span>TIDAL</span>
                        </div>
                        <div>
                            <h3 className="text-lg font-bold text-white leading-tight">
                                {spotlight.title}
                            </h3>
                            <p className="mt-1 text-xs text-white/75">
                                {spotlight.subtitle}
                            </p>
                        </div>
                    </div>
                </div>
            </button>
        );
    };

    // Chart section titles
    const sectionLabels: Record<string, { label: string; icon: typeof TrendingUp }> = {
        songs: { label: "Top Songs", icon: TrendingUp },
        videos: { label: "Top Music Videos", icon: Sparkles },
        trending: { label: "Trending", icon: TrendingUp },
        artists: { label: "Top Artists", icon: Music2 },
    };

    return (
        <div className="min-h-screen relative">
            {/* Gradient */}
            <div className="absolute inset-0 pointer-events-none">
                <div
                    className="absolute inset-0 bg-gradient-to-b from-red-600/12 via-red-900/8 to-transparent"
                    style={{ height: "35vh" }}
                />
                <div
                    className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--tw-gradient-stops))] from-red-500/6 via-transparent to-transparent"
                    style={{ height: "25vh" }}
                />
            </div>

            <div className="relative px-4 md:px-8 py-6">
                {/* Header */}
                <PageHeader
                    title="Browse"
                    subtitle={
                        activeProvider === "ytmusic"
                            ? "Discover music from YouTube Music"
                            : "Quick-start TIDAL browsing from your connected account"
                    }
                    icon={Globe}
                    iconClassName={
                        activeProvider === "ytmusic"
                            ? "text-red-500"
                            : "text-cyan-400"
                    }
                    className="mb-6"
                />

                {/* Search / Import URL bar */}
                <div className="flex items-center gap-3 mb-6">
                    <div className="flex-1" />
                    <button
                        onClick={() => setShowUrlModal(true)}
                        className="flex items-center gap-2 px-4 py-3 rounded-full bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors"
                    >
                        <Link2 className="w-4 h-4" />
                        <span className="hidden sm:inline">Import Playlist URL</span>
                        <span className="sm:hidden">Import URL</span>
                    </button>
                </div>

                {/* Provider Tabs */}
                <div className="flex flex-wrap items-center gap-2 mb-4">
                    {providerTabs.map((tab) => {
                        const isActive = activeProvider === tab.provider;
                        const isTidalTab = tab.provider === "tidal";

                        return (
                            <button
                                key={tab.provider}
                                type="button"
                                onClick={() => setActiveProvider(tab.provider)}
                                className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                                    isActive
                                        ? "bg-white text-black"
                                        : "bg-white/10 text-white hover:bg-white/20"
                                }`}
                            >
                                {isTidalTab &&
                                    (tab.locked ? (
                                        <Lock className="w-3.5 h-3.5" />
                                    ) : (
                                        <CheckCircle2 className="w-3.5 h-3.5" />
                                    ))}
                                <span>{tab.label}</span>
                                {tab.statusLabel && (
                                    <span
                                        className={`text-[11px] px-2 py-0.5 rounded-full ${
                                            isActive
                                                ? "bg-black/10 text-black/80"
                                                : "bg-white/10 text-white/80"
                                        }`}
                                    >
                                        {tab.statusLabel}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>

                {activeProvider === "ytmusic" && (
                    <>
                        {/* YouTube Music tabs */}
                        <div className="flex items-center gap-2 mb-6">
                            <button
                                type="button"
                                onClick={() => setActiveTab("charts")}
                                className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                                    activeTab === "charts"
                                        ? "bg-white text-black"
                                        : "bg-white/10 text-white hover:bg-white/20"
                                }`}
                            >
                                Charts
                            </button>
                            <button
                                type="button"
                                onClick={() => setActiveTab("categories")}
                                className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                                    activeTab === "categories"
                                        ? "bg-red-500 text-white"
                                        : "bg-white/10 text-white hover:bg-white/20"
                                }`}
                            >
                                Moods & Genres
                            </button>
                        </div>

                        {/* Loading State */}
                        {isLoading && !loadError && (
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
                                    type="button"
                                    onClick={
                                        activeTab === "charts"
                                            ? fetchCharts
                                            : fetchCategories
                                    }
                                    className="px-6 py-2.5 rounded-full bg-white text-black text-sm font-medium hover:scale-105 transition-transform"
                                >
                                    Try again
                                </button>
                            </div>
                        )}

                        {/* Charts Tab */}
                        {!isLoading && !loadError && activeTab === "charts" && (
                            <div className="space-y-10">
                                {Object.entries(charts).map(([sectionKey, items]) => {
                                    if (!items || items.length === 0) return null;
                                    const info = sectionLabels[sectionKey] || {
                                        label: sectionKey,
                                        icon: Music2,
                                    };
                                    const SectionIcon = info.icon;

                                    return (
                                        <section key={sectionKey}>
                                            <div className="flex items-center gap-2 mb-4">
                                                <SectionIcon className="w-5 h-5 text-red-400" />
                                                <h2 className="text-xl font-bold text-white">
                                                    {info.label}
                                                </h2>
                                            </div>
                                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-6">
                                                {items.map((item, idx) =>
                                                    renderChartCard(item, idx, sectionKey)
                                                )}
                                            </div>
                                        </section>
                                    );
                                })}
                                {Object.keys(charts).length === 0 && (
                                    <div className="flex flex-col items-center justify-center py-20 text-center">
                                        <Music2 className="w-12 h-12 text-gray-500 mb-4" />
                                        <h3 className="text-lg font-medium text-white mb-2">
                                            No charts available
                                        </h3>
                                        <p className="text-sm text-gray-400">
                                            Charts may not be available for your region
                                        </p>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Categories Tab */}
                        {!isLoading && !loadError && activeTab === "categories" && (
                            <div>
                                <h2 className="text-xl font-bold text-white mb-2">
                                    Moods & Genres
                                </h2>
                                <p className="text-sm text-gray-400 mb-6">
                                    Explore playlists by mood and genre
                                </p>
                                {categories.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center py-20 text-center">
                                        <Sparkles className="w-12 h-12 text-gray-500 mb-4" />
                                        <h3 className="text-lg font-medium text-white mb-2">
                                            No categories available
                                        </h3>
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                                        {categories.map(renderCategoryCard)}
                                    </div>
                                )}
                            </div>
                        )}
                    </>
                )}

                {activeProvider === "tidal" && (
                    <>
                        {tidalBrowseState.state === "checking" && (
                            <div className="flex flex-col items-center justify-center py-20 text-center">
                                <Loader2 className="w-8 h-8 text-cyan-300 animate-spin mb-4" />
                                <h3 className="text-lg font-medium text-white mb-2">
                                    Checking TIDAL connection
                                </h3>
                                <p className="text-sm text-gray-400 max-w-sm">
                                    {tidalBrowseState.message}
                                </p>
                            </div>
                        )}

                        {tidalBrowseState.state === "disconnected" && (
                            <div className="flex flex-col items-center justify-center py-20 text-center">
                                <div className="w-16 h-16 rounded-full bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center mb-4">
                                    <Lock className="w-7 h-7 text-cyan-300" />
                                </div>
                                <h3 className="text-lg font-medium text-white mb-2">
                                    Connect TIDAL to browse
                                </h3>
                                <p className="text-sm text-gray-400 mb-6 max-w-md">
                                    {tidalBrowseState.message}
                                </p>
                                <div className="flex flex-wrap items-center justify-center gap-3">
                                    <button
                                        type="button"
                                        onClick={() => router.push(tidalBrowseState.ctaHref)}
                                        className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-cyan-300 text-black text-sm font-semibold hover:bg-cyan-200 transition-colors"
                                    >
                                        <span>{tidalBrowseState.ctaLabel}</span>
                                        <ArrowRight className="w-4 h-4" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setActiveProvider("ytmusic")}
                                        className="px-6 py-2.5 rounded-full bg-white/10 text-white text-sm font-medium hover:bg-white/20 transition-colors"
                                    >
                                        Browse YouTube Music
                                    </button>
                                </div>
                            </div>
                        )}

                        {tidalBrowseState.state === "connected" && (
                            <div>
                                <h2 className="text-xl font-bold text-white mb-2">
                                    TIDAL Quick Browse
                                </h2>
                                <p className="text-sm text-gray-400 mb-6">
                                    Jump into curated TIDAL-oriented searches and discover
                                    new playlists fast.
                                </p>
                                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                                    {TIDAL_SPOTLIGHTS.map(renderTidalSpotlightCard)}
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* URL Import Modal */}
            {showUrlModal && (
                <div
                    className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 animate-in fade-in duration-200"
                    onClick={() => setShowUrlModal(false)}
                >
                    <div
                        className="bg-[#0d0d0d] rounded-2xl max-w-lg w-full shadow-2xl border border-white/[0.03] animate-in zoom-in-95 duration-200"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header */}
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
                                Paste a Spotify or Deezer playlist link
                            </p>
                        </div>

                        {/* Supported platforms */}
                        <div className="px-6 pb-4">
                            <div className="flex items-center gap-3 p-3 bg-white/[0.03] rounded-xl border border-white/[0.03]">
                                <div className="flex items-center gap-2 px-3 py-1.5 bg-[#1DB954]/10 rounded-full">
                                    <svg viewBox="0 0 24 24" className="w-4 h-4 text-[#1DB954]" fill="currentColor">
                                        <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
                                    </svg>
                                    <span className="text-xs font-medium text-[#1DB954]">Spotify</span>
                                </div>
                                <div className="flex items-center gap-2 px-3 py-1.5 bg-[#AD47FF]/10 rounded-full">
                                    <DeezerIcon className="w-4 h-4 text-[#AD47FF]" />
                                    <span className="text-xs font-medium text-[#AD47FF]">Deezer</span>
                                </div>
                                <span className="text-xs text-white/30 ml-auto">Supported</span>
                            </div>
                        </div>

                        {/* Input */}
                        <div className="px-6 pb-6">
                            <div className="relative">
                                <input
                                    type="text"
                                    value={urlInput}
                                    onChange={(e) => setUrlInput(e.target.value)}
                                    placeholder="Paste playlist URL here..."
                                    className="w-full bg-black/40 border border-white/[0.06] rounded-xl px-4 py-4 text-white placeholder:text-white/30 focus:outline-none focus:border-[#3b82f6]/40 focus:ring-1 focus:ring-[#3b82f6]/20 transition-all text-sm"
                                    onKeyDown={(e) => e.key === "Enter" && handleUrlSubmit()}
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
                                Example: https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
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
