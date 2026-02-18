"use client";

import DOMPurify from "dompurify";
import { Plus, Loader2 } from "lucide-react";
import { PodcastPreview } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { formatDuration } from "@/utils/formatTime";
import { formatDate } from "../utils";

interface PreviewEpisodesProps {
    previewData: PodcastPreview;
    colors: ColorPalette | null;
    isSubscribing: boolean;
    onSubscribe: () => void;
}

export function PreviewEpisodes({
    previewData,
    isSubscribing,
    onSubscribe,
}: PreviewEpisodesProps) {
    return (
        <section>
            <h2 className="text-xl font-bold mb-4">Latest Episodes</h2>

            {/* Episode Preview with Blur/Lock Effect */}
            <div className="relative">
                {previewData.previewEpisodes &&
                previewData.previewEpisodes.length > 0 ? (
                    <>
                        <div className="space-y-1">
                            {previewData.previewEpisodes.map((episode, index) => (
                                <div
                                    key={index}
                                    className="flex items-center gap-4 px-3 py-3 rounded-md opacity-60 cursor-not-allowed"
                                >
                                    {/* Number */}
                                    <div className="w-8 flex items-center justify-center shrink-0">
                                        <span className="text-sm text-white/40">
                                            {index + 1}
                                        </span>
                                    </div>

                                    {/* Episode Info */}
                                    <div className="flex-1 min-w-0">
                                        <h3 className="font-medium truncate text-sm text-white">
                                            {episode.title}
                                        </h3>
                                        <div className="flex items-center gap-2 text-xs text-white/50">
                                            <span>{formatDate(episode.publishedAt)}</span>
                                            {episode.duration > 0 && (
                                                <>
                                                    <span>•</span>
                                                    <span>{formatDuration(episode.duration)}</span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Blur/Fade Overlay with Subscribe CTA */}
                        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#0a0a0a]/80 to-[#0a0a0a] flex items-end justify-center pb-8 pointer-events-none">
                            <button
                                onClick={onSubscribe}
                                disabled={isSubscribing}
                                className="flex items-center gap-2 pointer-events-auto h-12 px-6 rounded-full bg-[#60a5fa] hover:bg-[#93c5fd] hover:scale-105 transition-all font-semibold text-black disabled:opacity-50 shadow-xl"
                            >
                                {isSubscribing ? (
                                    <>
                                        <Loader2 className="w-5 h-5 animate-spin" />
                                        <span>Subscribing...</span>
                                    </>
                                ) : (
                                    <>
                                        <Plus className="w-5 h-5" />
                                        <span>Subscribe to Unlock All Episodes</span>
                                    </>
                                )}
                            </button>
                        </div>
                    </>
                ) : (
                    <div className="bg-white/5 rounded-md p-6 text-center">
                        <p className="text-white/50 mb-4">
                            No episodes available for preview.
                        </p>
                        <button
                            onClick={onSubscribe}
                            disabled={isSubscribing}
                            className="flex items-center gap-2 mx-auto h-12 px-6 rounded-full bg-[#60a5fa] hover:bg-[#93c5fd] hover:scale-105 transition-all font-semibold text-black disabled:opacity-50"
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
                    </div>
                )}
            </div>

            {/* About Section */}
            {previewData.description && (
                <div className="mt-8">
                    <h2 className="text-xl font-bold mb-4">About</h2>
                    <div className="bg-white/5 rounded-md p-4">
                        <div
                            className="prose prose-invert prose-sm max-w-none text-white/70 [&_a]:text-[#3b82f6] [&_a]:no-underline [&_a:hover]:underline"
                            dangerouslySetInnerHTML={{
                                __html: DOMPurify.sanitize(previewData.description || ""),
                            }}
                        />
                    </div>
                </div>
            )}
        </section>
    );
}
