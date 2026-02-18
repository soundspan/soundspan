"use client";

import { ExternalLink, Trash2, Plus, Loader2 } from "lucide-react";
import type { ColorPalette } from "@/hooks/useImageColor";

interface PodcastActionBarProps {
    isSubscribed: boolean;
    feedUrl?: string;
    colors: ColorPalette | null;
    isSubscribing: boolean;
    showDeleteConfirm: boolean;
    onSubscribe: () => void;
    onRemove: () => void;
    onShowDeleteConfirm: (show: boolean) => void;
}

export function PodcastActionBar({
    isSubscribed,
    feedUrl,
    isSubscribing,
    showDeleteConfirm,
    onSubscribe,
    onRemove,
    onShowDeleteConfirm,
}: PodcastActionBarProps) {
    return (
        <div className="flex items-center gap-4">
            {/* Subscribe Button - Yellow primary action */}
            {!isSubscribed && (
                <button
                    onClick={onSubscribe}
                    disabled={isSubscribing}
                    className="h-12 px-6 rounded-full bg-[#60a5fa] hover:bg-[#93c5fd] hover:scale-105 transition-all flex items-center gap-2 font-semibold text-black disabled:opacity-50"
                >
                    {isSubscribing ? (
                        <>
                            <Loader2 className="w-5 h-5 animate-spin" />
                            <span>Subscribing...</span>
                        </>
                    ) : (
                        <>
                            <Plus className="w-5 h-5" />
                            <span>Subscribe</span>
                        </>
                    )}
                </button>
            )}

            {/* RSS Feed Link */}
            {feedUrl && (
                <a
                    href={feedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2.5 rounded-full text-white/60 hover:text-white hover:bg-white/10 transition-all"
                    title="RSS Feed"
                >
                    <ExternalLink className="w-5 h-5" />
                </a>
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Remove Podcast Button */}
            {isSubscribed && (
                <>
                    {!showDeleteConfirm ? (
                        <button
                            onClick={() => onShowDeleteConfirm(true)}
                            className="flex items-center gap-2 px-4 py-2 rounded-full text-red-400/80 hover:text-red-400 hover:bg-red-500/10 transition-all text-sm"
                        >
                            <Trash2 className="w-4 h-4" />
                            <span className="hidden md:inline">Remove</span>
                        </button>
                    ) : (
                        <div className="flex items-center gap-2">
                            <span className="text-sm text-white/50 hidden md:inline">
                                Remove podcast?
                            </span>
                            <button
                                onClick={onRemove}
                                className="px-4 py-2 rounded-full text-sm font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-all"
                            >
                                Confirm
                            </button>
                            <button
                                onClick={() => onShowDeleteConfirm(false)}
                                className="px-4 py-2 rounded-full text-sm font-medium bg-white/5 text-white/70 hover:bg-white/10 transition-all"
                            >
                                Cancel
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
