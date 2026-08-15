"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type {
    FederationDedupEntry,
    FederationPeer,
} from "@/lib/api/federation";

const fieldClassName =
    "w-24 rounded-lg border border-white/10 bg-surface px-2 py-1 text-xs text-white placeholder:text-gray-500 focus:border-white/30 focus:outline-none";

function parseCapInput(value: string): number | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Per-peer federation settings: duplicate visibility and host stream caps. */
export function PeerSettingsPanel({
    peer,
    onSaved,
    onError,
}: {
    peer: FederationPeer;
    onSaved: () => Promise<void>;
    onError: (message: string) => void;
}) {
    const [showDuplicates, setShowDuplicates] = useState(
        peer.showDedupedCopies,
    );
    const [maxStreams, setMaxStreams] = useState(
        peer.maxConcurrentStreams?.toString() ?? "",
    );
    const [maxKbps, setMaxKbps] = useState(
        peer.maxStreamKbps?.toString() ?? "",
    );
    const [saving, setSaving] = useState(false);

    const hasOutbound = peer.direction !== "HOST";
    const hasInbound = peer.direction !== "CONSUMER";

    const save = async () => {
        setSaving(true);
        try {
            await api.updateFederationPeerSettings(peer.id, {
                ...(hasOutbound ? { showDedupedCopies: showDuplicates } : {}),
                ...(hasInbound
                    ? {
                          maxConcurrentStreams: parseCapInput(maxStreams),
                          maxStreamKbps: parseCapInput(maxKbps),
                      }
                    : {}),
            });
            await onSaved();
        } catch (error: unknown) {
            onError(
                error instanceof Error
                    ? error.message
                    : "Failed to save peer settings",
            );
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="mt-3 space-y-2 rounded-lg border border-white/[0.06] bg-surface p-3">
            {hasOutbound && (
                <label className="flex items-center gap-2 text-xs text-gray-300">
                    <input
                        type="checkbox"
                        checked={showDuplicates}
                        onChange={(event) =>
                            setShowDuplicates(event.target.checked)
                        }
                    />
                    Show this peer&apos;s copies of tracks you already own
                </label>
            )}
            {hasInbound && (
                <div className="flex flex-wrap items-center gap-3 text-xs text-gray-300">
                    <label className="flex items-center gap-2">
                        Max streams
                        <input
                            value={maxStreams}
                            onChange={(event) =>
                                setMaxStreams(event.target.value)
                            }
                            placeholder="∞"
                            inputMode="numeric"
                            className={fieldClassName}
                        />
                    </label>
                    <label className="flex items-center gap-2">
                        Max kbps
                        <input
                            value={maxKbps}
                            onChange={(event) => setMaxKbps(event.target.value)}
                            placeholder="∞"
                            inputMode="numeric"
                            className={fieldClassName}
                        />
                    </label>
                </div>
            )}
            <button
                type="button"
                disabled={saving}
                onClick={() => void save()}
                className="rounded-full bg-white px-3 py-1 text-[10px] font-semibold text-black disabled:opacity-50"
            >
                {saving ? "Saving…" : "Save settings"}
            </button>
        </div>
    );
}

function dedupTrackLabel(
    track: FederationDedupEntry["federatedTrack"],
): string {
    return `${track.title} — ${track.artist.name} (${track.album.title})`;
}

/** Paged list of this peer's dedup matches with unlink/reset arbitration. */
export function PeerDedupList({
    peer,
    onError,
}: {
    peer: FederationPeer;
    onError: (message: string) => void;
}) {
    const [entries, setEntries] = useState<FederationDedupEntry[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [busyId, setBusyId] = useState<string | null>(null);

    const load = useCallback(
        async (cursor?: string) => {
            setLoading(true);
            try {
                const page = await api.getFederationPeerDedup(peer.id, cursor);
                setEntries((previous) =>
                    cursor ? [...previous, ...page.items] : page.items,
                );
                setNextCursor(page.nextCursor);
            } catch (error: unknown) {
                onError(
                    error instanceof Error
                        ? error.message
                        : "Failed to load dedup matches",
                );
            } finally {
                setLoading(false);
            }
        },
        [peer.id, onError],
    );

    useEffect(() => {
        void load();
    }, [load]);

    const act = async (trackId: string, action: "unlink" | "reset") => {
        setBusyId(trackId);
        try {
            const updated = await api.arbitrateFederationTrackDedup(trackId, {
                action,
            });
            setEntries((previous) =>
                previous.map((entry) =>
                    entry.federatedTrack.id === trackId ? updated : entry,
                ),
            );
        } catch (error: unknown) {
            onError(
                error instanceof Error
                    ? error.message
                    : "Failed to update dedup match",
            );
        } finally {
            setBusyId(null);
        }
    };

    if (loading && entries.length === 0) {
        return (
            <div className="mt-3 flex items-center gap-2 text-xs text-gray-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading dedup
                matches…
            </div>
        );
    }
    if (entries.length === 0) {
        return (
            <p className="mt-3 text-xs text-gray-500">
                No deduplicated tracks for this peer.
            </p>
        );
    }
    return (
        <div className="mt-3 space-y-2">
            {entries.map((entry) => (
                <DedupRow
                    key={entry.federatedTrack.id}
                    entry={entry}
                    busy={busyId === entry.federatedTrack.id}
                    onAct={act}
                />
            ))}
            {nextCursor && (
                <button
                    type="button"
                    disabled={loading}
                    onClick={() => void load(nextCursor)}
                    className="text-xs text-gray-400 underline-offset-2 hover:underline"
                >
                    Load more
                </button>
            )}
        </div>
    );
}

function DedupRow({
    entry,
    busy,
    onAct,
}: {
    entry: FederationDedupEntry;
    busy: boolean;
    onAct: (trackId: string, action: "unlink" | "reset") => Promise<void>;
}) {
    return (
        <div className="rounded-lg bg-surface p-2 text-xs">
            <p className="truncate text-gray-200">
                {dedupTrackLabel(entry.federatedTrack)}
            </p>
            <p className="truncate text-gray-500">
                {entry.localTrack
                    ? `Hidden behind: ${dedupTrackLabel(entry.localTrack)}${entry.tier ? ` · ${entry.tier}` : ""}`
                    : "Not linked to a local track"}
                {entry.pinned ? " · pinned" : ""}
            </p>
            <div className="mt-1 flex gap-2">
                {entry.localTrack && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                            void onAct(entry.federatedTrack.id, "unlink")
                        }
                        className="rounded-full border border-white/15 px-2 py-0.5 text-[10px] text-white disabled:opacity-50"
                    >
                        Unlink
                    </button>
                )}
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onAct(entry.federatedTrack.id, "reset")}
                    className="rounded-full border border-white/15 px-2 py-0.5 text-[10px] text-white disabled:opacity-50"
                >
                    Re-match
                </button>
            </div>
        </div>
    );
}
