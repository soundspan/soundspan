"use client";

import Image from "next/image";
import Link from "next/link";
import { Music2, Users, Radio } from "lucide-react";
import { cn } from "@/utils/cn";
import {
    useSocialPresence,
    type SocialOnlineUser,
} from "@/hooks/useSocialPresence";
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

function getListeningStatusDisplay(status: SocialOnlineUser["listeningStatus"]) {
    switch (status) {
        case "playing":
            return {
                label: "Playing",
                badgeClass: "text-green-300 border-green-400/30 bg-green-400/10",
                dotClass: "bg-green-400",
            };
        case "paused":
            return {
                label: "Paused",
                badgeClass: "text-amber-300 border-amber-400/30 bg-amber-400/10",
                dotClass: "bg-amber-400",
            };
        case "idle":
        default:
            return {
                label: "Idle",
                badgeClass: "text-white/50 border-white/15 bg-white/5",
                dotClass: "bg-white/40",
            };
    }
}

interface SocialTabProps {
    users?: SocialOnlineUser[];
    isLoading?: boolean;
    error?: unknown;
    queryEnabled?: boolean;
}

export function SocialTab({
    users: usersProp,
    isLoading: isLoadingProp,
    error: errorProp,
    queryEnabled = true,
}: SocialTabProps = {}) {
    const socialQuery = useSocialPresence({ enabled: queryEnabled });
    const users = usersProp ?? socialQuery.users;
    const isLoading = isLoadingProp ?? socialQuery.isLoading;
    const error = errorProp ?? socialQuery.error;
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
                {users.map((user) => {
                    const listeningStatus = getListeningStatusDisplay(
                        user.listeningStatus
                    );
                    const track = user.listeningTrack;
                    const showTrack =
                        user.listeningStatus !== "idle" && Boolean(track);
                    const songHref =
                        showTrack && track?.albumId
                            ? `/album/${encodeURIComponent(track.albumId)}`
                            : null;
                    const artistHref =
                        showTrack && track?.artistId
                            ? `/artist/${encodeURIComponent(track.artistId)}`
                            : null;

                    return (
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
                                        <span
                                            className={cn(
                                                "inline-flex items-center gap-1 text-[10px] uppercase tracking-wide rounded border px-1.5 py-0.5",
                                                listeningStatus.badgeClass
                                            )}
                                            title={`Listening status: ${listeningStatus.label}`}
                                        >
                                            <span
                                                className={cn(
                                                    "w-1.5 h-1.5 rounded-full",
                                                    listeningStatus.dotClass
                                                )}
                                            />
                                            {listeningStatus.label}
                                        </span>
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

                                    {showTrack && track ? (
                                        <p className="text-xs text-[#3b82f6] truncate mt-1 flex items-center gap-1.5">
                                            {track.coverArt ? (
                                                <span className="relative w-3.5 h-3.5 shrink-0 overflow-hidden rounded-[2px]">
                                                    <Image
                                                        src={api.getCoverArtUrl(
                                                            track.coverArt,
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
                                                {songHref ? (
                                                    <Link
                                                        href={songHref}
                                                        className="hover:underline"
                                                    >
                                                        {track.title}
                                                    </Link>
                                                ) : (
                                                    track.title
                                                )}
                                            </span>
                                            <span className="text-white/40 shrink-0">
                                                •
                                            </span>
                                            <span className="text-white/60 truncate">
                                                {artistHref ? (
                                                    <Link
                                                        href={artistHref}
                                                        className="hover:underline"
                                                    >
                                                        {track.artistName}
                                                    </Link>
                                                ) : (
                                                    track.artistName
                                                )}
                                            </span>
                                        </p>
                                    ) : (
                                        <p className="text-xs text-white/35 mt-1 flex items-center gap-1.5">
                                            <span className="w-2 h-2 rounded-full bg-white/40 shrink-0" />
                                            Not currently playing
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
                    );
                })}
            </div>
        </div>
    );
}
