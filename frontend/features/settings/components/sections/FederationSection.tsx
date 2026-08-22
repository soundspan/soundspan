"use client";

import { useCallback, useEffect, useState } from "react";
import {
    ArrowDownToLine,
    ArrowUpFromLine,
    Clipboard,
    KeyRound,
    Loader2,
    RefreshCw,
    RotateCw,
    Trash2,
    Unlink,
} from "lucide-react";
import { api } from "@/lib/api";
import type {
    FederationPeer,
    FederationPeerStatus,
} from "@/lib/api/federation";
import type { SystemSettings } from "../../types";
import { useFeatures } from "@/lib/features-context";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsSection, SettingsRow } from "../ui";
import { PeerDedupList, PeerSettingsPanel } from "./federationPeerSettings";
import { FederationHealthPanel } from "./FederationHealthPanel";
import {
    DEFAULT_SCOPES,
    FederationAddPanel,
    federationErrorMessage,
    buildLinkPeerInput,
    buildPairPeerInput,
} from "./federationPairing";

const inputClassName =
    "w-full rounded-lg border border-white/10 bg-surface px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:border-white/30 focus:outline-none";
const secondaryButtonClassName =
    "inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1.5 text-xs font-medium text-white hover:border-white/40 disabled:cursor-not-allowed disabled:opacity-50";

function formatLastSeen(value: string | null): string {
    if (!value) return "Never seen";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
        ? "Last seen unknown"
        : `Last seen ${parsed.toLocaleString()}`;
}

function hasInbound(peer: FederationPeer): boolean {
    return peer.direction === "HOST" || peer.direction === "BOTH";
}

function hasOutbound(peer: FederationPeer): boolean {
    return peer.direction === "CONSUMER" || peer.direction === "BOTH";
}

function isFullyRevoked(peer: FederationPeer): boolean {
    const inboundRevoked =
        !hasInbound(peer) || peer.inboundStatus === "REVOKED";
    const outboundRevoked =
        !hasOutbound(peer) || peer.outboundStatus === "REVOKED";
    return inboundRevoked && outboundRevoked;
}

