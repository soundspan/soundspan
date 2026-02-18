"use client";

import Image from "next/image";
import { Music2, Users, Radio } from "lucide-react";
import { cn } from "@/utils/cn";
import { useSocialPresence } from "@/hooks/useSocialPresence";
import { api } from "@/lib/api";

function formatLastSeen(isoDate: string): string {
    const parsed = Date.parse(isoDate);
    if (Number.isNaN(parsed)) return "online";

    const diffMs = Date.now() - parsed;
    if (diffMs < 60_000) return "now";
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m`;
    if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h`;
    return "today";
}

export function SocialTab() {
    const { users, isLoading, error } = useSocialPresence();
    const hasUsers = users.length > 0;
    const showLoadingState = isLoading && !hasUsers;
    const showUnavailableState = Boolean(error) && !hasUsers;

    if (showLoadingState) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
            </div>
        );
    }

    if (showUnavailableState) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center px-6">
                <Users className="w-8 h-8 text-white/20 mb-3" />
                <p className="text-sm text-white/40">Social status unavailable</p>
                <p className="text-xs text-white/30 mt-1">
                    Presence data could not be loaded right now.
                </p>
            </div>
        );
    }

    if (!hasUsers) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center">
                <Users className="w-8 h-8 text-white/20 mb-3" />
                <p className="text-sm text-white/40">No one online</p>
                <p className="text-xs text-white/30 mt-1">
                    Users sharing presence will appear here.
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <span
                    className="text-xs text-white/40"
                    role="status"
                    aria-live="polite"
                >
                    {users.length} online
                </span>
                <span className="text-xs text-green-400 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                    Live
                </span>
            </div>

            <div
                className="flex-1 overflow-y-auto"
                role="list"
                aria-label="Online users sharing presence"
            >
                {users.map((user) => (
                    <div
                        key={user.id}
                        role="listitem"
                        tabIndex={0}
                        className="px-3 py-3 border-b border-white/5 hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#3b82f6]/50 focus-visible:bg-white/5"
                    >
                        <div className="flex items-start gap-3">
                            <div className="w-8 h-8 rounded-full bg-white/10 text-white/80 text-xs font-semibold flex items-center justify-center shrink-0">
                                {user.displayName.charAt(0).toUpperCase()}
                            </div>

                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                    <p className="text-sm font-medium text-white truncate">
                                        {user.displayName}
                                    </p>
                                    {user.isInListenTogetherGroup && (
                                        <span
                                            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-[#3b82f6] bg-[#3b82f6]/10 border border-[#3b82f6]/25 rounded px-1.5 py-0.5"
                                            title="In a Listen Together session"
                                        >
                                            <Radio className="w-3 h-3" />
                                            Listen Together
                                        </span>
                                    )}
                                </div>

                                {user.displayName !== user.username && (
                                    <p className="text-xs text-white/40 truncate">
                                        @{user.username}
                                    </p>
                                )}

                                {user.listeningTrack ? (
                                    <p className="text-xs text-[#3b82f6] truncate mt-1 flex items-center gap-1.5">
                                        {user.listeningTrack.coverArt ? (
                                            <span className="relative w-3.5 h-3.5 shrink-0 overflow-hidden rounded-[2px]">
                                                <Image
                                                    src={api.getCoverArtUrl(
                                                        user.listeningTrack
                                                            .coverArt,
                                                        32
                                                    )}
                                                    alt=""
                                                    fill
                                                    sizes="14px"
                                                    className="object-cover"
                                                    unoptimized
                                                />
                                            </span>
                                        ) : (
                                            <Music2 className="w-3 h-3 shrink-0" />
                                        )}
                                        <span className="truncate">
                                            {user.listeningTrack.title}
                                        </span>
                                        <span className="text-white/40 shrink-0">
                                            •
                                        </span>
                                        <span className="text-white/60 truncate">
                                            {user.listeningTrack.artistName}
                                        </span>
                                    </p>
                                ) : (
                                    <p className="text-xs text-white/35 mt-1 flex items-center gap-1.5">
                                        <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
                                        Online
                                    </p>
                                )}
                            </div>

                            <div
                                className={cn(
                                    "text-[11px] text-white/30 shrink-0 pt-0.5",
                                    user.listeningTrack && "text-white/40"
                                )}
                                title={new Date(user.lastHeartbeatAt).toLocaleString()}
                            >
                                {formatLastSeen(user.lastHeartbeatAt)}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
