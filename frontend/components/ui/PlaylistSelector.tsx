"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { X, Plus, Music2, Check } from "lucide-react";
import { GradientSpinner } from "./GradientSpinner";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

interface PlaylistSelectorProps {
    isOpen: boolean;
    onClose: () => void;
    onSelectPlaylist: (playlistId: string) => Promise<void>;
    isLoading?: boolean;
    loadingMessage?: string;
    /** When true, allow selecting multiple playlists before confirming. */
    multiSelect?: boolean;
}

/**
 * Renders the PlaylistSelector component.
 */
export function PlaylistSelector({
    isOpen,
    onClose,
    onSelectPlaylist,
    isLoading: isSaving,
    loadingMessage,
    multiSelect = false,
}: PlaylistSelectorProps) {
    const [playlists, setPlaylists] = useState<Array<{ id: string; name: string; trackCount?: number }>>([]);
    const [newPlaylistName, setNewPlaylistName] = useState("");
    const [isPublic, setIsPublic] = useState(false);
    const [isCreating, setIsCreating] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [isConfirming, setIsConfirming] = useState(false);
    const [confirmError, setConfirmError] = useState<string | null>(null);

    useEffect(() => {
        if (isOpen) {
            loadPlaylists();
            setSelectedIds(new Set());
            setConfirmError(null);
        }
    }, [isOpen]);

    const loadPlaylists = async () => {
        try {
            setIsLoading(true);
            const data = await api.getPlaylists();
            setPlaylists(Array.isArray(data) ? data : []);
        } catch (error) {
            sharedFrontendLogger.error("Failed to load playlists:", error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleCreatePlaylist = async () => {
        if (!newPlaylistName.trim()) return;

        try {
            setIsCreating(true);
            const playlist = await api.createPlaylist(
                newPlaylistName.trim(),
                isPublic
            );
            await onSelectPlaylist(playlist.id);
            setNewPlaylistName("");
            setIsPublic(false);

            window.dispatchEvent(
                new CustomEvent("playlist-created", { detail: playlist })
            );

            onClose();
        } catch (error) {
            sharedFrontendLogger.error("Failed to create playlist:", error);
        } finally {
            setIsCreating(false);
        }
    };

    const handleSelectPlaylist = async (playlistId: string) => {
        if (multiSelect) {
            setSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(playlistId)) {
                    next.delete(playlistId);
                } else {
                    next.add(playlistId);
                }
                return next;
            });
            return;
        }

        try {
            await onSelectPlaylist(playlistId);
            window.dispatchEvent(
                new CustomEvent("playlist-updated", { detail: { playlistId } })
            );
            await loadPlaylists();
            onClose();
        } catch (error) {
            sharedFrontendLogger.error("Failed to add to playlist:", error);
        }
    };

    const handleConfirmMulti = async () => {
        if (selectedIds.size === 0) return;

        setIsConfirming(true);
        setConfirmError(null);
        let failures = 0;

        for (const playlistId of selectedIds) {
            try {
                await onSelectPlaylist(playlistId);
                window.dispatchEvent(
                    new CustomEvent("playlist-updated", {
                        detail: { playlistId },
                    })
                );
            } catch (error) {
                failures++;
                sharedFrontendLogger.error(
                    `Failed to add to playlist ${playlistId}:`,
                    error
                );
            }
        }

        setIsConfirming(false);

        if (failures > 0) {
            setConfirmError(
                `Failed to add to ${failures} playlist${failures > 1 ? "s" : ""}`
            );
        } else {
            await loadPlaylists();
            onClose();
        }
    };

    if (!isOpen) return null;

    const isProcessing = isSaving || isConfirming;

    return (
        <div
            className="fixed inset-0 bg-black/80  flex items-center justify-center z-50 p-4"
            onClick={onClose}
        >
            <div
                className="bg-linear-to-b from-[#121212] to-[#121212] rounded-xl max-w-md w-full max-h-[80vh] overflow-hidden flex flex-col border border-white/10 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-6 border-b border-white/10">
                    <h2 className="text-2xl font-bold text-white">
                        Add to Playlist
                    </h2>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-white/10 rounded-full transition-colors"
                    >
                        <X className="w-5 h-5 text-gray-400" />
                    </button>
                </div>

                {isProcessing && (
                    <div className="px-6 py-3 flex items-center gap-3 bg-black/30 border-b border-white/10 text-sm text-gray-300">
                        <GradientSpinner size="sm" />
                        <span>{loadingMessage || "Adding..."}</span>
                    </div>
                )}

                {confirmError && (
                    <div className="px-6 py-3 bg-red-500/10 border-b border-red-500/20 text-sm text-red-300">
                        {confirmError}
                    </div>
                )}

                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    {isLoading ? (
                        <div className="flex items-center justify-center py-12">
                            <GradientSpinner size="md" />
                        </div>
                    ) : playlists.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-center">
                            <Music2 className="w-12 h-12 text-gray-600 mb-3" />
                            <p className="text-gray-400">No playlists yet</p>
                            <p className="text-gray-500 text-sm mt-1">
                                Create one below to get started
                            </p>
                        </div>
                    ) : (
                        playlists.map((playlist) => {
                            const isSelected = selectedIds.has(playlist.id);
                            return (
                                <button
                                    key={playlist.id}
                                    onClick={() =>
                                        handleSelectPlaylist(playlist.id)
                                    }
                                    className={`w-full text-left px-4 py-4 rounded-lg transition-all border group ${
                                        isSelected
                                            ? "bg-[#3b82f6]/10 border-[#3b82f6]/30"
                                            : "bg-white/5 hover:bg-white/10 border-white/5 hover:border-white/10"
                                    }`}
                                    disabled={isProcessing}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex-1 min-w-0">
                                            <p className={`font-semibold truncate transition-colors ${
                                                isSelected
                                                    ? "text-[#3b82f6]"
                                                    : "text-white group-hover:text-[#3b82f6]"
                                            }`}>
                                                {playlist.name}
                                            </p>
                                            <p className="text-xs text-gray-400 mt-1">
                                                {playlist.trackCount || 0}{" "}
                                                {playlist.trackCount === 1
                                                    ? "track"
                                                    : "tracks"}
                                            </p>
                                        </div>
                                        {multiSelect && isSelected ? (
                                            <div className="w-5 h-5 rounded-full bg-[#3b82f6] flex items-center justify-center ml-2 shrink-0">
                                                <Check className="w-3 h-3 text-white" />
                                            </div>
                                        ) : (
                                            <Plus className="w-5 h-5 text-gray-400 group-hover:text-[#3b82f6] transition-colors ml-2 shrink-0" />
                                        )}
                                    </div>
                                </button>
                            );
                        })
                    )}
                </div>

                {multiSelect && selectedIds.size > 0 && (
                    <div className="px-6 py-3 border-t border-white/10">
                        <button
                            onClick={() => void handleConfirmMulti()}
                            disabled={isProcessing}
                            className="w-full py-3 rounded-full font-medium bg-[#3b82f6] text-black hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                        >
                            {isConfirming ? (
                                <>
                                    <GradientSpinner size="sm" />
                                    Adding...
                                </>
                            ) : (
                                `Add to ${selectedIds.size} Playlist${selectedIds.size > 1 ? "s" : ""}`
                            )}
                        </button>
                    </div>
                )}

                <div className="p-6 border-t border-white/10 bg-[#0a0a0a]/50">
                    <p className="text-sm text-gray-400 mb-3 font-medium">
                        Create New Playlist
                    </p>
                    <div className="flex gap-2 mb-3">
                        <input
                            type="text"
                            placeholder="Enter playlist name..."
                            value={newPlaylistName}
                            onChange={(e) => setNewPlaylistName(e.target.value)}
                            onKeyDown={(e) =>
                                e.key === "Enter" && handleCreatePlaylist()
                            }
                            className="flex-1 px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-[#3b82f6] focus:bg-white/10 transition-all"
                        />
                        <button
                            onClick={handleCreatePlaylist}
                            disabled={
                                !newPlaylistName.trim() ||
                                isCreating ||
                                isProcessing
                            }
                            className="px-5 py-3 bg-[#60a5fa] hover:bg-[#3b82f6] disabled:bg-gray-700 disabled:cursor-not-allowed text-black font-bold rounded-lg transition-all flex items-center gap-2 disabled:text-gray-500"
                        >
                            <Plus className="w-5 h-5" />
                            <span className="hidden sm:inline">Create</span>
                        </button>
                    </div>
                    <label className="flex items-center gap-3 cursor-pointer group">
                        <div className="relative">
                            <input
                                type="checkbox"
                                checked={isPublic}
                                onChange={(e) => setIsPublic(e.target.checked)}
                                className="sr-only peer"
                            />
                            <div className="w-10 h-5 bg-white/10 rounded-full peer-checked:bg-[#3b82f6] transition-colors" />
                            <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-5" />
                        </div>
                        <span className="text-sm text-gray-400 group-hover:text-gray-300 transition-colors">
                            Share with other users
                        </span>
                    </label>
                </div>
            </div>
        </div>
    );
}
