"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { Plus, RefreshCw, ArrowUpDown } from "lucide-react";
import { cn } from "@/utils/cn";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useAudioState } from "@/lib/audio-state-context";
import { useActiveListenSessions } from "@/hooks/useActiveListenSessions";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { useToast } from "@/lib/toast-context";
import { EqBars } from "@/components/ui/EqBars";
import Image from "next/image";
import { MobileSidebar } from "./MobileSidebar";
import { SIDEBAR_NAVIGATION } from "./socialNavigation";
import { BRAND_NAME } from "@/lib/brand";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

interface Playlist {
    id: string;
    name: string;
    trackCount: number;
    createdAt?: string;
    updatedAt?: string;
    isHidden?: boolean;
    isOwner?: boolean;
    user?: { username: string };
}

type PlaylistSort = "created" | "updated" | "alphabetical";
type PlaylistFilter = "all" | "mine" | "others";

export function Sidebar() {
    const pathname = usePathname();
    const { isAuthenticated } = useAuth();
    const { toast } = useToast();
    const { currentTrack, currentAudiobook, currentPodcast, playbackType } =
        useAudioState();
    const hasActiveSessions = useActiveListenSessions();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [playlists, setPlaylists] = useState<Playlist[]>([]);
    const [isLoadingPlaylists, setIsLoadingPlaylists] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [playlistSort, setPlaylistSort] = useState<PlaylistSort>("updated");
    const [playlistFilter, setPlaylistFilter] = useState<PlaylistFilter>("all");
    const [isSortFilterOpen, setIsSortFilterOpen] = useState(false);
    const [sortFilterPos, setSortFilterPos] = useState<{ top: number; left: number } | null>(null);
    const sortFilterRef = useRef<HTMLDivElement>(null);
    const sortFilterBtnRef = useRef<HTMLButtonElement>(null);
    const hasLoadedPlaylists = useRef(false);

    // Handle library sync - no toast, notification bar handles feedback
    const handleSync = async () => {
        if (isSyncing) return;

        try {
            setIsSyncing(true);
            await api.scanLibrary();
            // No toast - notification will appear in the activity panel
            window.dispatchEvent(new CustomEvent("notifications-changed"));
        } catch (error) {
            sharedFrontendLogger.error("Failed to trigger library scan:", error);
            toast.error("Failed to start scan. Please try again.");
        } finally {
            // Keep syncing for a bit to show the animation
            setTimeout(() => setIsSyncing(false), 2000);
        }
    };

    // Load playlists only once
    useEffect(() => {
        let loadingTimeout: NodeJS.Timeout | null = null;

        const loadPlaylists = async () => {
            if (!isAuthenticated || hasLoadedPlaylists.current) return;

            // Delay showing loading state to avoid flicker
            loadingTimeout = setTimeout(() => setIsLoadingPlaylists(true), 200);
            hasLoadedPlaylists.current = true;
            try {
                const data = await api.getPlaylists();
                setPlaylists(data);
            } catch (error) {
                sharedFrontendLogger.error("Failed to load playlists:", error);
                hasLoadedPlaylists.current = false; // Allow retry on error
            } finally {
                if (loadingTimeout) clearTimeout(loadingTimeout);
                setIsLoadingPlaylists(false);
            }
        };

        loadPlaylists();

        // Listen for playlist events to refresh playlists
        const handlePlaylistEvent = async () => {
            if (!isAuthenticated) return;
            try {
                const data = await api.getPlaylists();
                setPlaylists(data);
            } catch (error) {
                sharedFrontendLogger.error("Failed to reload playlists:", error);
            }
        };

        window.addEventListener("playlist-created", handlePlaylistEvent);
        window.addEventListener("playlist-updated", handlePlaylistEvent);
        window.addEventListener("playlist-deleted", handlePlaylistEvent);

        return () => {
            if (loadingTimeout) {
                clearTimeout(loadingTimeout);
            }
            window.removeEventListener("playlist-created", handlePlaylistEvent);
            window.removeEventListener("playlist-updated", handlePlaylistEvent);
            window.removeEventListener("playlist-deleted", handlePlaylistEvent);
        };
    }, [isAuthenticated]);

    // Close mobile menu when route changes
    useEffect(() => {
        setIsMobileMenuOpen(false);
    }, [pathname]);

    // Close mobile menu on escape key
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === "Escape") setIsMobileMenuOpen(false);
        };

        if (isMobileMenuOpen) {
            document.addEventListener("keydown", handleEscape);
            document.body.style.overflow = "hidden";
        }

        return () => {
            document.removeEventListener("keydown", handleEscape);
            document.body.style.overflow = "unset";
        };
    }, [isMobileMenuOpen]);

    // Listen for toggle event from TopBar
    useEffect(() => {
        const handleToggle = () => setIsMobileMenuOpen(true);
        window.addEventListener("toggle-mobile-menu", handleToggle);
        return () =>
            window.removeEventListener("toggle-mobile-menu", handleToggle);
    }, []);

    // Close sort/filter popover on outside click
    useEffect(() => {
        if (!isSortFilterOpen) return;
        const handleClick = (e: MouseEvent) => {
            if (sortFilterRef.current && !sortFilterRef.current.contains(e.target as Node)) {
                setIsSortFilterOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [isSortFilterOpen]);

    // Don't show sidebar on login/register pages
    // (Check after all hooks to comply with Rules of Hooks)
    if (pathname === "/login" || pathname === "/register") {
        return null;
    }

    // Apply filter and sort to playlists
    const filteredSortedPlaylists = playlists
        .filter((p) => !p.isHidden)
        .filter((p) => {
            if (playlistFilter === "mine") return p.isOwner !== false;
            if (playlistFilter === "others") return p.isOwner === false;
            return true;
        })
        .sort((a, b) => {
            if (playlistSort === "alphabetical") {
                return a.name.localeCompare(b.name);
            }
            if (playlistSort === "created") {
                return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
            }
            // updated (default) — most recently updated first
            return (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? "");
        });

    const isFiltered = playlistFilter !== "all" || playlistSort !== "updated";

    // Render sidebar content inline to prevent component recreation
    const sidebarContent = (
        <>
            {/* Mobile Only - Logo and App Info */}
            {isMobileOrTablet && (
                <div className="px-6 pt-8 pb-6 border-b border-white/[0.08]">
                    {/* Logo and Title */}
                    <div className="flex items-center gap-4 mb-5">
                        <Image
                            src="/assets/images/soundspan.webp"
                            alt={BRAND_NAME}
                            width={48}
                            height={48}
                            sizes="48px"
                            className="flex-shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                            <h2 className="brand-wordmark text-2xl font-black text-white tracking-tight">
                                {BRAND_NAME}
                            </h2>
                            {(
                                !currentTrack &&
                                !currentAudiobook &&
                                !currentPodcast
                            ) ?
                                <p className="text-sm text-gray-400 font-medium">
                                    Stream Your Way
                                </p>
                            :   <div className="text-xs text-gray-400 truncate">
                                    <span className="text-gray-500">
                                        Listening to:{" "}
                                    </span>
                                    <span className="text-white font-medium">
                                        {(
                                            playbackType === "track" &&
                                            currentTrack
                                        ) ?
                                            `${currentTrack.artist?.name} - ${currentTrack.album?.title}`
                                        : (
                                            playbackType === "audiobook" &&
                                            currentAudiobook
                                        ) ?
                                            currentAudiobook.title
                                        : (
                                            playbackType === "podcast" &&
                                            currentPodcast
                                        ) ?
                                            currentPodcast.podcastTitle
                                        :   ""}
                                    </span>
                                </div>
                            }
                        </div>
                    </div>

                    {/* Quick Actions - Sync */}
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleSync}
                            disabled={isSyncing}
                            className={cn(
                                "w-10 h-10 flex items-center justify-center rounded-full transition-all duration-300",
                                isSyncing ?
                                    "bg-[#1DB954] text-black"
                                :   "bg-white/10 text-white hover:bg-white/15 active:scale-95",
                            )}
                            aria-label={
                                isSyncing ? "Syncing library" : "Sync library"
                            }
                            title={isSyncing ? "Syncing..." : "Sync Library"}
                        >
                            <RefreshCw
                                className={cn(
                                    "w-4 h-4 transition-transform",
                                    isSyncing && "animate-spin",
                                )}
                            />
                        </button>

                    </div>
                </div>
            )}

            {/* Navigation */}
            <nav
                className={cn(
                    isMobileOrTablet ? "pt-4 space-y-1 px-6" : "pt-3 space-y-1 px-3",
                )}
                role="navigation"
                aria-label="Main navigation"
            >
                {SIDEBAR_NAVIGATION.map((item) => {
                    const isActive = pathname === item.href;
                    const badge = "badge" in item ? item.badge : null;
                    const isListenTogether = item.href === "/listen-together";

                    return (
                        <Link
                            key={item.name}
                            href={item.href}
                            aria-current={isActive ? "page" : undefined}
                            className={cn(
                                "block rounded-lg transition-all duration-200 group relative overflow-hidden",
                                isMobileOrTablet ? "px-4 py-3.5" : "px-3 py-2",
                                isActive ?
                                    "bg-white/10 text-white"
                                :   "text-gray-400 hover:text-white hover:bg-white/5 active:bg-white/[0.07]",
                            )}
                        >
                            <div className="relative z-10 flex items-center gap-2">
                                <span
                                    className={cn(
                                        "font-semibold transition-all duration-200",
                                        isMobileOrTablet ? "text-base" : (
                                            "text-sm"
                                        ),
                                        isActive && "text-white",
                                    )}
                                >
                                    {item.name}
                                </span>
                                {badge && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-[#3b82f6]/20 text-[#3b82f6] border border-[#3b82f6]/30">
                                        {badge}
                                    </span>
                                )}
                                {isListenTogether && hasActiveSessions && (
                                    <EqBars />
                                )}
                            </div>
                        </Link>
                    );
                })}
            </nav>

            {/* Playlists Section */}
            <div className={cn("flex-1 overflow-hidden flex flex-col", isMobileOrTablet ? "mt-8" : "mt-4")}>
                <div
                    className={cn(
                        "flex items-center justify-between group",
                        isMobileOrTablet ? "mb-4 px-6" : "mb-2 px-3",
                    )}
                >
                    <Link
                        href="/playlists"
                        prefetch={false}
                        className="relative group/link"
                    >
                        <span className="text-[10px] font-black text-gray-500 group-hover/link:text-transparent group-hover/link:bg-clip-text group-hover/link:bg-gradient-to-r group-hover/link:from-[#5b5bff] group-hover/link:to-[#00c8ff] transition-all duration-300 uppercase tracking-[0.15em]">
                            {playlistFilter === "others"
                                ? "Shared playlists"
                                : playlistFilter === "mine"
                                  ? "Your playlists"
                                  : "All playlists"}
                        </span>
                        <div className="absolute -bottom-0.5 left-0 right-0 h-px bg-gradient-to-r from-[#2323FF]/0 via-[#2323FF]/50 to-[#2323FF]/0 opacity-0 group-hover/link:opacity-100 transition-opacity duration-300" />
                    </Link>
                    <div className="flex items-center gap-1">
                        <div ref={sortFilterRef} className="relative">
                            <button
                                ref={sortFilterBtnRef}
                                onClick={() => {
                                    setIsSortFilterOpen((v) => {
                                        if (!v && sortFilterBtnRef.current) {
                                            const rect = sortFilterBtnRef.current.getBoundingClientRect();
                                            setSortFilterPos({ top: rect.top, left: rect.right + 8 });
                                        }
                                        return !v;
                                    });
                                }}
                                className={cn(
                                    "w-7 h-7 flex items-center justify-center rounded-md transition-all duration-300 border border-white/5",
                                    isFiltered
                                        ? "bg-[#2323FF]/20 text-[#5b5bff] border-[#2323FF]/30"
                                        : "bg-white/5 text-gray-400 hover:text-white hover:bg-gradient-to-br hover:from-[#2323FF] hover:to-[#00c8ff] hover:scale-110 shadow-lg shadow-transparent hover:shadow-[#2323FF]/30 hover:border-transparent"
                                )}
                                aria-label="Sort and filter playlists"
                                title="Sort & Filter"
                            >
                                <ArrowUpDown className="w-3.5 h-3.5" />
                            </button>

                            {isSortFilterOpen && sortFilterPos && (
                                <div
                                    className="fixed w-44 bg-[#1a1a1a] border border-white/10 rounded-lg shadow-xl shadow-black/40 py-1 z-[10000]"
                                    style={{ top: sortFilterPos.top, left: sortFilterPos.left }}
                                >
                                    <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                                        Sort
                                    </div>
                                    {([
                                        ["updated", "Updated date"],
                                        ["created", "Created date"],
                                        ["alphabetical", "Alphabetical"],
                                    ] as const).map(([value, label]) => (
                                        <button
                                            key={value}
                                            onClick={() => setPlaylistSort(value)}
                                            className={cn(
                                                "w-full text-left px-3 py-1.5 text-sm transition-colors",
                                                playlistSort === value
                                                    ? "text-white bg-white/5"
                                                    : "text-gray-400 hover:text-white hover:bg-white/5"
                                            )}
                                        >
                                            {label}
                                        </button>
                                    ))}

                                    <div className="mx-2 my-1 border-t border-white/10" />

                                    <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                                        Show
                                    </div>
                                    {([
                                        ["all", "All playlists"],
                                        ["mine", "Your playlists"],
                                        ["others", "Shared playlists"],
                                    ] as const).map(([value, label]) => (
                                        <button
                                            key={value}
                                            onClick={() => setPlaylistFilter(value)}
                                            className={cn(
                                                "w-full text-left px-3 py-1.5 text-sm transition-colors",
                                                playlistFilter === value
                                                    ? "text-white bg-white/5"
                                                    : "text-gray-400 hover:text-white hover:bg-white/5"
                                            )}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        <Link
                            href="/playlists"
                            prefetch={false}
                            className="w-7 h-7 flex items-center justify-center rounded-md bg-white/5 text-gray-400 hover:text-white hover:bg-gradient-to-br hover:from-[#2323FF] hover:to-[#00c8ff] hover:scale-110 transition-all duration-300 shadow-lg shadow-transparent hover:shadow-[#2323FF]/30 border border-white/5 hover:border-transparent"
                            aria-label="Create playlist"
                            title="Create Playlist"
                        >
                            <Plus className="w-4 h-4" />
                        </Link>
                    </div>
                </div>
                <div
                    className={cn(
                        "flex-1 overflow-y-auto space-y-1 scrollbar-thin scrollbar-thumb-[#1c1c1c] scrollbar-track-transparent",
                        isMobileOrTablet ? "px-6" : "px-3",
                    )}
                >
                    {isLoadingPlaylists ?
                        // Loading skeleton with shimmer
                        <>
                            {[1, 2, 3, 4, 5].map((i) => (
                                <div
                                    key={i}
                                    className="px-3 py-2.5 rounded-lg relative overflow-hidden bg-white/[0.02] border-l-2 border-transparent"
                                >
                                    <div
                                        className="absolute inset-0 bg-gradient-to-r from-transparent via-[#2323FF]/10 to-transparent"
                                        style={{
                                            animation: "shimmer 2s infinite",
                                        }}
                                    />
                                    <div className="h-4 bg-white/5 rounded w-3/4 mb-2 relative"></div>
                                    <div className="h-3 bg-white/5 rounded w-1/2 relative"></div>
                                </div>
                            ))}
                        </>
                    : filteredSortedPlaylists.length > 0 ?
                        filteredSortedPlaylists
                            .map((playlist) => {
                                const isActive =
                                    pathname === `/playlist/${playlist.id}`;
                                const isShared = playlist.isOwner === false;
                                return (
                                    <Link
                                        key={playlist.id}
                                        href={`/playlist/${playlist.id}`}
                                        prefetch={false}
                                        className={cn(
                                            "block px-3 py-2.5 rounded-lg transition-all duration-300 group relative overflow-hidden",
                                            isActive ?
                                                "bg-gradient-to-r from-[#2323FF]/10 to-transparent text-white border-l-2 border-[#2323FF] shadow-md shadow-[#2323FF]/5"
                                            :   "text-gray-400 hover:text-white hover:bg-white/[0.05] border-l-2 border-transparent hover:border-l-2 hover:border-[#2323FF]/30",
                                        )}
                                    >
                                        {/* Hover shimmer effect */}
                                        {!isActive && (
                                            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-[#2323FF]/5 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700" />
                                        )}

                                        <div className="flex items-center gap-1.5">
                                            <div
                                                className={cn(
                                                    "text-sm font-medium truncate relative z-10 transition-all duration-200 flex-1",
                                                    isActive ? "font-semibold"
                                                    :   "group-hover:translate-x-0.5",
                                                )}
                                            >
                                                {playlist.name}
                                            </div>
                                            {isShared && (
                                                <span
                                                    className="shrink-0 w-1.5 h-1.5 rounded-full bg-[#2323FF]"
                                                    title={`Shared by ${
                                                        playlist.user
                                                            ?.username ||
                                                        "someone"
                                                    }`}
                                                />
                                            )}
                                        </div>
                                        <div
                                            className={cn(
                                                "text-xs truncate relative z-10 mt-0.5 transition-colors duration-200",
                                                isActive ? "text-gray-400" : (
                                                    "text-gray-500 group-hover:text-gray-400"
                                                ),
                                            )}
                                        >
                                            {isShared ?
                                                `by ${
                                                    playlist.user?.username ||
                                                    "Shared"
                                                }`
                                            :   "Playlist"}{" "}
                                            • {playlist.trackCount} track
                                            {playlist.trackCount !== 1 ?
                                                "s"
                                            :   ""}
                                        </div>
                                    </Link>
                                );
                            })
                    :   <div className="px-4 py-8 text-center">
                            <div className="text-sm text-gray-500 mb-2">
                                {isFiltered ? "No matching playlists" : "No playlists yet"}
                            </div>
                            <div className="text-xs text-gray-600">
                                {isFiltered
                                    ? "Try changing your filter"
                                    : "Create your first playlist to get started"}
                            </div>
                        </div>
                    }
                </div>
            </div>
        </>
    );

    return (
        <>
            {/* Mobile Sidebar */}
            {isMobileOrTablet && (
                <MobileSidebar
                    isOpen={isMobileMenuOpen}
                    onClose={() => setIsMobileMenuOpen(false)}
                />
            )}

            {/* Desktop Sidebar */}
            {!isMobileOrTablet && (
                <aside className="w-64 bg-[#0f0f0f] rounded-lg flex flex-col overflow-hidden relative z-10 border border-white/[0.03]">
                    {sidebarContent}
                </aside>
            )}
        </>
    );
}
