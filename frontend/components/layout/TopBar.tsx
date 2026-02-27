"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import {
    Home,
    Search,
    Menu,
    Bell,
    ChevronLeft,
} from "lucide-react";
import { ActivityPanelToggle } from "./ActivityPanel";
import { UserAvatarMenu } from "./UserAvatarMenu";
import { cn } from "@/utils/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import Image from "next/image";

import { BRAND_NAME } from "@/lib/brand";

interface TopBarProps {
    isActivityPanelOpen?: boolean;
}

export function TopBar({ isActivityPanelOpen = false }: TopBarProps = {}) {
    const pathname = usePathname();
    const router = useRouter();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    const [searchQuery, setSearchQuery] = useState("");
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        if (searchQuery.trim()) {
            router.push(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
        }
    };

    // Auto-search with debounce (500ms after user stops typing)
    useEffect(() => {
        // Don't auto-search if we're already on the search page with the same query
        const params = new URLSearchParams(window.location.search);
        const currentQuery = params.get("q");
        if (pathname === "/search" && currentQuery === searchQuery.trim()) {
            return;
        }

        // Clear any existing timeout
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }

        // Don't search if query is empty
        if (!searchQuery.trim()) {
            return;
        }

        // Set new timeout to trigger search after 500ms of no typing
        searchTimeoutRef.current = setTimeout(() => {
            router.push(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
        }, 500);

        // Cleanup timeout on unmount or when searchQuery changes
        return () => {
            if (searchTimeoutRef.current) {
                clearTimeout(searchTimeoutRef.current);
            }
        };
    }, [searchQuery, router, pathname]);

    // Sync search query with URL on page change
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const q = params.get("q");

        if (pathname === "/search" && q) {
            // Only update if different to avoid loops
            if (q !== searchQuery) {
                setSearchQuery(q);
            }
        } else if (pathname !== "/search" && searchQuery) {
            // Clear search when leaving search page
            setSearchQuery("");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pathname]); // Only re-run when pathname changes

    // Global "/" keyboard shortcut to focus search
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const tag = (e.target as HTMLElement)?.tagName;
                if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) {
                    return;
                }
                e.preventDefault();
                searchInputRef.current?.focus();
            }
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, []);

    return (
        <header
            className="fixed top-0 left-0 right-0 bg-black flex items-center px-3 z-50"
            style={{
                height: isMobileOrTablet ? "58px" : "64px",
                paddingTop: isMobileOrTablet
                    ? "env(safe-area-inset-top)"
                    : undefined,
            }}
        >
            {/* Mobile/Tablet Layout: Hamburger + Home + Search + Bell */}
            {isMobileOrTablet ? (
                <>
                    {/* Hamburger menu button */}
                    <button
                        onClick={() => {
                            // Dispatch custom event to toggle mobile menu
                            window.dispatchEvent(
                                new CustomEvent("toggle-mobile-menu")
                            );
                        }}
                        className="w-10 h-10 flex items-center justify-center bg-[#0f0f0f] border border-[#262626] rounded-md text-white hover:bg-[#141414] transition-colors mr-2 flex-shrink-0"
                        aria-label="Open menu"
                    >
                        <Menu className="w-5 h-5" />
                    </button>

                    {/* Back slot (reserved to keep search position stable across routes) */}
                    <div className="w-10 h-10 mr-1 flex items-center justify-center flex-shrink-0">
                        {pathname !== "/" ? (
                            <button
                                onClick={() => router.back()}
                                className="w-10 h-10 rounded-full flex items-center justify-center transition-all bg-[#0a0a0a] text-gray-400 hover:bg-[#1a1a1a] hover:text-white"
                                aria-label="Go back"
                                title="Go back"
                            >
                                <ChevronLeft className="w-5 h-5" />
                            </button>
                        ) : (
                            <span className="w-10 h-10" aria-hidden="true" />
                        )}
                    </div>

                    {/* Home */}
                    <Link
                        href="/"
                        className={cn(
                            "w-10 h-10 rounded-full flex items-center justify-center transition-all flex-shrink-0 mr-1",
                            pathname === "/"
                                ? "bg-white text-black"
                                : "bg-[#0a0a0a] text-gray-400 hover:bg-[#1a1a1a] hover:text-white"
                        )}
                        aria-label="Home"
                        title="Home"
                    >
                        <Home className="w-5 h-5" />
                    </Link>

                    {/* Search */}
                    <form onSubmit={handleSearch} className="flex-1 min-w-0">
                        <div
                            className="relative"
                            data-tv-section="search-input"
                        >
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Search..."
                                aria-label="Search"
                                autoCapitalize="none"
                                autoCorrect="off"
                                tabIndex={0}
                                className="w-full h-10 pl-10 pr-3 bg-[#1a1a1a] hover:bg-[#242424] border-2 border-transparent focus:border-white/20 rounded-full text-sm text-white placeholder-gray-400 transition-all outline-none"
                            />
                        </div>
                    </form>

                    {/* Notification Bell */}
                    <button
                        onClick={() => {
                            window.dispatchEvent(
                                new CustomEvent("toggle-activity-panel")
                            );
                        }}
                        className="w-10 h-10 flex items-center justify-center text-gray-400 hover:text-white transition-colors ml-2 flex-shrink-0 relative"
                        aria-label="Notifications"
                        title="Notifications"
                    >
                        <Bell className="w-5 h-5" />
                        {/* TODO: Add notification badge in Phase 3 */}
                    </button>
                </>
            ) : (
                <>
                    {/* Desktop Layout */}
                    {/* Logo - Far Left */}
                    <div className="w-64 flex items-center px-2">
                        <Link
                            href="/"
                            className="flex items-center gap-2 group"
                        >
                            <Image
                                src="/assets/images/soundspan.webp"
                                alt={BRAND_NAME}
                                width={46}
                                height={46}
                                sizes="46px"
                                className="group-hover:scale-105 transition-transform"
                            />
                            <span className="brand-wordmark text-[2.15rem] font-bold bg-gradient-to-r from-white via-white to-gray-300 bg-clip-text text-transparent">
                                {BRAND_NAME}
                            </span>
                        </Link>
                    </div>

                    {/* Center - Search stays centered; Back/Home hug search edge */}
                    <div className="flex-1 min-w-0 flex items-center justify-center">
                        <div className="relative w-full max-w-md">
                            <div className="absolute right-full top-1/2 -translate-y-1/2 pr-2 flex items-center gap-2">
                                {/* Back */}
                                {pathname !== "/" && (
                                    <button
                                        onClick={() => router.back()}
                                        className="w-12 h-12 rounded-full flex items-center justify-center transition-all flex-shrink-0 bg-[#0a0a0a] text-gray-400 hover:bg-[#1a1a1a] hover:text-white hover:scale-105"
                                        aria-label="Go back"
                                        title="Go back"
                                    >
                                        <ChevronLeft className="w-6 h-6" />
                                    </button>
                                )}

                                <Link
                                    href="/"
                                    className={cn(
                                        "w-12 h-12 rounded-full flex items-center justify-center transition-all flex-shrink-0",
                                        pathname === "/"
                                            ? "bg-white text-black"
                                            : "bg-[#0a0a0a] text-gray-400 hover:bg-[#1a1a1a] hover:text-white hover:scale-105"
                                    )}
                                    aria-label="Home"
                                    title="Home"
                                >
                                    <Home className="w-6 h-6" />
                                </Link>
                            </div>

                            <form
                                onSubmit={handleSearch}
                                className="w-full"
                            >
                                <div
                                    className="relative"
                                    data-tv-section="search-input"
                                >
                                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                                    <input
                                        ref={searchInputRef}
                                        type="text"
                                        value={searchQuery}
                                        onChange={(e) =>
                                            setSearchQuery(e.target.value)
                                        }
                                        placeholder="What do you want to play?"
                                        aria-label="Search"
                                        autoCapitalize="none"
                                        autoCorrect="off"
                                        tabIndex={0}
                                        className="w-full h-12 pl-12 pr-4 bg-[#1a1a1a] hover:bg-[#242424] border-2 border-transparent focus:border-white/20 rounded-full text-sm text-white placeholder-gray-400 transition-all outline-none"
                                    />
                                </div>
                            </form>
                        </div>
                    </div>

                    {/* Right - Activity & User */}
                    <div className="w-64 flex items-center justify-end gap-2 px-2">
                        <ActivityPanelToggle
                            pollingEnabled={!isActivityPanelOpen}
                        />
                        <UserAvatarMenu />
                    </div>
                </>
            )}
        </header>
    );
}
