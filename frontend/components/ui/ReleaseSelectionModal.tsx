"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    AlertCircle,
    CheckCircle2,
    ChevronDown,
    Download,
    ExternalLink,
    FileAudio,
    HardDrive,
    Loader2,
    RefreshCw,
    Users,
    XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { api, AlbumRelease } from "@/lib/api";
import { useDownloadContext } from "@/lib/download-context";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { cn } from "@/utils/cn";

interface ReleaseSelectionModalProps {
    isOpen: boolean;
    onClose: () => void;
    albumMbid: string;
    artistName: string;
    albumTitle: string;
}

type ReleaseSortOption = "best" | "seeders" | "size" | "quality" | "indexer";

const QUALITY_SCORE_RULES: Array<{ includes: string[]; score: number }> = [
    { includes: ["24bit", "24-bit", "hi-res", "hires", "lossless"], score: 500 },
    { includes: ["flac"], score: 400 },
    { includes: ["alac"], score: 360 },
    { includes: ["aac"], score: 230 },
    { includes: ["opus"], score: 220 },
    { includes: ["mp3", "v0", "320"], score: 200 },
    { includes: ["ogg"], score: 180 },
    { includes: ["unknown"], score: 0 },
];

function getQualityScore(release: AlbumRelease): number {
    const normalized = `${release.quality} ${release.title}`.toLowerCase();
    for (const rule of QUALITY_SCORE_RULES) {
        if (rule.includes.some((pattern) => normalized.includes(pattern))) {
            return rule.score;
        }
    }
    return 100;
}

function compareReleases(a: AlbumRelease, b: AlbumRelease, sortBy: ReleaseSortOption): number {
    if (sortBy === "seeders") {
        return (b.seeders ?? -1) - (a.seeders ?? -1);
    }
    if (sortBy === "size") {
        return (b.size ?? 0) - (a.size ?? 0);
    }
    if (sortBy === "quality") {
        const qualityDiff = getQualityScore(b) - getQualityScore(a);
        if (qualityDiff !== 0) return qualityDiff;
        return (b.seeders ?? -1) - (a.seeders ?? -1);
    }
    if (sortBy === "indexer") {
        return a.indexer.localeCompare(b.indexer);
    }

    const qualityDiff = getQualityScore(b) - getQualityScore(a);
    if (qualityDiff !== 0) return qualityDiff;

    const seedersDiff = (b.seeders ?? -1) - (a.seeders ?? -1);
    if (seedersDiff !== 0) return seedersDiff;

    return (b.size ?? 0) - (a.size ?? 0);
}

