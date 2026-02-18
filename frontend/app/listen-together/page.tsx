"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import {
    Radio,
    Users,
    Copy,
    LogOut,
    Crown,
    Trash2,
    Globe,
    Lock,
    Wifi,
    WifiOff,
    Music,
    AlertTriangle,
    RefreshCw,
    Disc3,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useListenTogether } from "@/lib/listen-together-context";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { EqBars } from "@/components/ui/EqBars";
import { PageHeader } from "@/components/layout/PageHeader";
import { cn } from "@/utils/cn";
import type { SyncQueueItem } from "@/lib/listen-together-socket";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiscoverableGroup {
    id: string;
    name: string;
    joinCode: string;
    groupType: "host-follower";
    visibility: "public" | "private";
    host: { id: string; username: string };
    memberCount: number;
    isMember: boolean;
    isPlaying: boolean;
    currentTrack: { id: string; title: string; artistName: string } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ViewState = "lobby" | "active";

function CoverThumb({
    coverArt,
    title,
    size = 36,
    className,
}: {
    coverArt: string | null;
    title: string;
    size?: number;
    className?: string;
}) {
    const [hasError, setHasError] = useState(false);
    const imgSrc = coverArt ? api.getCoverArtUrl(coverArt) : null;

    if (!imgSrc || hasError) {
        return (
            <div
                className={cn(
                    "flex items-center justify-center bg-[#1a1a1a] rounded flex-shrink-0",
                    className
                )}
                style={{ width: size, height: size }}
            >
                <Disc3
                    className="text-[#525252]"
                    style={{ width: size * 0.45, height: size * 0.45 }}
                />
            </div>
        );
    }

    return (
        <div
            className={cn("relative overflow-hidden bg-[#1a1a1a] rounded flex-shrink-0", className)}
            style={{ width: size, height: size }}
        >
            <Image
                src={imgSrc}
                alt={title}
                fill
                sizes={`${size}px`}
                className="object-cover"
                unoptimized
                onError={() => setHasError(true)}
            />
        </div>
    );
}

const fadeSlide = {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -8 },
    transition: { duration: 0.2, ease: "easeOut" as const },
};

// ---------------------------------------------------------------------------
// Lobby -- Create / Join / Discover
// ---------------------------------------------------------------------------

