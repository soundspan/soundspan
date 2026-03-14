"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
    ArrowLeft,
    Check,
    ExternalLink,
    FileUp,
    Link,
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
type ImportMode = "url" | "file";

function tryParsePlaylistUrl(rawInput: string): URL | null {
    const trimmed = rawInput.trim();
    if (!trimmed) return null;

    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;
    try {
        return new URL(withProtocol);
    } catch {
        return null;
    }
}

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

/**
 * Executes isSupportedPlaylistUrl.
 */
export function isSupportedPlaylistUrl(url: string): boolean {
    const parsed = tryParsePlaylistUrl(url);
    if (!parsed) return false;

    const hostname = parsed.hostname.toLowerCase();
    const path = parsed.pathname;

    if (hostname === "open.spotify.com") {
        return /^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?playlist\/[a-zA-Z0-9]+\/?$/i.test(path);
    }

    if (hostname === "deezer.com" || hostname.endsWith(".deezer.com")) {
        return /^\/(?:[a-z]{2}\/)?playlist\/\d+\/?$/i.test(path);
    }

    if (
        hostname === "youtube.com" ||
        hostname === "www.youtube.com" ||
        hostname === "music.youtube.com"
    ) {
        return path === "/playlist" && parsed.searchParams.has("list");
    }

    if (hostname === "tidal.com" || hostname === "listen.tidal.com") {
        return /^\/(?:browse\/)?playlist\/[a-zA-Z0-9-]+\/?$/i.test(path);
    }

    return false;
}

/**
 * Executes executeImportAction.
 */
export async function executeImportAction(options: {
    previewData: PlaylistImportPreviewResponse;
    name?: string;
}): Promise<PlaylistImportExecuteResponse> {
    const name = options.name?.trim();
    return api.executePlaylistImport({
        previewData: options.previewData,
        ...(name ? { name } : {}),
    });
}

/**
 * Renders the ImportResolutionBadge component.
 */
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

