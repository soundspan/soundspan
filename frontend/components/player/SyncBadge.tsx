"use client";

import { memo, useState, useRef, useCallback, useEffect } from "react";
import Link from "next/link";
import { Crown, Users, Wifi, WifiOff, X } from "lucide-react";
import { useListenTogether } from "@/lib/listen-together-context";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { cn } from "@/utils/cn";

interface SyncBadgeProps {
    /** Use compact styling for the mini/overlay player. */
    compact?: boolean;
}

/**
 * Small indicator badge shown in the player when the user is in a
 * Listen Together group.
 *
 * - **compact** (MiniPlayer / OverlayPlayer): plain link to `/listen-together`.
 * - **full** (FullPlayer): hover/click opens a popup listing group members,
 *   styled like the playback quality stats popup.
 *
 * Renders nothing when not in a group.
 */
const SyncBadge = memo(function SyncBadge({ compact = false }: SyncBadgeProps) {
    const { isInGroup, activeGroup, isConnected } = useListenTogether();
    const [isOpen, setIsOpen] = useState(false);
    const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const isMobile = useIsMobile();

    const clearCloseTimeout = useCallback(() => {
        if (closeTimeoutRef.current) {
            clearTimeout(closeTimeoutRef.current);
            closeTimeoutRef.current = null;
        }
    }, []);

    const handleMouseEnter = useCallback(() => {
        if (isMobile || compact) return;
        clearCloseTimeout();
        setIsOpen(true);
    }, [isMobile, compact, clearCloseTimeout]);

    const handleMouseLeave = useCallback(() => {
        if (isMobile || compact) return;
        clearCloseTimeout();
        closeTimeoutRef.current = setTimeout(() => {
            setIsOpen(false);
        }, 150);
    }, [isMobile, compact, clearCloseTimeout]);

    const handleClick = useCallback(
        (e: React.MouseEvent) => {
            if (compact) return; // let the Link navigate
            e.preventDefault();
            e.stopPropagation();
            if (isMobile) {
                setIsOpen((prev) => !prev);
            }
        },
        [isMobile, compact],
    );

    const handleClose = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setIsOpen(false);
    }, []);

    // Close on outside click (mobile)
    useEffect(() => {
        if (!isOpen || !isMobile) return;
        const handleOutsideClick = (e: MouseEvent) => {
            if (
                containerRef.current &&
                !containerRef.current.contains(e.target as Node)
            ) {
                setIsOpen(false);
            }
        };
        document.addEventListener("mousedown", handleOutsideClick);
        return () => document.removeEventListener("mousedown", handleOutsideClick);
    }, [isOpen, isMobile]);

    useEffect(() => {
        return () => clearCloseTimeout();
    }, [clearCloseTimeout]);

    if (!isInGroup || !activeGroup) return null;

    const memberCount = activeGroup.members.length;
    const accentClass = isConnected
        ? "bg-[#2323FF]/20 text-[#5b5bff] hover:bg-[#2323FF]/30"
        : "bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30";

    // Compact mode: simple link, no popup
    if (compact) {
        return (
            <Link
                href="/listen-together"
                prefetch={false}
                className={cn(
                    "inline-flex items-center gap-1 font-bold rounded transition-colors",
                    accentClass,
                    "text-[9px] px-1 py-0.5 leading-none"
                )}
                title={`Listen Together — ${memberCount} listener${memberCount === 1 ? "" : "s"}`}
            >
                <Users className="w-2.5 h-2.5" />
            </Link>
        );
    }

    // Full mode: badge with popup
    const sortedMembers = [...activeGroup.members].sort((a, b) => {
        // Host first, then alphabetical
        if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
        return a.username.localeCompare(b.username);
    });

    return (
        <div
            ref={containerRef}
            className="relative inline-flex"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
        >
            <Link
                href="/listen-together"
                prefetch={false}
                onClick={handleClick}
                className={cn(
                    "inline-flex items-center gap-1 font-bold rounded transition-colors cursor-pointer",
                    accentClass,
                    "text-[10px] px-1.5 py-0.5"
                )}
            >
                <Users className="w-3 h-3" />
                {memberCount}
            </Link>

            {/* Members popup */}
            <div
                className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 bg-[#1a1a1a] border border-white/10 rounded-lg shadow-2xl shadow-black/50 p-3 backdrop-blur-xl z-[10002] transition-all duration-200 ${
                    isOpen
                        ? "opacity-100 scale-100 pointer-events-auto"
                        : "opacity-0 scale-95 pointer-events-none"
                }`}
            >
                {/* Pointer arrow */}
                <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-[#1a1a1a] border-r border-b border-white/10 rotate-45" />

                {/* Title */}
                <div className="flex items-center justify-between mb-2">
                    <h3 className="font-bold text-xs text-[#5b5bff]">
                        {activeGroup.name || "Listen Together"}
                    </h3>
                    {isMobile && (
                        <button
                            onClick={handleClose}
                            className="text-gray-400 hover:text-white transition-colors p-0.5"
                            aria-label="Close group info"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>

                {/* Member list */}
                <div className="space-y-1.5">
                    {sortedMembers.map((member) => (
                        <div
                            key={member.userId}
                            className="flex items-center justify-between gap-2"
                        >
                            <div className="flex items-center gap-1.5 min-w-0">
                                {member.isHost && (
                                    <Crown className="w-3 h-3 text-amber-400 shrink-0" />
                                )}
                                <span className="text-sm text-white truncate">
                                    {member.username}
                                </span>
                            </div>
                            {member.isConnected ? (
                                <Wifi className="w-3 h-3 text-emerald-400 shrink-0" />
                            ) : (
                                <WifiOff className="w-3 h-3 text-gray-500 shrink-0" />
                            )}
                        </div>
                    ))}
                </div>

                {/* Footer link */}
                <Link
                    href="/listen-together"
                    prefetch={false}
                    className="block mt-3 pt-2 border-t border-white/10 text-[11px] text-gray-400 hover:text-[#5b5bff] transition-colors text-center"
                >
                    Go to Listen Together
                </Link>
            </div>
        </div>
    );
});

export { SyncBadge };
