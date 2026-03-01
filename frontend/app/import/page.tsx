"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
    ArrowLeft,
    Check,
    ExternalLink,
    Loader2,
    Music4,
} from "lucide-react";
import {
    api,
    type ImportResolutionSource,
    type PlaylistImportExecuteResponse,
    type PlaylistImportPreviewResponse,
    type PlaylistImportResolvedTrack,
} from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { formatTime } from "@/utils/formatTime";

type ImportStep = "input" | "preview" | "executing" | "complete";

const SUPPORTED_PLAYLIST_URL_PATTERN =
    /(open\.spotify\.com\/playlist\/|deezer\.com\/(?:\w+\/)?playlist\/\d+)/i;

function getErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}

function getResolutionSubtitle(track: PlaylistImportResolvedTrack): string {
    if (track.source === "unresolved") {
        return "No provider match";
    }
    if (track.confidence > 0) {
        return `${track.confidence}% confidence`;
    }
    return "Resolved";
}

export function isSupportedPlaylistUrl(url: string): boolean {
    return SUPPORTED_PLAYLIST_URL_PATTERN.test(url.trim());
}

export async function executeImportAction(options: {
    url: string;
    name?: string;
}): Promise<PlaylistImportExecuteResponse> {
    const url = options.url.trim();
    const name = options.name?.trim();
    return api.executePlaylistImport({
        url,
        ...(name ? { name } : {}),
    });
}

export function ImportResolutionBadge({
    source,
}: {
    source: ImportResolutionSource;
}) {
    if (source === "local") {
        return (
            <span
                className="shrink-0 text-[10px] font-bold bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded"
                title="LOCAL"
            >
                LOCAL
            </span>
        );
    }

    if (source === "youtube") {
        return <YouTubeBadge />;
    }

    if (source === "tidal") {
        return <TidalBadge />;
    }

    return (
        <span
            className="shrink-0 text-[10px] font-bold bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded"
            title="UNRESOLVED"
        >
            UNRESOLVED
        </span>
    );
}