function LobbyView() {
    const {
        createGroup,
        joinGroup,
        error,
        clearError,
        socketRouteStatus,
        socketRouteError,
        canUseListenTogether,
        recheckSocketRoute,
    } = useListenTogether();

    const [joinCode, setJoinCode] = useState("");
    const [groupName, setGroupName] = useState("");
    const [isPublic, setIsPublic] = useState(true);
    const [useCurrentQueue, setUseCurrentQueue] = useState(true);
    const [isCreating, setIsCreating] = useState(false);
    const [isJoining, setIsJoining] = useState(false);
    const [discoverGroups, setDiscoverGroups] = useState<DiscoverableGroup[]>(
        []
    );
    const [isLoadingDiscover, setIsLoadingDiscover] = useState(false);
    const routeChecking = socketRouteStatus === "checking";
    const routeBlocked = socketRouteStatus === "failed";

    // Fetch discoverable groups
    const fetchDiscover = useCallback(async (silent: boolean = false) => {
        if (!silent) setIsLoadingDiscover(true);
        try {
            const groups = await api.discoverListenGroups();
            setDiscoverGroups(Array.isArray(groups) ? groups : []);
        } catch {
            // Silently fail -- discovery is optional
        } finally {
            if (!silent) setIsLoadingDiscover(false);
        }
    }, []);

    useEffect(() => {
        fetchDiscover();
        const interval = setInterval(() => {
            void fetchDiscover(true);
        }, 5000);
        return () => clearInterval(interval);
    }, [fetchDiscover]);

    const handleCreate = async () => {
        if (!canUseListenTogether) {
            toast.error(
                socketRouteError ??
                    "Listen Together socket route is not configured"
            );
            return;
        }
        setIsCreating(true);
        clearError();
        await createGroup({
            name: groupName.trim() || undefined,
            visibility: isPublic ? "public" : "private",
            useCurrentQueue,
        });
        setIsCreating(false);
    };

    const handleJoin = async () => {
        if (!canUseListenTogether) {
            toast.error(
                socketRouteError ??
                    "Listen Together socket route is not configured"
            );
            return;
        }
        if (!joinCode.trim()) return;
        setIsJoining(true);
        clearError();
        await joinGroup(joinCode.trim());
        setIsJoining(false);
    };

    const handleJoinById = async (groupId: string) => {
        if (!canUseListenTogether) {
            toast.error(
                socketRouteError ??
                    "Listen Together socket route is not configured"
            );
            return;
        }
        setIsJoining(true);
        clearError();
        try {
            const group = discoverGroups.find((g) => g.id === groupId);
            if (!group) return;
            await joinGroup(group.joinCode);
        } finally {
            setIsJoining(false);
        }
    };

    return (
        <motion.div className="space-y-8" {...fadeSlide}>
            {/* Route warnings */}
            {routeBlocked && (
                <div className="flex items-start gap-3 px-4 py-3 bg-red-500/5 border border-red-500/20 rounded-lg">
                    <AlertTriangle className="mt-0.5 h-4 w-4 text-red-400 flex-shrink-0" />
                    <div className="min-w-0">
                        <p className="text-sm font-medium text-red-300">
                            Listen Together is unavailable
                        </p>
                        <p className="mt-1 text-sm text-red-200/80">
                            {socketRouteError}
                        </p>
                        <p className="mt-1.5 text-xs text-red-200/60">
                            Ensure{" "}
                            <code className="font-mono">
                                /socket.io/listen-together
                            </code>{" "}
                            reaches backend Socket.IO. See{" "}
                            <code className="font-mono">
                                docs/REVERSE_PROXY_AND_TUNNELS.md
                            </code>
                            .
                        </p>
                        <Button
                            variant="ghost"
                            className="mt-2 text-xs border border-red-400/30 text-red-200 hover:bg-red-500/10"
                            onClick={() => {
                                void recheckSocketRoute();
                            }}
                        >
                            <RefreshCw className="mr-1.5 h-3 w-3" />
                            Re-check
                        </Button>
                    </div>
                </div>
            )}

            {routeChecking && !routeBlocked && (
                <div className="flex items-center gap-2 text-sm text-[#a3a3a3] px-1">
                    <Wifi className="h-3.5 w-3.5 animate-pulse text-[#3b82f6]" />
                    Verifying socket route...
                </div>
            )}

            {/* Main grid */}
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] gap-8 items-start">
                {/* Left column: Create + Join */}
                <div className="space-y-8">
                    {/* Create a Group */}
                    <section>
                        <h3 className="text-sm font-medium text-white mb-1">
                            Create a Group
                        </h3>
                        <p className="text-xs text-[#737373] mb-4">
                            Start a session and invite friends
                        </p>

                        <div className="space-y-3">
                            <Input
                                placeholder="Group name (optional)"
                                value={groupName}
                                onChange={(e) => setGroupName(e.target.value)}
                            />

                            <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-[#0f0f0f] border border-[#1c1c1c]">
                                <div className="flex items-center gap-2">
                                    {isPublic ? (
                                        <Globe className="w-4 h-4 text-[#3b82f6]" />
                                    ) : (
                                        <Lock className="w-4 h-4 text-[#525252]" />
                                    )}
                                    <span className="text-sm text-[#e5e5e5]">
                                        {isPublic
                                            ? "Public Group"
                                            : "Private Group"}
                                    </span>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setIsPublic((prev) => !prev)}
                                    role="switch"
                                    aria-checked={isPublic}
                                    className={cn(
                                        "relative h-6 w-11 rounded-full transition-colors",
                                        isPublic
                                            ? "bg-[#3b82f6]"
                                            : "bg-[#3a3a3a]"
                                    )}
                                >
                                    <span
                                        className={cn(
                                            "absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all",
                                            isPublic
                                                ? "left-[22px]"
                                                : "left-0.5"
                                        )}
                                    />
                                </button>
                            </div>

                            <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-[#0f0f0f] border border-[#1c1c1c]">
                                <div className="flex items-center gap-2">
                                    <Music className="w-4 h-4 text-[#3b82f6]" />
                                    <span className="text-sm text-[#e5e5e5]">
                                        Use current queue
                                    </span>
                                </div>
                                <button
                                    type="button"
                                    onClick={() =>
                                        setUseCurrentQueue((prev) => !prev)
                                    }
                                    role="switch"
                                    aria-checked={useCurrentQueue}
                                    className={cn(
                                        "relative h-6 w-11 rounded-full transition-colors",
                                        useCurrentQueue
                                            ? "bg-[#3b82f6]"
                                            : "bg-[#3a3a3a]"
                                    )}
                                >
                                    <span
                                        className={cn(
                                            "absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all",
                                            useCurrentQueue
                                                ? "left-[22px]"
                                                : "left-0.5"
                                        )}
                                    />
                                </button>
                            </div>

                            <button
                                className="w-full inline-flex items-center justify-center rounded-sm font-medium px-4 py-2.5 transition-colors bg-[#60a5fa] hover:bg-[#3b82f6] text-black shadow-lg shadow-[#3b82f6]/10 disabled:opacity-50 disabled:cursor-not-allowed"
                                onClick={handleCreate}
                                disabled={
                                    isCreating ||
                                    !canUseListenTogether ||
                                    routeChecking
                                }
                            >
                                {isCreating ? (
                                    <GradientSpinner size="sm" className="mr-2" />
                                ) : (
                                    <Radio className="w-4 h-4 mr-2" />
                                )}
                                Create Group
                            </button>
                        </div>
                    </section>

                    {/* Join a Group */}
                    <section>
                        <h3 className="text-sm font-medium text-white mb-1">
                            Join a Group
                        </h3>
                        <p className="text-xs text-[#737373] mb-4">
                            Enter an invite code to join
                        </p>

                        <div className="flex flex-col sm:flex-row gap-3">
                            <Input
                                placeholder="Enter join code"
                                value={joinCode}
                                onChange={(e) =>
                                    setJoinCode(e.target.value.toUpperCase())
                                }
                                onKeyDown={(e) =>
                                    e.key === "Enter" && handleJoin()
                                }
                                className="font-mono tracking-wider text-center uppercase"
                            />
                            <button
                                className="sm:min-w-[120px] inline-flex items-center justify-center rounded-sm font-medium px-4 py-2.5 transition-colors bg-[#60a5fa] hover:bg-[#3b82f6] text-black shadow-lg shadow-[#3b82f6]/10 disabled:opacity-50 disabled:cursor-not-allowed"
                                onClick={handleJoin}
                                disabled={
                                    isJoining ||
                                    !joinCode.trim() ||
                                    !canUseListenTogether ||
                                    routeChecking
                                }
                            >
                                {isJoining && (
                                    <GradientSpinner size="sm" className="mr-2" />
                                )}
                                Join
                            </button>
                        </div>

                        {error && (
                            <p className="text-sm text-red-400 mt-2">{error}</p>
                        )}
                    </section>
                </div>

                {/* Right column: Public Groups */}
                <section>
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <h3 className="text-sm font-medium text-white mb-0.5">
                                Public Groups
                            </h3>
                            <p className="text-xs text-[#737373]">
                                Join an open session
                            </p>
                        </div>
                        <button
                            onClick={() => {
                                void fetchDiscover(false);
                            }}
                            disabled={isLoadingDiscover}
                            className="p-1.5 text-[#525252] hover:text-white hover:bg-white/5 rounded-md transition-colors disabled:opacity-50"
                        >
                            {isLoadingDiscover ? (
                                <GradientSpinner size="sm" />
                            ) : (
                                <RefreshCw className="w-4 h-4" />
                            )}
                        </button>
                    </div>

                    {isLoadingDiscover ? (
                        <div className="flex justify-center py-12">
                            <GradientSpinner size="md" />
                        </div>
                    ) : discoverGroups.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-14 text-center">
                            <div className="w-14 h-14 mx-auto mb-3 rounded-full bg-gradient-to-br from-[#3b82f6]/10 to-amber-600/10 flex items-center justify-center">
                                <Users className="w-6 h-6 text-[#525252]" />
                            </div>
                            <p className="text-sm text-[#525252]">
                                No public groups right now
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-1 max-h-[55vh] overflow-y-auto pr-1">
                            {discoverGroups.map((group) => (
                                <button
                                    key={group.id}
                                    onClick={() => handleJoinById(group.id)}
                                    disabled={
                                        isJoining ||
                                        !canUseListenTogether ||
                                        routeChecking
                                    }
                                    className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-[#141414] transition-colors text-left group"
                                >
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className="w-8 h-8 rounded-full bg-[#3b82f6]/10 flex items-center justify-center flex-shrink-0">
                                            <Users className="w-3.5 h-3.5 text-[#3b82f6]" />
                                        </div>
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium text-white truncate">
                                                {group.name}
                                            </p>
                                            <p className="text-xs text-[#525252]">
                                                {group.memberCount} listener
                                                {group.memberCount === 1
                                                    ? ""
                                                    : "s"}
                                                {group.currentTrack && (
                                                    <span className="text-[#737373]">
                                                        {" "}
                                                        &middot;{" "}
                                                        {
                                                            group.currentTrack
                                                                .title
                                                        }
                                                    </span>
                                                )}
                                            </p>
                                        </div>
                                    </div>
                                    <span className="text-xs text-[#525252] opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                                        Join
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </motion.div>
    );
}

// ---------------------------------------------------------------------------
// Active Group View -- Queue, Members, Controls
// ---------------------------------------------------------------------------

function ActiveGroupView() {
    const {
        activeGroup,
        isHost,
        canEditQueue,
        canControl,
        isConnected,
        hasConnectedOnce,
        reconnectAttempt,
        socketRouteStatus,
        socketRouteError,
        recheckSocketRoute,
        leaveGroup,
        syncSetTrack,
        syncRemoveFromQueue,
        syncClearQueue,
    } = useListenTogether();

    if (!activeGroup) return null;
    const routeBlocked = socketRouteStatus === "failed";

    const { name, joinCode } = activeGroup;
    const members = activeGroup.members ?? [];
    const playback = activeGroup.playback ?? {
        queue: [],
        currentIndex: 0,
        isPlaying: false,
        positionMs: 0,
        serverTime: 0,
        stateVersion: 0,
        trackId: null,
    };
    const currentTrack = playback.queue?.[playback.currentIndex] ?? null;

    const copyCode = () => {
        navigator.clipboard
            .writeText(joinCode)
            .then(() => {
                toast.success("Join code copied!");
            })
            .catch(() => {
                toast.error("Failed to copy");
            });
    };

    return (
        <motion.div className="space-y-6" {...fadeSlide}>
            {/* Route error */}
            {routeBlocked && (
                <div className="flex items-start gap-3 px-4 py-3 bg-red-500/5 border border-red-500/20 rounded-lg">
                    <AlertTriangle className="mt-0.5 h-4 w-4 text-red-400 flex-shrink-0" />
                    <div>
                        <p className="text-sm font-medium text-red-300">
                            Socket route lost
                        </p>
                        <p className="mt-1 text-sm text-red-200/80">
                            {socketRouteError}
                        </p>
                        <Button
                            variant="ghost"
                            className="mt-2 text-xs border border-red-400/30 text-red-200 hover:bg-red-500/10"
                            onClick={() => {
                                void recheckSocketRoute();
                            }}
                        >
                            <RefreshCw className="mr-1.5 h-3 w-3" />
                            Re-check
                        </Button>
                    </div>
                </div>
            )}

            {/* Group header */}
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div className="flex items-start gap-3 min-w-0">
                    {/* Now playing cover art or fallback icon */}
                    {currentTrack?.album?.coverArt ? (
                        <CoverThumb
                            coverArt={currentTrack.album.coverArt}
                            title={currentTrack.title}
                            size={48}
                            className="rounded-lg"
                        />
                    ) : (
                        <div className="w-12 h-12 rounded-lg bg-[#3b82f6]/10 flex items-center justify-center flex-shrink-0">
                            <Radio className="w-5 h-5 text-[#3b82f6]" />
                        </div>
                    )}
                    <div className="min-w-0">
                        <h2 className="text-lg font-semibold text-white truncate">
                            {name}
                        </h2>
                        <div className="flex items-center gap-2 mt-0.5">
                            <Badge variant="ai">
                                {isHost ? "Host" : "Follower"}
                            </Badge>
                            <span className="flex items-center gap-1 text-xs text-[#525252]">
                                {routeBlocked ? (
                                    <>
                                        <WifiOff className="w-3 h-3 text-red-500" />{" "}
                                        Route needed
                                    </>
                                ) : isConnected ? (
                                    <>
                                        <Wifi className="w-3 h-3 text-green-500" />{" "}
                                        Connected
                                    </>
                                ) : hasConnectedOnce ? (
                                    <>
                                        <WifiOff className="w-3 h-3 text-red-500" />{" "}
                                        Reconnecting{reconnectAttempt > 0 ? ` (${reconnectAttempt})` : "..."}
                                    </>
                                ) : (
                                    <>
                                        <Wifi className="w-3 h-3 text-[#3b82f6] animate-pulse" />{" "}
                                        Connecting...
                                    </>
                                )}
                            </span>
                        </div>
                        {currentTrack ? (
                            <p className="mt-1.5 text-sm text-[#a3a3a3] truncate">
                                {currentTrack.title}{" "}
                                <span className="text-[#525252]">
                                    &middot; {currentTrack.artist.name}
                                </span>
                            </p>
                        ) : (
                            <p className="mt-1.5 text-sm text-[#525252]">
                                Nothing playing yet
                            </p>
                        )}
                    </div>
                </div>

                <button
                    onClick={copyCode}
                    className="flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-[#0f0f0f] border border-[#1c1c1c] hover:border-[#3b82f6]/30 transition-colors self-start md:self-center"
                    title="Copy join code"
                >
                    <span className="font-mono text-sm font-bold text-[#3b82f6] tracking-widest">
                        {joinCode}
                    </span>
                    <Copy className="w-3.5 h-3.5 text-[#525252]" />
                </button>
            </div>

            {/* Separator */}
            <div className="h-px bg-[#1c1c1c]" />

            {/* Queue + Members grid */}
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] gap-6 items-start">
                {/* Queue */}
                <section>
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-xs font-medium text-[#737373] uppercase tracking-wider">
                            Queue ({playback.queue.length})
                        </h3>
                        {canEditQueue && playback.queue.length > 0 && (
                            <button
                                className="flex items-center gap-1 text-xs text-[#525252] hover:text-white transition-colors"
                                onClick={syncClearQueue}
                            >
                                <Trash2 className="w-3 h-3" />
                                Clear
                            </button>
                        )}
                    </div>

                    {playback.queue.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 text-center">
                            <div className="w-14 h-14 mb-3 rounded-full bg-gradient-to-br from-[#3b82f6]/10 to-amber-600/10 flex items-center justify-center">
                                <Music className="w-6 h-6 text-[#525252]" />
                            </div>
                            <p className="text-sm text-[#525252]">
                                Queue is empty
                            </p>
                            <p className="text-xs text-[#3f3f3f] mt-1">
                                Add tracks from your library
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-0.5 max-h-[58vh] overflow-y-auto pr-1">
                            {playback.queue.map(
                                (item: SyncQueueItem, idx: number) => (
                                    <QueueItem
                                        key={`${item.id}-${idx}`}
                                        item={item}
                                        index={idx}
                                        isCurrentTrack={
                                            idx === playback.currentIndex
                                        }
                                        canStartPlayback={canControl}
                                        canRemove={canEditQueue}
                                        onPlay={() => syncSetTrack(idx)}
                                        onRemove={() =>
                                            syncRemoveFromQueue(idx)
                                        }
                                    />
                                )
                            )}
                        </div>
                    )}
                </section>

                {/* Members + Leave */}
                <div className="space-y-6">
                    <section>
                        <h3 className="text-xs font-medium text-[#737373] uppercase tracking-wider mb-3">
                            Listeners ({members.length})
                        </h3>
                        <div className="space-y-1">
                            {members.map((member) => (
                                <div
                                    key={member.userId}
                                    className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-[#141414] transition-colors"
                                >
                                    <div className="flex items-center gap-3">
                                        <div className="w-7 h-7 rounded-full bg-[#3b82f6]/10 flex items-center justify-center">
                                            <span className="text-[10px] font-bold text-[#3b82f6]">
                                                {member.username?.[0]?.toUpperCase() ??
                                                    "?"}
                                            </span>
                                        </div>
                                        <span className="text-sm text-white">
                                            {member.username}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {member.isHost && (
                                            <Badge variant="ai">
                                                <Crown className="w-3 h-3 mr-1" />
                                                Host
                                            </Badge>
                                        )}
                                        <span
                                            className={cn(
                                                "w-2 h-2 rounded-full",
                                                member.isConnected
                                                    ? "bg-green-500"
                                                    : "bg-[#525252]"
                                            )}
                                            title={
                                                member.isConnected
                                                    ? "Connected"
                                                    : "Disconnected"
                                            }
                                        />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>

                    <Button
                        variant="danger"
                        className="w-full"
                        onClick={leaveGroup}
                    >
                        <LogOut className="w-4 h-4 mr-2" />
                        Leave Group
                    </Button>
                </div>
            </div>
        </motion.div>
    );
}

// ---------------------------------------------------------------------------
// Queue Item
// ---------------------------------------------------------------------------

function QueueItem({
    item,
    index,
    isCurrentTrack,
    canStartPlayback,
    canRemove,
    onPlay,
    onRemove,
}: {
    item: SyncQueueItem;
    index: number;
    isCurrentTrack: boolean;
    canStartPlayback: boolean;
    canRemove: boolean;
    onPlay: () => void;
    onRemove: () => void;
}) {
    return (
        <div
            className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg transition-colors group",
                isCurrentTrack
                    ? "bg-[#3b82f6]/8 border-l-2 border-[#3b82f6]"
                    : "hover:bg-[#141414]"
            )}
        >
            {/* Track Number / EQ / Play */}
            <div className="w-6 flex items-center justify-center flex-shrink-0">
                {isCurrentTrack ? (
                    <EqBars />
                ) : canStartPlayback ? (
                    <button
                        onClick={onPlay}
                        className="text-[#525252] group-hover:text-white transition-colors"
                    >
                        <span className="text-xs">{index + 1}</span>
                    </button>
                ) : (
                    <span className="text-xs text-[#525252]">{index + 1}</span>
                )}
            </div>

            {/* Cover Art */}
            <CoverThumb
                coverArt={item.album.coverArt}
                title={item.title}
                size={36}
                className="rounded"
            />

            {/* Track Info */}
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <p
                        className={cn(
                            "text-sm truncate",
                            isCurrentTrack
                                ? "text-[#3b82f6] font-medium"
                                : "text-white"
                        )}
                    >
                        {item.title}
                    </p>
                    {isCurrentTrack && (
                        <Badge variant="warning" className="flex-shrink-0 text-[10px] px-1.5 py-0">
                            Now Playing
                        </Badge>
                    )}
                </div>
                <p className="text-xs text-[#525252] truncate">
                    {item.artist.name} &middot; {item.album.title}
                </p>
            </div>

            {/* Duration */}
            <span className="text-xs text-[#525252] flex-shrink-0 tabular-nums">
                {formatDuration(item.duration)}
            </span>

            {/* Remove */}
            {canRemove && (
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onRemove();
                    }}
                    className="opacity-0 group-hover:opacity-100 text-[#525252] hover:text-red-400 transition-all flex-shrink-0"
                    title="Remove from queue"
                >
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            )}
        </div>
    );
}

function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ListenTogetherPage() {
    const router = useRouter();
    const { isAuthenticated, isLoading: authLoading } = useAuth();
    const { isInGroup, isLoading } = useListenTogether();

    // Auth guard
    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/login");
        }
    }, [authLoading, isAuthenticated, router]);

    // Derive view from group membership
    const view: ViewState = isInGroup ? "active" : "lobby";

    if (authLoading || !isAuthenticated) return null;

    return (
        <div className="min-h-screen relative">
            {/* Ambient background */}
            <div className="fixed inset-0 pointer-events-none overflow-hidden">
                <div className="absolute -top-20 -right-20 w-[600px] h-[600px] rounded-full bg-[#3b82f6]/8 blur-[140px]" />
                <div className="absolute -bottom-40 -left-40 w-[400px] h-[400px] rounded-full bg-[#1d4ed8]/6 blur-[100px]" />
            </div>
            <div className="absolute inset-x-0 top-0 h-[220px] bg-gradient-to-b from-[#3b82f6]/12 via-[#1d4ed8]/6 to-transparent pointer-events-none" />

            {/* Content */}
            <div className="relative px-4 md:px-8 py-6 pb-32">
                <PageHeader
                    title="Listen Together"
                    subtitle="Sync your music with friends in real-time"
                    icon={Users}
                    className="mb-6"
                />
                <AnimatePresence mode="wait">
                    {isLoading ? (
                        <motion.div
                            key="loading"
                            className="flex flex-col items-center justify-center py-24"
                            {...fadeSlide}
                        >
                            <GradientSpinner size="lg" />
                            <p className="text-sm text-[#525252] mt-4">
                                Loading...
                            </p>
                        </motion.div>
                    ) : view === "active" ? (
                        <ActiveGroupView key="active" />
                    ) : (
                        <LobbyView key="lobby" />
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
}