/**
 * Renders the PreviewTrackResolutionList component.
 */
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
    const [importMode, setImportMode] = useState<ImportMode>("url");
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
    const [m3uFileName, setM3uFileName] = useState("");
    const [m3uContent, setM3uContent] = useState("");
    const [m3uPlaylistName, setM3uPlaylistName] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);

    const fetchPreview = useCallback(
        async (nextUrl: string) => {
            const trimmedUrl = nextUrl.trim();
            if (!trimmedUrl) {
                toast.error("Please enter a playlist URL");
                return;
            }

            if (!isSupportedPlaylistUrl(trimmedUrl)) {
                toast.error(
                    "Supported URLs: Spotify, Deezer, YouTube Music, and TIDAL playlists"
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

    const handleM3uFileSelect = useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = () => {
                const content = reader.result as string;
                setM3uContent(content);
                setM3uFileName(file.name);
                const defaultName = file.name
                    .replace(/\.(m3u8?|M3U8?)$/, "")
                    .replace(/[_-]/g, " ");
                setM3uPlaylistName(defaultName);
            };
            reader.onerror = () => {
                toast.error("Failed to read file");
            };
            reader.readAsText(file);
        },
        [toast]
    );

    const fetchM3uPreview = useCallback(async () => {
        if (!m3uContent) {
            toast.error("Please select an M3U file");
            return;
        }

        setIsPreviewLoading(true);
        try {
            const response = await api.previewM3UImport(
                m3uContent,
                m3uPlaylistName || undefined
            );
            setPreview(response);
            setPlaylistName(response.playlistName);
            setStep("preview");
        } catch (error) {
            toast.error(getErrorMessage(error, "Failed to preview M3U file"));
        } finally {
            setIsPreviewLoading(false);
        }
    }, [m3uContent, m3uPlaylistName, toast]);

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
                previewData: preview,
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

    const handleSubmitBackgroundJob = async () => {
        if (!url) return;

        try {
            const result = await api.submitImportJob(url, playlistName || undefined);
            if (result.deduped) {
                toast.info("An import for this playlist is already in progress");
            } else {
                toast.success("Import job submitted — check the Imports tab in Activity");
            }
            resetFlow();
        } catch (error) {
            toast.error(getErrorMessage(error, "Failed to submit import job"));
        }
    };

    const resetFlow = () => {
        setStep("input");
        setUrl("");
        setPlaylistName("");
        setPreview(null);
        setResult(null);
        setIsExecuting(false);
        setM3uContent("");
        setM3uFileName("");
        setM3uPlaylistName("");
        if (fileInputRef.current) fileInputRef.current.value = "";
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
                            Import playlists from streaming services or local M3U
                            files
                        </p>
                    </div>
                </div>

                {step === "input" && (
                    <div className="space-y-4">
                        <div className="flex gap-1 bg-white/5 rounded-lg p-1">
                            <button
                                onClick={() => setImportMode("url")}
                                className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-colors ${
                                    importMode === "url"
                                        ? "bg-white/10 text-white"
                                        : "text-gray-400 hover:text-gray-300"
                                }`}
                            >
                                <Link className="w-4 h-4" />
                                URL Import
                            </button>
                            <button
                                onClick={() => setImportMode("file")}
                                className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-colors ${
                                    importMode === "file"
                                        ? "bg-white/10 text-white"
                                        : "text-gray-400 hover:text-gray-300"
                                }`}
                            >
                                <FileUp className="w-4 h-4" />
                                M3U File
                            </button>
                        </div>

                        {importMode === "url" && (
                            <>
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
                                        placeholder="Paste a Spotify, Deezer, YouTube Music, or TIDAL playlist URL"
                                        className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[#3b82f6]/50 focus:border-[#3b82f6] transition-colors"
                                        onKeyDown={(event) =>
                                            event.key === "Enter" &&
                                            void fetchPreview(url)
                                        }
                                    />
                                    <p className="text-xs text-gray-500 mt-2">
                                        Paste a{" "}
                                        <span className="text-[#1DB954]">Spotify</span>,{" "}
                                        <span className="text-[#AD47FF]">Deezer</span>,{" "}
                                        <span className="text-red-400">YouTube Music</span>,{" "}
                                        or{" "}
                                        <span className="text-[#00BFFF]">TIDAL</span>{" "}
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
                            </>
                        )}

                        {importMode === "file" && (
                            <>
                                <div>
                                    <label className="block text-sm font-medium text-gray-300 mb-2">
                                        M3U / M3U8 Playlist File
                                    </label>
                                    <div
                                        onClick={() => fileInputRef.current?.click()}
                                        className="w-full bg-white/5 border border-dashed border-white/20 rounded-lg px-4 py-8 text-center cursor-pointer hover:border-white/40 hover:bg-white/[0.07] transition-colors"
                                    >
                                        <FileUp className="w-8 h-8 text-gray-500 mx-auto mb-2" />
                                        {m3uFileName ? (
                                            <p className="text-sm text-white">{m3uFileName}</p>
                                        ) : (
                                            <p className="text-sm text-gray-400">
                                                Click to select an M3U or M3U8 file
                                            </p>
                                        )}
                                    </div>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept=".m3u,.m3u8"
                                        className="hidden"
                                        onChange={handleM3uFileSelect}
                                    />
                                    <p className="text-xs text-gray-500 mt-2">
                                        Tracks are matched against your local library using file paths and metadata
                                    </p>
                                </div>
                                {m3uContent && (
                                    <div>
                                        <label className="block text-sm font-medium text-gray-300 mb-2">
                                            Playlist Name
                                        </label>
                                        <input
                                            type="text"
                                            value={m3uPlaylistName}
                                            onChange={(event) =>
                                                setM3uPlaylistName(event.target.value)
                                            }
                                            placeholder="Enter playlist name"
                                            className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[#3b82f6]/50 focus:border-[#3b82f6] transition-colors"
                                        />
                                    </div>
                                )}
                                <button
                                    onClick={() => void fetchM3uPreview()}
                                    disabled={isPreviewLoading || !m3uContent}
                                    className="w-full py-3 rounded-full font-medium bg-[#3b82f6] text-black hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                                >
                                    {isPreviewLoading ? (
                                        <>
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            Matching Tracks...
                                        </>
                                    ) : (
                                        "Preview Import"
                                    )}
                                </button>
                            </>
                        )}
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
                            {url && (
                                <a
                                    href={url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-gray-400 hover:text-[#3b82f6] transition-colors"
                                >
                                    <ExternalLink className="w-4 h-4" />
                                </a>
                            )}
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
                        {url && importableCount > 0 && (
                            <button
                                onClick={() => void handleSubmitBackgroundJob()}
                                disabled={isExecuting}
                                className="w-full mt-2 py-2.5 rounded-full text-sm font-medium text-gray-400 hover:text-white hover:bg-white/5 border border-white/10 transition-colors"
                            >
                                Run in Background
                            </button>
                        )}
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

/**
 * Renders the ImportPage component.
 */
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