export function PreviewTrackResolutionList({
    tracks,
}: {
    tracks: PlaylistImportResolvedTrack[];
}) {
    if (tracks.length === 0) {
        return (
            <div className="p-4 text-sm text-gray-500">
                No tracks found in this playlist.
            </div>
        );
    }

    return (
        <div className="max-h-96 overflow-y-auto divide-y divide-white/5">
            {tracks.map((track, idx) => (
                <div
                    key={`${track.index}-${track.artist}-${track.title}-${idx}`}
                    className="px-4 py-3 hover:bg-white/5"
                >
                    <div className="flex items-start gap-3">
                        <span className="text-xs text-gray-600 w-6 text-right pt-0.5">
                            {idx + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm text-white truncate">
                                {track.title}
                            </div>
                            <div className="text-xs text-gray-400 truncate">
                                {track.artist}
                                {track.album ? ` • ${track.album}` : ""}
                            </div>
                            <div className="text-[11px] text-gray-500 mt-1">
                                {getResolutionSubtitle(track)}
                            </div>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                            <ImportResolutionBadge source={track.source} />
                            {typeof track.duration === "number" &&
                                track.duration > 0 && (
                                    <span className="text-[11px] text-gray-600">
                                        {formatTime(track.duration)}
                                    </span>
                                )}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}

function ImportPageContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { toast } = useToast();
    const hasAutoFetched = useRef(false);

    const [step, setStep] = useState<ImportStep>("input");
    const [url, setUrl] = useState("");
    const [playlistName, setPlaylistName] = useState("");
    const [preview, setPreview] = useState<PlaylistImportPreviewResponse | null>(
        null
    );
    const [result, setResult] = useState<PlaylistImportExecuteResponse | null>(
        null
    );
    const [isPreviewLoading, setIsPreviewLoading] = useState(false);
    const [isExecuting, setIsExecuting] = useState(false);

    const fetchPreview = useCallback(
        async (nextUrl: string) => {
            const trimmedUrl = nextUrl.trim();
            if (!trimmedUrl) {
                toast.error("Please enter a playlist URL");
                return;
            }

            if (!isSupportedPlaylistUrl(trimmedUrl)) {
                toast.error(
                    "Supported URLs: Spotify playlists and Deezer playlists"
                );
                return;
            }

            setIsPreviewLoading(true);
            try {
                const response = await api.previewPlaylistImport(trimmedUrl);
                setUrl(trimmedUrl);
                setPreview(response);
                setPlaylistName(response.playlistName);
                setStep("preview");
            } catch (error) {
                toast.error(
                    getErrorMessage(error, "Failed to preview playlist")
                );
            } finally {
                setIsPreviewLoading(false);
            }
        },
        [toast]
    );

    useEffect(() => {
        const urlParam = searchParams.get("url");
        if (!urlParam || hasAutoFetched.current) {
            return;
        }

        hasAutoFetched.current = true;
        void fetchPreview(urlParam);
    }, [fetchPreview, searchParams]);

    const handleExecute = async () => {
        if (!preview) return;

        setIsExecuting(true);
        setStep("executing");
        try {
            const executeResult = await executeImportAction({
                url,
                name: playlistName,
            });
            setResult(executeResult);
            setStep("complete");
            window.dispatchEvent(new CustomEvent("notifications-changed"));
            window.dispatchEvent(new CustomEvent("playlist-created"));
        } catch (error) {
            setStep("preview");
            toast.error(getErrorMessage(error, "Failed to import playlist"));
        } finally {
            setIsExecuting(false);
        }
    };

    const resetFlow = () => {
        setStep("input");
        setUrl("");
        setPlaylistName("");
        setPreview(null);
        setResult(null);
        setIsExecuting(false);
    };

    const importableCount = preview
        ? preview.summary.total - preview.summary.unresolved
        : 0;

    const completedImportableCount = result
        ? result.summary.total - result.summary.unresolved
        : 0;

    return (
        <div className="min-h-screen relative">
            <div className="absolute inset-0 pointer-events-none">
                <div
                    className="absolute inset-0 bg-linear-to-b from-[#3b82f6]/15 via-blue-900/10 to-transparent"
                    style={{ height: "35vh" }}
                />
                <div
                    className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--tw-gradient-stops))] from-[#3b82f6]/8 via-transparent to-transparent"
                    style={{ height: "25vh" }}
                />
            </div>

            <div className="relative max-w-3xl mx-auto px-6 py-6">
                <div className="flex items-center gap-4 mb-6">
                    <button
                        onClick={() => router.back()}
                        className="p-2 hover:bg-white/5 rounded-full transition-colors"
                    >
                        <ArrowLeft className="w-5 h-5 text-gray-400" />
                    </button>
                    <div>
                        <h1 className="text-2xl font-bold text-white">
                            Import Playlist
                        </h1>
                        <p className="text-sm text-gray-400">
                            Spotify and Deezer playlist import with direct
                            multi-provider matching
                        </p>
                    </div>
                </div>

                <div className="mb-6 p-4 bg-white/5 rounded-lg border border-white/10">
                    <p className="text-sm text-gray-300">
                        Looking for playlists to import?{" "}
                        <Link
                            href="/browse/playlists"
                            className="text-[#3b82f6] hover:underline font-medium"
                        >
                            Browse Deezer playlists & radio stations →
                        </Link>
                    </p>
                </div>

                {step === "input" && (
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">
                                Playlist URL
                            </label>
                            <input
                                type="text"
                                value={url}
                                onChange={(event) =>
                                    setUrl(event.target.value)
                                }
                                placeholder="https://open.spotify.com/playlist/... or https://www.deezer.com/playlist/..."
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[#3b82f6]/50 focus:border-[#3b82f6] transition-colors"
                                onKeyDown={(event) =>
                                    event.key === "Enter" &&
                                    void fetchPreview(url)
                                }
                            />
                            <p className="text-xs text-gray-500 mt-2">
                                Paste a public{" "}
                                <span className="text-[#AD47FF]">Deezer</span>{" "}
                                or{" "}
                                <span className="text-[#1DB954]">Spotify</span>{" "}
                                playlist URL
                            </p>
                        </div>
                        <button
                            onClick={() => void fetchPreview(url)}
                            disabled={isPreviewLoading || !url.trim()}
                            className="w-full py-3 rounded-full font-medium bg-[#3b82f6] text-black hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                        >
                            {isPreviewLoading ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    Loading Preview...
                                </>
                            ) : (
                                "Preview Import"
                            )}
                        </button>
                    </div>
                )}

                {step === "preview" && preview && (
                    <div className="space-y-4">
                        <div className="flex items-start gap-4 p-4 bg-white/5 rounded-lg">
                            <div className="w-12 h-12 rounded-md bg-white/10 flex items-center justify-center">
                                <Music4 className="w-6 h-6 text-gray-300" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <h2 className="text-lg font-bold text-white truncate">
                                    {preview.playlistName}
                                </h2>
                                <p className="text-sm text-gray-400">
                                    {preview.summary.total} songs found
                                </p>
                            </div>
                            <a
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-gray-400 hover:text-[#3b82f6] transition-colors"
                            >
                                <ExternalLink className="w-4 h-4" />
                            </a>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                            <div className="text-center py-3 bg-white/5 rounded-lg">
                                <div className="text-xl font-bold text-white">
                                    {preview.summary.total}
                                </div>
                                <div className="text-xs text-gray-500">
                                    Total
                                </div>
                            </div>
                            <div className="text-center py-3 bg-emerald-500/10 rounded-lg">
                                <div className="text-xl font-bold text-emerald-300">
                                    {preview.summary.local}
                                </div>
                                <div className="text-xs text-gray-500">
                                    Local
                                </div>
                            </div>
                            <div className="text-center py-3 bg-red-500/10 rounded-lg">
                                <div className="text-xl font-bold text-red-300">
                                    {preview.summary.youtube}
                                </div>
                                <div className="text-xs text-gray-500">
                                    YouTube
                                </div>
                            </div>
                            <div className="text-center py-3 bg-[#00BFFF]/10 rounded-lg">
                                <div className="text-xl font-bold text-[#00BFFF]">
                                    {preview.summary.tidal}
                                </div>
                                <div className="text-xs text-gray-500">
                                    TIDAL
                                </div>
                            </div>
                            <div className="text-center py-3 bg-red-500/10 rounded-lg">
                                <div className="text-xl font-bold text-red-400">
                                    {preview.summary.unresolved}
                                </div>
                                <div className="text-xs text-gray-500">
                                    Unresolved
                                </div>
                            </div>
                        </div>

                        <div className="bg-white/5 rounded-lg overflow-hidden">
                            <div className="px-4 py-3 border-b border-white/5">
                                <h3 className="text-sm font-medium text-white">
                                    Track Resolution Preview
                                </h3>
                            </div>
                            <PreviewTrackResolutionList
                                tracks={preview.resolved}
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">
                                Playlist Name
                            </label>
                            <input
                                type="text"
                                value={playlistName}
                                onChange={(event) =>
                                    setPlaylistName(event.target.value)
                                }
                                placeholder="Enter playlist name"
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[#1DB954]/50 focus:border-[#1DB954] transition-colors"
                            />
                        </div>

                        <div className="flex items-center gap-3 pt-2">
                            <button
                                onClick={() => setStep("input")}
                                className="px-6 py-3 rounded-full text-sm font-medium text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
                            >
                                Back
                            </button>
                            <button
                                onClick={() => void handleExecute()}
                                disabled={isExecuting || importableCount <= 0}
                                className="flex-1 py-3 rounded-full font-medium bg-[#1DB954] text-black hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                            >
                                {isExecuting ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Importing...
                                    </>
                                ) : importableCount > 0 ? (
                                    `Create Playlist (${importableCount} tracks)`
                                ) : (
                                    "No importable tracks"
                                )}
                            </button>
                        </div>
                    </div>
                )}

                {step === "executing" && (
                    <div className="text-center py-12">
                        <Loader2 className="w-10 h-10 text-[#1DB954] animate-spin mx-auto mb-4" />
                        <h2 className="text-lg font-bold text-white mb-1">
                            Creating Playlist
                        </h2>
                        <p className="text-sm text-gray-400">
                            Building your playlist from resolved provider
                            matches
                        </p>
                    </div>
                )}

                {step === "complete" && result && (
                    <div className="text-center py-12">
                        <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4 bg-[#1DB954]">
                            <Check className="w-7 h-7 text-black" />
                        </div>
                        <h2 className="text-lg font-bold text-white mb-1">
                            Import Complete
                        </h2>
                        <p className="text-sm text-gray-400">
                            Added {completedImportableCount} tracks to your new
                            playlist
                        </p>
                        {result.summary.unresolved > 0 && (
                            <p className="text-sm text-amber-400 mt-2">
                                Skipped {result.summary.unresolved} unresolved
                                tracks
                            </p>
                        )}

                        <div className="flex items-center justify-center gap-3 mt-6">
                            <button
                                onClick={resetFlow}
                                className="px-5 py-2.5 rounded-full text-sm font-medium text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
                            >
                                Import Another
                            </button>
                            <button
                                onClick={() =>
                                    router.push(`/playlist/${result.playlistId}`)
                                }
                                className="px-5 py-2.5 rounded-full text-sm font-medium bg-[#1DB954] text-black hover:brightness-110 transition-all"
                            >
                                View Playlist
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default function ImportPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-screen flex items-center justify-center">
                    <Loader2 className="w-8 h-8 text-[#3b82f6] animate-spin" />
                </div>
            }
        >
            <ImportPageContent />
        </Suspense>
    );
}
