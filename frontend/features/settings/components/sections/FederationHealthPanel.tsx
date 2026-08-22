"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type {
    FederationHealthState,
    FederationPeerHealth,
} from "@/lib/api/federation";

const stateTone: Record<FederationHealthState, string> = {
    green: "bg-green-500/15 text-green-300",
    amber: "bg-amber-500/15 text-amber-300",
    red: "bg-red-500/15 text-red-300",
    revoked: "bg-gray-500/15 text-gray-300",
};
const MAX_HEALTH_PEERS = 500;

function formatFreshness(value: string | null, now: Date): string {
    if (!value) return "Never synced";
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return "Sync time unknown";
    const seconds = Math.max(
        0,
        Math.floor((now.getTime() - timestamp) / 1_000),
    );
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
    return `${Math.floor(seconds / 86_400)}d ago`;
}

function leaseUsage(peer: FederationPeerHealth): string {
    return peer.maxConcurrentStreams === null
        ? `${peer.activeStreamLeases} active streams`
        : `${peer.activeStreamLeases} / ${peer.maxConcurrentStreams} active streams`;
}

const errorClassLabels: Record<
    NonNullable<FederationPeerHealth["lastErrorClass"]>,
    string
> = {
    unreachable: "Unreachable",
    tls: "TLS validation failed",
    unauthorized: "Authentication rejected",
    peer_invalid: "Invalid peer response",
};

function lastErrorDetail(peer: FederationPeerHealth): string {
    const classLabel = peer.lastErrorClass
        ? `${errorClassLabels[peer.lastErrorClass]} — `
        : "";
    if (!peer.lastError) return classLabel.replace(/ — $/, "");
    if (!peer.lastErrorAt) return `${classLabel}${peer.lastError}`;
    const timestamp = new Date(peer.lastErrorAt);
    if (!Number.isFinite(timestamp.getTime())) {
        return `${classLabel}${peer.lastError}`;
    }
    return `${classLabel}${timestamp.toLocaleString()}: ${peer.lastError}`;
}

function embeddingStateLabel(
    outcome: FederationPeerHealth["lastEmbeddingOutcome"],
): string | null {
    if (outcome === "active") return "Embeddings: federating";
    if (outcome === "skipped_mismatch") {
        return "Embeddings: not federating — embedding space mismatch (peer needs upgrade)";
    }
    return null;
}

function HealthStateChip({ state }: { state: FederationHealthState }) {
    return (
        <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${stateTone[state]}`}
        >
            {state.toUpperCase()}
        </span>
    );
}

function CatalogSummary({
    catalog,
}: {
    catalog: FederationPeerHealth["catalog"];
}) {
    return (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-400">
            <span>{catalog.artist} artists</span>
            <span>{catalog.album} albums</span>
            <span>{catalog.track} tracks</span>
            <span>{catalog.audiobook} audiobooks</span>
            <span>{catalog.podcast} podcasts</span>
        </div>
    );
}

function FederationHealthCard({
    peer,
    now,
}: {
    peer: FederationPeerHealth;
    now: Date;
}) {
    const consumesCatalog = peer.direction !== "HOST";
    const hostsStreams = peer.direction !== "CONSUMER";
    return (
        <article className="rounded-lg border border-white/[0.06] bg-surface-hover p-4">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h4 className="text-sm font-medium text-white">
                        {peer.name}
                    </h4>
                    <p className="mt-0.5 text-xs text-gray-500">
                        {peer.direction === "BOTH"
                            ? "Sharing and consuming"
                            : peer.direction === "HOST"
                              ? "Sharing to them"
                              : "Consuming from them"}
                    </p>
                </div>
                <HealthStateChip state={peer.health} />
            </div>
            <div className="mt-3 space-y-2">
                <p className="text-xs text-gray-300">
                    Synced{" "}
                    {consumesCatalog
                        ? formatFreshness(peer.lastSyncSuccessAt, now)
                        : "n/a"}
                    {consumesCatalog &&
                        peer.lastSyncDurationMs !== null &&
                        ` in ${(peer.lastSyncDurationMs / 1_000).toFixed(1)}s`}
                </p>
                {consumesCatalog && <CatalogSummary catalog={peer.catalog} />}
                {hostsStreams && (
                    <p className="text-xs text-gray-400">{leaseUsage(peer)}</p>
                )}
                {consumesCatalog &&
                    embeddingStateLabel(peer.lastEmbeddingOutcome) && (
                        <p className="text-xs text-gray-400">
                            {embeddingStateLabel(peer.lastEmbeddingOutcome)}
                        </p>
                    )}
                {peer.lastError && (
                    <div className="flex items-start gap-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-200">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{lastErrorDetail(peer)}</span>
                    </div>
                )}
            </div>
        </article>
    );
}

/** Renders a bounded peer-health card collection. */
export function FederationHealthCards({
    peers,
    now = new Date(),
}: {
    peers: FederationPeerHealth[];
    now?: Date;
}) {
    if (peers.length === 0) {
        return (
            <p className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center text-sm text-gray-400">
                No federation peer health data.
            </p>
        );
    }
    return (
        <div className="grid gap-3 lg:grid-cols-2">
            {peers.slice(0, MAX_HEALTH_PEERS).map((peer) => (
                <FederationHealthCard key={peer.id} peer={peer} now={now} />
            ))}
        </div>
    );
}

function HealthPanelHeader({
    loading,
    onRefresh,
}: {
    loading: boolean;
    onRefresh: () => void;
}) {
    return (
        <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-gray-400" />
                <h3
                    id="federation-health-title"
                    className="text-sm font-medium text-white"
                >
                    Peer health
                </h3>
            </div>
            <button
                type="button"
                onClick={onRefresh}
                disabled={loading}
                className="rounded-full border border-white/15 p-1.5 text-gray-300 disabled:opacity-50"
                aria-label="Refresh federation peer health"
            >
                <RefreshCw
                    className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                />
            </button>
        </div>
    );
}

/** Loads and renders the administrator federation peer health panel. */
export function FederationHealthPanel() {
    const [peers, setPeers] = useState<FederationPeerHealth[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setPeers((await api.getFederationPeerHealth()).peers);
        } catch (caught: unknown) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Health request failed",
            );
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => {
        let active = true;
        void api.getFederationPeerHealth().then(
            (response) => {
                if (!active) return;
                setPeers(response.peers);
                setError(null);
                setLoading(false);
            },
            (cause: unknown) => {
                if (!active) return;
                setError(
                    cause instanceof Error
                        ? cause.message
                        : "Health request failed",
                );
                setLoading(false);
            },
        );
        return () => {
            active = false;
        };
    }, []);
    return (
        <section
            aria-labelledby="federation-health-title"
            className="space-y-3"
        >
            <HealthPanelHeader
                loading={loading}
                onRefresh={() => void load()}
            />
            {error && (
                <p role="alert" className="text-sm text-red-300">
                    {error}
                </p>
            )}
            {loading ? (
                <p className="text-sm text-gray-400">Loading peer health…</p>
            ) : (
                <FederationHealthCards peers={peers} />
            )}
        </section>
    );
}