function StatusChip({
    status,
    label,
}: {
    status: FederationPeerStatus | null;
    label?: string;
}) {
    const shown = status ?? "PENDING";
    const tone =
        shown === "ACTIVE"
            ? "bg-green-500/15 text-green-300"
            : shown === "OFFLINE"
              ? "bg-gray-500/20 text-gray-300"
              : shown === "REVOKED"
                ? "bg-red-500/15 text-red-300"
                : "bg-amber-500/15 text-amber-300";
    return (
        <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${tone}`}
        >
            {label ? `${label} ${shown}` : shown}
        </span>
    );
}

interface FederationPeersListProps {
    peers: FederationPeer[];
    busyPeerId: string | null;
    onSync: (peer: FederationPeer) => void;
    onRotate: (peer: FederationPeer) => void;
    onRevoke: (peer: FederationPeer) => void;
    onDelete: (peer: FederationPeer) => void;
    onRefresh?: () => Promise<void>;
}

/** Render the federation peer collection and its administrative actions. */
export function FederationPeersList({
    peers,
    busyPeerId,
    onSync,
    onRotate,
    onRevoke,
    onDelete,
    onRefresh,
}: FederationPeersListProps) {
    if (peers.length === 0) {
        return (
            <div className="rounded-lg border border-dashed border-white/10 px-4 py-8 text-center text-sm text-gray-400">
                No federation peers linked.
            </div>
        );
    }
    return (
        <div className="space-y-2">
            {peers.map((peer) => (
                <PeerCard
                    key={peer.id}
                    peer={peer}
                    busy={busyPeerId === peer.id}
                    onSync={onSync}
                    onRotate={onRotate}
                    onRevoke={onRevoke}
                    onDelete={onDelete}
                    onRefresh={onRefresh}
                />
            ))}
        </div>
    );
}

function PeerCard({
    peer,
    busy,
    onSync,
    onRotate,
    onRevoke,
    onDelete,
    onRefresh,
}: {
    peer: FederationPeer;
    busy: boolean;
    onSync: (peer: FederationPeer) => void;
    onRotate: (peer: FederationPeer) => void;
    onRevoke: (peer: FederationPeer) => void;
    onDelete: (peer: FederationPeer) => void;
    onRefresh?: () => Promise<void>;
}) {
    const [panel, setPanel] = useState<"none" | "settings" | "dedup">("none");
    const [panelError, setPanelError] = useState<string | null>(null);
    const togglePanel = (target: "settings" | "dedup") => {
        setPanelError(null);
        setPanel((current) => (current === target ? "none" : target));
    };
    return (
        <div className="rounded-lg border border-white/[0.06] bg-surface-hover p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <h3 className="truncate text-sm font-medium text-white">
                                {peer.name}
                            </h3>
                        </div>
                        <div className="mt-2 space-y-1">
                            {hasInbound(peer) && (
                                <div className="flex items-center gap-2 text-xs text-gray-300">
                                    <ArrowUpFromLine className="h-3.5 w-3.5 text-gray-500" />
                                    <span>Sharing to them</span>
                                    <StatusChip status={peer.inboundStatus} />
                                </div>
                            )}
                            {hasOutbound(peer) && (
                                <div className="flex items-center gap-2 text-xs text-gray-300">
                                    <ArrowDownToLine className="h-3.5 w-3.5 text-gray-500" />
                                    <span>Consuming from them</span>
                                    <StatusChip status={peer.outboundStatus} />
                                </div>
                            )}
                        </div>
                        <p className="mt-1 truncate text-xs text-gray-400">
                            {peer.baseUrl ?? "This instance hosts the library"}
                        </p>
                        <p className="mt-1 text-xs text-gray-500">
                            {formatLastSeen(peer.lastSeenAt)}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1">
                            {peer.scopes.map((scope) => (
                                <span
                                    key={scope}
                                    className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-gray-300"
                                >
                                    {scope}
                                </span>
                            ))}
                        </div>
                    </div>
                </div>
                <PeerActions
                    peer={peer}
                    busy={busy}
                    onSync={onSync}
                    onRotate={onRotate}
                    onRevoke={onRevoke}
                    onDelete={onDelete}
                />
            </div>
            <div className="mt-2 flex gap-3 text-[10px] text-gray-400">
                <button
                    type="button"
                    onClick={() => togglePanel("settings")}
                    className="underline-offset-2 hover:underline"
                >
                    {panel === "settings" ? "Hide settings" : "Settings"}
                </button>
                {hasOutbound(peer) && (
                    <button
                        type="button"
                        onClick={() => togglePanel("dedup")}
                        className="underline-offset-2 hover:underline"
                    >
                        {panel === "dedup"
                            ? "Hide dedup matches"
                            : "Dedup matches"}
                    </button>
                )}
            </div>
            {panelError && (
                <p className="mt-2 text-xs text-red-300">{panelError}</p>
            )}
            {panel === "settings" && (
                <PeerSettingsPanel
                    peer={peer}
                    onSaved={async () => {
                        setPanel("none");
                        await onRefresh?.();
                    }}
                    onError={setPanelError}
                />
            )}
            {panel === "dedup" && (
                <PeerDedupList peer={peer} onError={setPanelError} />
            )}
        </div>
    );
}

function PeerActions(props: {
    peer: FederationPeer;
    busy: boolean;
    onSync: (peer: FederationPeer) => void;
    onRotate: (peer: FederationPeer) => void;
    onRevoke: (peer: FederationPeer) => void;
    onDelete: (peer: FederationPeer) => void;
}) {
    const { peer, busy, onSync, onRotate, onRevoke, onDelete } = props;
    return (
        <div className="flex flex-wrap justify-end gap-2">
            {busy && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
            {hasOutbound(peer) && peer.outboundStatus !== "REVOKED" && (
                <ActionButton
                    label="Sync now"
                    onClick={() => onSync(peer)}
                    disabled={busy}
                    icon={<RefreshCw className="h-3.5 w-3.5" />}
                />
            )}
            {hasInbound(peer) && peer.inboundStatus !== "REVOKED" && (
                <ActionButton
                    label="Rotate"
                    onClick={() => onRotate(peer)}
                    disabled={busy}
                    icon={<RotateCw className="h-3.5 w-3.5" />}
                />
            )}
            {!isFullyRevoked(peer) && (
                <ActionButton
                    label="Revoke"
                    onClick={() => onRevoke(peer)}
                    disabled={busy}
                    icon={<Unlink className="h-3.5 w-3.5" />}
                />
            )}
            <ActionButton
                label="Delete"
                onClick={() => onDelete(peer)}
                disabled={busy}
                icon={<Trash2 className="h-3.5 w-3.5" />}
            />
        </div>
    );
}

function ActionButton(props: {
    label: string;
    onClick: () => void;
    disabled: boolean;
    icon: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={props.onClick}
            disabled={props.disabled}
            className={secondaryButtonClassName}
        >
            {props.icon}
            {props.label}
        </button>
    );
}

/** Dialog for a host credential that the server will never return again. */
export function OneTimeCredentialDialog({
    peerName,
    token,
    onClose,
}: {
    peerName: string;
    token: string;
    onClose: () => void;
}) {
    const [copied, setCopied] = useState(false);
    const copyToken = async () => {
        if (typeof navigator !== "undefined" && navigator.clipboard) {
            await navigator.clipboard.writeText(token);
            setCopied(true);
        }
    };
    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="federation-token-title"
        >
            <div className="w-full max-w-lg rounded-xl border border-white/10 bg-surface-elevated p-6 shadow-2xl">
                <div className="flex items-center gap-3">
                    <KeyRound className="h-5 w-5 text-brand" />
                    <h2
                        id="federation-token-title"
                        className="text-lg font-semibold text-white"
                    >
                        Credential for {peerName}
                    </h2>
                </div>
                <p className="mt-3 text-sm text-amber-200">
                    Copy this token now. You won&apos;t see this again.
                </p>
                <code className="mt-4 block break-all rounded-lg bg-black/30 p-3 text-xs text-white">
                    {token}
                </code>
                <div className="mt-5 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={() => void copyToken()}
                        className={secondaryButtonClassName}
                    >
                        <Clipboard className="h-3.5 w-3.5" />
                        {copied ? "Copied" : "Copy token"}
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-full bg-white px-4 py-1.5 text-xs font-semibold text-black"
                    >
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
}

type RunPeerAction = (
    peer: FederationPeer,
    action: () => Promise<void>,
) => Promise<void>;

function PeerManagementPanel(props: {
    loading: boolean;
    peers: FederationPeer[];
    busyPeerId: string | null;
    runPeerAction: RunPeerAction;
    setCredential: (value: { peerName: string; token: string }) => void;
    setDeletePeer: (peer: FederationPeer) => void;
    loadPeers: () => Promise<void>;
}) {
    if (props.loading) {
        return (
            <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
            </div>
        );
    }
    return (
        <FederationPeersList
            peers={props.peers}
            busyPeerId={props.busyPeerId}
            onRefresh={props.loadPeers}
            onSync={(peer) =>
                void props.runPeerAction(peer, () =>
                    api.syncFederationPeer(peer.id).then(() => undefined),
                )
            }
            onRotate={(peer) =>
                void props.runPeerAction(peer, async () => {
                    const result = await api.rotateFederationPeerCredential(
                        peer.id,
                    );
                    props.setCredential({
                        peerName: result.peer.name,
                        token: result.token,
                    });
                })
            }
            onRevoke={(peer) =>
                void props.runPeerAction(peer, () =>
                    api.revokeFederationPeer(peer.id).then(() => undefined),
                )
            }
            onDelete={props.setDeletePeer}
        />
    );
}

function FederationAddControls(props: {
    busy: boolean;
    pairingCode: string | null;
    setBusy: (busy: boolean) => void;
    setError: (error: string | null) => void;
    setCredential: (value: { peerName: string; token: string }) => void;
    setPairingCode: (code: string) => void;
    loadPeers: () => Promise<void>;
}) {
    const run = (action: () => Promise<void>) =>
        withAddAction(props.setBusy, props.setError, action);
    return (
        <FederationAddPanel
            busy={props.busy}
            pairingCode={props.pairingCode}
            onHost={(name, scopes) =>
                run(async () => {
                    const result = await api.createFederationPeer({
                        name,
                        scopes,
                    });
                    props.setCredential({
                        peerName: result.peer.name,
                        token: result.token,
                    });
                    await props.loadPeers();
                })
            }
            onLink={(name, baseUrl, token) =>
                run(async () => {
                    await api.linkFederationPeer(
                        buildLinkPeerInput(name, baseUrl, token),
                    );
                    await props.loadPeers();
                })
            }
            onPair={(name, baseUrl, code, options) =>
                run(async () => {
                    await api.pairFederationPeer(
                        buildPairPeerInput(name, baseUrl, code, options),
                    );
                    await props.loadPeers();
                })
            }
            onCreateCode={(options) =>
                void run(async () => {
                    const scopes = options.embeddings
                        ? [...DEFAULT_SCOPES, "embeddings:read" as const]
                        : DEFAULT_SCOPES;
                    const result =
                        await api.createFederationPairingCode(scopes);
                    props.setPairingCode(result.code);
                })
            }
        />
    );
}

function FederationDialogs(props: {
    credential: { peerName: string; token: string } | null;
    deletePeer: FederationPeer | null;
    setCredential: (value: null) => void;
    setDeletePeer: (value: FederationPeer | null) => void;
    runPeerAction: RunPeerAction;
}) {
    return (
        <>
            {props.credential && (
                <OneTimeCredentialDialog
                    peerName={props.credential.peerName}
                    token={props.credential.token}
                    onClose={() => props.setCredential(null)}
                />
            )}
            <ConfirmDialog
                isOpen={props.deletePeer !== null}
                onClose={() => props.setDeletePeer(null)}
                onConfirm={() => {
                    const peer = props.deletePeer;
                    props.setDeletePeer(null);
                    if (peer)
                        void props.runPeerAction(peer, () =>
                            api.deleteFederationPeer(peer.id),
                        );
                }}
                title="Delete federation peer?"
                message={`Delete ${props.deletePeer?.name ?? "this peer"} and all synced federation data?`}
                confirmText="Delete"
                variant="danger"
            />
        </>
    );
}

function useFederationPeers(federation: boolean) {
    const [peers, setPeers] = useState<FederationPeer[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const loadPeers = useCallback(async () => {
        if (!federation) return;
        setLoading(true);
        try {
            const response = await api.getFederationPeers();
            setPeers(response.peers);
            setError(null);
        } catch (caught: unknown) {
            setError(federationErrorMessage(caught));
        } finally {
            setLoading(false);
        }
    }, [federation]);
    useEffect(() => {
        void loadPeers();
    }, [loadPeers]);
    return { peers, loading, error, setError, loadPeers };
}

function usePeerAction(
    loadPeers: () => Promise<void>,
    setError: (error: string | null) => void,
) {
    const [busyPeerId, setBusyPeerId] = useState<string | null>(null);
    const runPeerAction: RunPeerAction = async (peer, action) => {
        setBusyPeerId(peer.id);
        setError(null);
        try {
            await action();
            await loadPeers();
        } catch (caught: unknown) {
            setError(federationErrorMessage(caught));
        } finally {
            setBusyPeerId(null);
        }
    };
    return { busyPeerId, runPeerAction };
}

interface FederationSettingsContentProps {
    error: string | null;
    loading: boolean;
    peers: FederationPeer[];
    busyPeerId: string | null;
    addBusy: boolean;
    pairingCode: string | null;
    runPeerAction: RunPeerAction;
    setCredential: (value: { peerName: string; token: string }) => void;
    setDeletePeer: (peer: FederationPeer) => void;
    setAddBusy: (busy: boolean) => void;
    setError: (error: string | null) => void;
    setPairingCode: (code: string) => void;
    loadPeers: () => Promise<void>;
    settings?: SystemSettings;
    onUpdateSettings?: (updates: Partial<SystemSettings>) => void;
}

function FederationInstanceNameRow(props: {
    settings: SystemSettings;
    onUpdateSettings: (updates: Partial<SystemSettings>) => void;
}) {
    return (
        <SettingsRow
            label="Instance display name"
            description="How this instance introduces itself to peers. Leave empty to use the server's hostname."
        >
            <input
                maxLength={100}
                value={props.settings.federationInstanceName ?? ""}
                onChange={(event) =>
                    props.onUpdateSettings({
                        federationInstanceName:
                            event.target.value.trim() === ""
                                ? null
                                : event.target.value,
                    })
                }
                className={inputClassName}
                placeholder="My music server"
            />
        </SettingsRow>
    );
}

function FederationSettingsContent(props: FederationSettingsContentProps) {
    return (
        <div className="space-y-4">
            {props.error && (
                <p
                    role="alert"
                    className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300"
                >
                    {props.error}
                </p>
            )}
            {props.settings && props.onUpdateSettings && (
                <FederationInstanceNameRow
                    settings={props.settings}
                    onUpdateSettings={props.onUpdateSettings}
                />
            )}
            <PeerManagementPanel
                loading={props.loading}
                peers={props.peers}
                busyPeerId={props.busyPeerId}
                runPeerAction={props.runPeerAction}
                setCredential={props.setCredential}
                setDeletePeer={props.setDeletePeer}
                loadPeers={props.loadPeers}
            />
            <FederationHealthPanel />
            <FederationAddControls
                busy={props.addBusy}
                pairingCode={props.pairingCode}
                setBusy={props.setAddBusy}
                setError={props.setError}
                setCredential={props.setCredential}
                setPairingCode={props.setPairingCode}
                loadPeers={props.loadPeers}
            />
        </div>
    );
}

/** Admin settings surface for federation peer lifecycle management. */
export function FederationSection(props: {
    settings?: SystemSettings;
    onUpdateSettings?: (updates: Partial<SystemSettings>) => void;
}) {
    const { federation } = useFeatures();
    const { peers, loading, error, setError, loadPeers } =
        useFederationPeers(federation);
    const { busyPeerId, runPeerAction } = usePeerAction(loadPeers, setError);
    const [addBusy, setAddBusy] = useState(false);
    const [credential, setCredential] = useState<{
        peerName: string;
        token: string;
    } | null>(null);
    const [deletePeer, setDeletePeer] = useState<FederationPeer | null>(null);
    const [pairingCode, setPairingCode] = useState<string | null>(null);

    if (!federation) return null;
    return (
        <SettingsSection
            id="federation"
            title="Federation"
            description="Link trusted soundspan instances for read-only library browsing and streaming."
        >
            <FederationSettingsContent
                error={error}
                loading={loading}
                peers={peers}
                busyPeerId={busyPeerId}
                addBusy={addBusy}
                pairingCode={pairingCode}
                runPeerAction={runPeerAction}
                setCredential={setCredential}
                setDeletePeer={setDeletePeer}
                setAddBusy={setAddBusy}
                setError={setError}
                setPairingCode={setPairingCode}
                loadPeers={loadPeers}
                settings={props.settings}
                onUpdateSettings={props.onUpdateSettings}
            />
            <FederationDialogs
                credential={credential}
                deletePeer={deletePeer}
                setCredential={setCredential}
                setDeletePeer={setDeletePeer}
                runPeerAction={runPeerAction}
            />
        </SettingsSection>
    );
}

async function withAddAction(
    setBusy: (busy: boolean) => void,
    setError: (error: string | null) => void,
    action: () => Promise<void>,
): Promise<void> {
    setBusy(true);
    setError(null);
    try {
        await action();
    } catch (caught: unknown) {
        setError(federationErrorMessage(caught));
    } finally {
        setBusy(false);
    }
}
