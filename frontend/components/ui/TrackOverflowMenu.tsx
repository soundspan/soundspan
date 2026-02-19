"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
    EllipsisVertical,
    ListEnd,
    ListPlus,
    Plus,
    User,
    Disc3,
    AudioWaveform,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAudioState, Track } from "@/lib/audio-state-context";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { getArtistHref } from "@/utils/artistRoute";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/api";

interface TrackOverflowMenuProps {
    track: Track;
    /** Feature flags for which menu items to show */
    showPlayNext?: boolean;
    showAddToQueue?: boolean;
    showAddToPlaylist?: boolean;
    showGoToArtist?: boolean;
    showGoToAlbum?: boolean;
    showMatchVibe?: boolean;
    /** Extra menu items injected before/after the standard items */
    extraItemsBefore?: React.ReactNode;
    extraItemsAfter?: React.ReactNode;
    /** Styling */
    className?: string;
    triggerClassName?: string;
    /** Listen Together guard */
    isInListenTogetherGroup?: boolean;
}

export function TrackOverflowMenu({
    track,
    showPlayNext = true,
    showAddToQueue = true,
    showAddToPlaylist = true,
    showGoToArtist = true,
    showGoToAlbum = true,
    showMatchVibe = true,
    extraItemsBefore,
    extraItemsAfter,
    className,
    triggerClassName,
    isInListenTogetherGroup = false,
}: TrackOverflowMenuProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [isPlaylistSelectorOpen, setIsPlaylistSelectorOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const router = useRouter();
    const controls = useAudioControls();
    const { playbackType } = useAudioState();

    // Determine if track is local (for Listen Together guard)
    const isStreamOnly = track.streamSource === "tidal" || track.streamSource === "youtube";
    const blockedByListenTogether = isInListenTogetherGroup && isStreamOnly;

    // Artist href
    const artistHref = track.artist
        ? getArtistHref({ id: track.artist.id, name: track.artist.name, mbid: track.artist.mbid })
        : null;

    // Album href
    const albumHref = track.album?.id ? `/album/${track.album.id}` : null;

    // Outside click and escape handlers
    useEffect(() => {
        if (!isOpen) return;

        const handleOutsideClick = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setIsOpen(false);
            }
        };

        document.addEventListener("mousedown", handleOutsideClick);
        document.addEventListener("keydown", handleEscape);

        return () => {
            document.removeEventListener("mousedown", handleOutsideClick);
            document.removeEventListener("keydown", handleEscape);
        };
    }, [isOpen]);

    const handleToggle = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setIsOpen((prev) => !prev);
    }, []);

    const closeMenu = useCallback(() => setIsOpen(false), []);

    const handlePlayNext = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            if (blockedByListenTogether) {
                toast.error("Listen Together only supports local library tracks");
                closeMenu();
                return;
            }
            controls.playNext(track);
            closeMenu();
        },
        [track, controls, blockedByListenTogether, closeMenu]
    );

    const handleAddToQueue = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            if (blockedByListenTogether) {
                toast.error("Listen Together only supports local library tracks");
                closeMenu();
                return;
            }
            controls.addToQueue(track);
            closeMenu();
        },
        [track, controls, blockedByListenTogether, closeMenu]
    );

    const handleAddToPlaylist = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            closeMenu();
            setIsPlaylistSelectorOpen(true);
        },
        [closeMenu]
    );

    const handleSelectPlaylist = useCallback(
        async (playlistId: string) => {
            await api.addTrackToPlaylist(playlistId, track.id);
            toast.success(`Added "${track.title}" to playlist`);
        },
        [track]
    );

    const handleGoToArtist = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            if (artistHref) {
                router.push(artistHref);
            }
            closeMenu();
        },
        [artistHref, router, closeMenu]
    );

    const handleGoToAlbum = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            if (albumHref) {
                router.push(albumHref);
            }
            closeMenu();
        },
        [albumHref, router, closeMenu]
    );

    const handleMatchVibe = useCallback(
        async (e: React.MouseEvent) => {
            e.stopPropagation();
            closeMenu();
            // Play the track first, then start vibe mode
            controls.playTrack(track);
            // Small delay to let the track load before starting vibe
            setTimeout(async () => {
                const result = await controls.startVibeMode();
                if (result.success) {
                    toast.success(`Match Vibe: found ${result.trackCount} similar tracks`);
                }
            }, 500);
        },
        [track, controls, closeMenu]
    );

    return (
        <>
            <div
                ref={menuRef}
                className={cn("relative flex items-center justify-center", className)}
                onClick={(e) => e.stopPropagation()}
            >
                <button
                    type="button"
                    onClick={handleToggle}
                    className={cn(
                        "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 rounded-full p-2 transition-colors",
                        isOpen
                            ? "bg-[#2a2a2a] text-white"
                            : "text-gray-400 hover:bg-[#2a2a2a] hover:text-white",
                        triggerClassName
                    )}
                    aria-label="Track actions"
                    aria-expanded={isOpen}
                    aria-haspopup="menu"
                    title="Track actions"
                >
                    <EllipsisVertical className="h-4 w-4" />
                </button>

                {isOpen && (
                    <div
                        className="absolute right-0 top-full z-30 mt-1 min-w-[180px] rounded-md border border-white/10 bg-[#111111] p-1 shadow-xl"
                        role="menu"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {extraItemsBefore}

                        {showPlayNext && (
                            <MenuButton
                                onClick={handlePlayNext}
                                disabled={blockedByListenTogether}
                                icon={<ListEnd className="h-4 w-4" />}
                                label="Play next"
                                disabledTitle="Listen Together requires local tracks"
                            />
                        )}

                        {showAddToQueue && (
                            <MenuButton
                                onClick={handleAddToQueue}
                                disabled={blockedByListenTogether}
                                icon={<ListPlus className="h-4 w-4" />}
                                label="Add to queue"
                                disabledTitle="Listen Together requires local tracks"
                            />
                        )}

                        {showAddToPlaylist && (
                            <MenuButton
                                onClick={handleAddToPlaylist}
                                icon={<Plus className="h-4 w-4" />}
                                label="Add to playlist"
                            />
                        )}

                        {showGoToArtist && artistHref && (
                            <MenuButton
                                onClick={handleGoToArtist}
                                icon={<User className="h-4 w-4" />}
                                label="Go to artist"
                            />
                        )}

                        {showGoToAlbum && albumHref && (
                            <MenuButton
                                onClick={handleGoToAlbum}
                                icon={<Disc3 className="h-4 w-4" />}
                                label="Go to album"
                            />
                        )}

                        {showMatchVibe && track.id && playbackType === "track" && (
                            <MenuButton
                                onClick={handleMatchVibe}
                                icon={<AudioWaveform className="h-4 w-4" />}
                                label="Match Vibe"
                            />
                        )}

                        {extraItemsAfter}
                    </div>
                )}
            </div>

            <PlaylistSelector
                isOpen={isPlaylistSelectorOpen}
                onClose={() => setIsPlaylistSelectorOpen(false)}
                onSelectPlaylist={handleSelectPlaylist}
            />
        </>
    );
}

/** Shared menu item button */
function MenuButton({
    onClick,
    disabled = false,
    icon,
    label,
    disabledTitle,
    className: customClassName,
}: {
    onClick: (e: React.MouseEvent) => void;
    disabled?: boolean;
    icon: React.ReactNode;
    label: string;
    disabledTitle?: string;
    className?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
                disabled
                    ? "cursor-not-allowed text-red-300/80"
                    : "text-gray-200 hover:bg-white/10 hover:text-white",
                customClassName
            )}
            role="menuitem"
            title={disabled && disabledTitle ? disabledTitle : label}
        >
            {icon}
            {label}
        </button>
    );
}

/** Re-export MenuButton for use in extraItemsBefore/After slots */
export { MenuButton as TrackMenuButton };