export function ReleaseSelectionModal({
    isOpen,
    onClose,
    albumMbid,
    artistName,
    albumTitle,
}: ReleaseSelectionModalProps) {
    const { addPendingDownload } = useDownloadContext();
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [releases, setReleases] = useState<AlbumRelease[]>([]);
    const [lidarrAlbumId, setLidarrAlbumId] = useState<number | null>(null);
    const [grabbing, setGrabbing] = useState<string | null>(null);
    const [grabbedReleaseGuids, setGrabbedReleaseGuids] = useState<string[]>([]);
    const [sortBy, setSortBy] = useState<ReleaseSortOption>("best");
    const [qualityFilter, setQualityFilter] = useState<string>("all");
    const [indexerFilter, setIndexerFilter] = useState<string>("all");
    const [seederFilter, setSeederFilter] = useState<"all" | "1" | "10">("all");
    const [showRejected, setShowRejected] = useState(true);

    const fetchReleases = useCallback(
        async (mode: "initial" | "refresh" = "initial") => {
            const isRefresh = mode === "refresh";
            if (isRefresh) {
                setRefreshing(true);
            } else {
                setLoading(true);
            }

            setError(null);

            try {
                const result = await api.getAlbumReleases(
                    albumMbid,
                    artistName,
                    albumTitle
                );
                setReleases(result.releases);
                setLidarrAlbumId(result.lidarrAlbumId);
            } catch (err: unknown) {
                console.error("Failed to fetch releases:", err);
                setError(
                    err instanceof Error
                        ? err.message
                        : "Failed to search for releases"
                );
            } finally {
                if (isRefresh) {
                    setRefreshing(false);
                } else {
                    setLoading(false);
                }
            }
        },
        [albumMbid, artistName, albumTitle]
    );

    useEffect(() => {
        if (!isOpen || !albumMbid) {
            return;
        }

        setSortBy("best");
        setQualityFilter("all");
        setIndexerFilter("all");
        setSeederFilter("all");
        setGrabbedReleaseGuids([]);
        setShowRejected(true);
        void fetchReleases("initial");
    }, [isOpen, albumMbid, fetchReleases]);

    const qualityOptions = useMemo(
        () =>
            Array.from(new Set(releases.map((release) => release.quality))).sort(
                (a, b) => a.localeCompare(b)
            ),
        [releases]
    );

    const indexerOptions = useMemo(
        () =>
            Array.from(new Set(releases.map((release) => release.indexer))).sort(
                (a, b) => a.localeCompare(b)
            ),
        [releases]
    );

    const filteredReleases = useMemo(
        () =>
            releases.filter((release) => {
                if (qualityFilter !== "all" && release.quality !== qualityFilter) {
                    return false;
                }
                if (indexerFilter !== "all" && release.indexer !== indexerFilter) {
                    return false;
                }
                if (seederFilter === "1" && (release.seeders ?? 0) < 1) {
                    return false;
                }
                if (seederFilter === "10" && (release.seeders ?? 0) < 10) {
                    return false;
                }
                return true;
            }),
        [releases, qualityFilter, indexerFilter, seederFilter]
    );

    const approvedReleases = useMemo(
        () =>
            filteredReleases
                .filter((release) => release.approved)
                .sort((a, b) => compareReleases(a, b, sortBy)),
        [filteredReleases, sortBy]
    );

    const rejectedReleases = useMemo(
        () =>
            filteredReleases
                .filter((release) => release.rejected)
                .sort((a, b) => compareReleases(a, b, sortBy)),
        [filteredReleases, sortBy]
    );

    const rejectionSummary = useMemo(() => {
        const counts = new Map<string, number>();
        for (const release of rejectedReleases) {
            for (const reason of release.rejections || []) {
                counts.set(reason, (counts.get(reason) ?? 0) + 1);
            }
        }

        return Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8);
    }, [rejectedReleases]);

    const hasActiveFilters =
        qualityFilter !== "all" ||
        indexerFilter !== "all" ||
        seederFilter !== "all" ||
        sortBy !== "best";

    const handleGrabRelease = async (release: AlbumRelease) => {
        if (!lidarrAlbumId) {
            toast.error("Album not ready in Lidarr");
            return;
        }

        if (grabbing || grabbedReleaseGuids.includes(release.guid)) {
            toast.info("This release is already being processed");
            return;
        }

        setGrabbing(release.guid);

        try {
            const result = await api.grabRelease({
                guid: release.guid,
                indexerId: release.indexerId,
                albumMbid,
                lidarrAlbumId,
                artistName,
                albumTitle,
                title: release.title,
            });

            if (result.duplicate) {
                toast.info(result.message || "Download already in progress");
                onClose();
                return;
            }

            addPendingDownload("album", `${artistName} - ${albumTitle}`, albumMbid);
            setGrabbedReleaseGuids((prev) => [...prev, release.guid]);
            toast.success(`Downloading "${albumTitle}"`, {
                description: `Selected: ${release.title}`,
            });
            onClose();
        } catch (err: unknown) {
            console.error("Failed to grab release:", err);
            toast.error("Failed to start download", {
                description:
                    err instanceof Error ? err.message : "Unknown release error",
            });
        } finally {
            setGrabbing(null);
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={`Select Release: ${albumTitle}`}
            className="max-h-[80vh] max-w-4xl overflow-hidden p-6"
        >
            <div className="mb-4 flex items-center justify-between gap-3">
                <div className="text-sm text-white/50">{artistName}</div>
                <button
                    type="button"
                    onClick={() => void fetchReleases("refresh")}
                    disabled={loading || refreshing}
                    className="inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1.5 text-xs text-white/70 transition hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                    title="Refresh release results"
                >
                    {refreshing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Refresh
                </button>
            </div>

            {loading ? (
                <div className="flex flex-col items-center justify-center gap-4 py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-brand" />
                    <p className="text-sm text-white/60">
                        Searching indexers for releases...
                    </p>
                    <p className="text-xs text-white/40">
                        This may take up to 60 seconds
                    </p>
                </div>
            ) : error ? (
                <div className="flex flex-col items-center justify-center gap-4 py-12">
                    <AlertCircle className="h-8 w-8 text-red-400" />
                    <p className="text-sm text-white/60">{error}</p>
                    <Button
                        variant="secondary"
                        disabled={refreshing}
                        onClick={() => void fetchReleases("refresh")}
                    >
                        {refreshing ? "Retrying..." : "Retry"}
                    </Button>
                </div>
            ) : releases.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-4 py-12">
                    <FileAudio className="h-8 w-8 text-white/40" />
                    <p className="text-sm text-white/60">
                        No releases found from indexers
                    </p>
                    <p className="text-xs text-white/40">
                        The album may not be available on your configured indexers
                    </p>
                </div>
            ) : (
                <div className="space-y-4">
                    <div className="grid grid-cols-1 gap-2 rounded-lg border border-white/10 bg-white/5 p-3 md:grid-cols-4">
                        <label className="text-xs text-white/60">
                            Sort
                            <select
                                value={sortBy}
                                onChange={(event) =>
                                    setSortBy(event.target.value as ReleaseSortOption)
                                }
                                className="mt-1 w-full rounded border border-white/15 bg-[#181818] px-2 py-1.5 text-sm text-white focus:border-white/30 focus:outline-none"
                            >
                                <option value="best">Best Match</option>
                                <option value="quality">Quality</option>
                                <option value="seeders">Seeders</option>
                                <option value="size">Size</option>
                                <option value="indexer">Indexer</option>
                            </select>
                        </label>

                        <label className="text-xs text-white/60">
                            Quality
                            <select
                                value={qualityFilter}
                                onChange={(event) => setQualityFilter(event.target.value)}
                                className="mt-1 w-full rounded border border-white/15 bg-[#181818] px-2 py-1.5 text-sm text-white focus:border-white/30 focus:outline-none"
                            >
                                <option value="all">All</option>
                                {qualityOptions.map((quality) => (
                                    <option key={quality} value={quality}>
                                        {quality}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="text-xs text-white/60">
                            Indexer
                            <select
                                value={indexerFilter}
                                onChange={(event) => setIndexerFilter(event.target.value)}
                                className="mt-1 w-full rounded border border-white/15 bg-[#181818] px-2 py-1.5 text-sm text-white focus:border-white/30 focus:outline-none"
                            >
                                <option value="all">All</option>
                                {indexerOptions.map((indexer) => (
                                    <option key={indexer} value={indexer}>
                                        {indexer}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="text-xs text-white/60">
                            Seeder Gate
                            <select
                                value={seederFilter}
                                onChange={(event) =>
                                    setSeederFilter(event.target.value as "all" | "1" | "10")
                                }
                                className="mt-1 w-full rounded border border-white/15 bg-[#181818] px-2 py-1.5 text-sm text-white focus:border-white/30 focus:outline-none"
                            >
                                <option value="all">All</option>
                                <option value="1">At least 1</option>
                                <option value="10">At least 10</option>
                            </select>
                        </label>
                    </div>

                    {hasActiveFilters && (
                        <div className="flex justify-end">
                            <button
                                type="button"
                                onClick={() => {
                                    setSortBy("best");
                                    setQualityFilter("all");
                                    setIndexerFilter("all");
                                    setSeederFilter("all");
                                }}
                                className="text-xs text-white/60 underline-offset-2 transition hover:text-white hover:underline"
                            >
                                Reset sort/filter controls
                            </button>
                        </div>
                    )}

                    {filteredReleases.length === 0 ? (
                        <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-8 text-center text-sm text-white/60">
                            No releases match the current filters.
                        </div>
                    ) : (
                        <div className="-mx-6 max-h-[45vh] overflow-y-auto px-6">
                            {approvedReleases.length > 0 && (
                                <div className="mb-6">
                                    <div className="mb-3 flex items-center gap-2">
                                        <CheckCircle2 className="h-4 w-4 text-green-400" />
                                        <h3 className="text-sm font-medium text-white/80">
                                            Available Releases ({approvedReleases.length})
                                        </h3>
                                    </div>
                                    <div className="space-y-2">
                                        {approvedReleases.map((release) => (
                                            <ReleaseRow
                                                key={release.guid}
                                                release={release}
                                                onGrab={handleGrabRelease}
                                                grabbing={grabbing === release.guid}
                                                disabled={Boolean(grabbing)}
                                                alreadyGrabbed={grabbedReleaseGuids.includes(
                                                    release.guid
                                                )}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}

                            {rejectedReleases.length > 0 && (
                                <div>
                                    <button
                                        type="button"
                                        onClick={() => setShowRejected((prev) => !prev)}
                                        className="mb-2 inline-flex items-center gap-2 text-sm font-medium text-white/60 transition hover:text-white"
                                    >
                                        <ChevronDown
                                            className={cn(
                                                "h-4 w-4 transition-transform",
                                                !showRejected && "-rotate-90"
                                            )}
                                        />
                                        <XCircle className="h-4 w-4 text-red-400/70" />
                                        Rejected ({rejectedReleases.length})
                                    </button>

                                    {showRejected && (
                                        <div className="space-y-3">
                                            {rejectionSummary.length > 0 && (
                                                <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                                                    <div className="mb-2 text-xs uppercase tracking-wide text-red-300/80">
                                                        Top rejection reasons
                                                    </div>
                                                    <div className="flex flex-wrap gap-2">
                                                        {rejectionSummary.map(([reason, count]) => (
                                                            <span
                                                                key={reason}
                                                                className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-200"
                                                            >
                                                                {reason} ({count})
                                                            </span>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}

                                            <div className="space-y-2 opacity-70">
                                                {rejectedReleases.map((release) => (
                                                    <ReleaseRow
                                                        key={release.guid}
                                                        release={release}
                                                        onGrab={handleGrabRelease}
                                                        grabbing={grabbing === release.guid}
                                                        disabled
                                                        showRejections
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </Modal>
    );
}

interface ReleaseRowProps {
    release: AlbumRelease;
    onGrab: (release: AlbumRelease) => void;
    grabbing: boolean;
    disabled: boolean;
    showRejections?: boolean;
    alreadyGrabbed?: boolean;
}

function ReleaseRow({
    release,
    onGrab,
    grabbing,
    disabled,
    showRejections,
    alreadyGrabbed = false,
}: ReleaseRowProps) {
    const isActionDisabled = disabled || alreadyGrabbed;

    return (
        <div
            className={cn(
                "flex flex-col gap-2 rounded-lg border border-white/10 bg-white/5 p-3 transition-colors",
                "hover:bg-white/10",
                isActionDisabled && !grabbing && "cursor-not-allowed opacity-50"
            )}
        >
            <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                    {release.infoUrl ? (
                        <a
                            href={release.infoUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group flex items-start gap-1.5 text-sm text-white hover:text-brand"
                            title={`Open on ${release.indexer}`}
                            onClick={(event) => event.stopPropagation()}
                        >
                            <span className="line-clamp-2 break-words">
                                {release.title}
                            </span>
                            <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                        </a>
                    ) : (
                        <p
                            className="line-clamp-2 break-words text-sm text-white"
                            title={release.title}
                        >
                            {release.title}
                        </p>
                    )}
                </div>

                <button
                    onClick={() => onGrab(release)}
                    disabled={isActionDisabled}
                    className={cn(
                        "shrink-0 rounded-full p-2 transition-all",
                        isActionDisabled
                            ? "cursor-not-allowed text-white/30"
                            : "text-brand hover:scale-105 hover:bg-white/10 hover:text-brand-hover"
                    )}
                    title={alreadyGrabbed ? "Release already selected" : "Grab this release"}
                >
                    {grabbing ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : alreadyGrabbed ? (
                        <CheckCircle2 className="h-4 w-4" />
                    ) : (
                        <Download className="h-4 w-4" />
                    )}
                </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded bg-white/10 px-1.5 py-0.5 text-white/70">
                        {release.indexer}
                    </span>
                    <span className="rounded bg-white/10 px-1.5 py-0.5 text-white/70">
                        {release.quality}
                    </span>
                    <span className="rounded bg-white/10 px-1.5 py-0.5 uppercase text-white/70">
                        {release.protocol}
                    </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-white/50">
                    <div className="flex items-center gap-1" title="Size">
                        <HardDrive className="h-3.5 w-3.5" />
                        <span>{release.sizeFormatted}</span>
                    </div>
                    {release.seeders !== undefined && (
                        <div
                            className={cn(
                                "flex items-center gap-1",
                                release.seeders > 10
                                    ? "text-green-400"
                                    : release.seeders > 0
                                      ? "text-yellow-400"
                                      : "text-red-400"
                            )}
                            title="Seeders"
                        >
                            <Users className="h-3.5 w-3.5" />
                            <span>{release.seeders}</span>
                        </div>
                    )}
                </div>
            </div>

            {showRejections && release.rejections.length > 0 && (
                <div className="space-y-1">
                    {release.rejections.slice(0, 3).map((reason, index) => (
                        <p
                            key={`${release.guid}-rejection-${index}`}
                            className="text-xs text-red-300/90"
                        >
                            {reason}
                        </p>
                    ))}
                    {release.rejections.length > 3 && (
                        <p className="text-xs text-red-300/70">
                            +{release.rejections.length - 3} more rejection reason(s)
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
