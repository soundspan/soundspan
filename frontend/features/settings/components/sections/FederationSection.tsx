"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
    ArrowLeftRight,
    Clipboard,
    KeyRound,
    Link as LinkIcon,
    Loader2,
    Network,
    Plus,
    RefreshCw,
    RotateCw,
    Server,
    Trash2,
    Unlink,
} from "lucide-react";
import { api } from "@/lib/api";
import type {
    FederationPeer,
    FederationPeerStatus,
    FederationScope,
    LinkFederationPeerInput,
    PairFederationPeerInput,
} from "@/lib/api/federation";
import { useFeatures } from "@/lib/features-context";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsSection } from "../ui";
import { PeerDedupList, PeerSettingsPanel } from "./federationPeerSettings";

type AddMode = "host" | "link" | "pair";

export interface LinkDirectionOptions {
    twoWay: boolean;
    embeddings: boolean;
}

const DEFAULT_SCOPES: FederationScope[] = ["library:read", "stream:read"];

function linkScopes(options: LinkDirectionOptions): FederationScope[] {
    return options.embeddings
        ? [...DEFAULT_SCOPES, "embeddings:read"]
        : DEFAULT_SCOPES;
}

/** Maps the add-peer form's direction options onto the link request body. */
export function buildLinkPeerInput(
    name: string,
    baseUrl: string,
    token: string,
    options: LinkDirectionOptions,
): LinkFederationPeerInput {
    return {
        baseUrl,
        token,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(options.twoWay
            ? { direction: "BOTH" as const, scopes: linkScopes(options) }
            : {}),
    };
}

/** Maps the add-peer form's direction options onto the pair request body. */
export function buildPairPeerInput(
    name: string,
    baseUrl: string,
    code: string,
    options: LinkDirectionOptions,
): PairFederationPeerInput {
    return {
        name,
        baseUrl,
        code,
        ...(options.twoWay
            ? { direction: "BOTH" as const, scopes: linkScopes(options) }
            : {}),
    };
}
const inputClassName =
    "w-full rounded-lg border border-white/10 bg-surface px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:border-white/30 focus:outline-none";
const secondaryButtonClassName =
    "inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1.5 text-xs font-medium text-white hover:border-white/40 disabled:cursor-not-allowed disabled:opacity-50";

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Federation request failed";
}

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
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-highlight">
                        {peer.direction === "BOTH" ? (
                            <ArrowLeftRight className="h-4 w-4" />
                        ) : peer.direction === "HOST" ? (
                            <Server className="h-4 w-4" />
                        ) : (
                            <Network className="h-4 w-4" />
                        )}
                    </div>
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <h3 className="truncate text-sm font-medium text-white">
                                {peer.name}
                            </h3>
                            {peer.direction === "BOTH" ? (
                                <>
                                    <StatusChip
                                        status={peer.inboundStatus}
                                        label="IN"
                                    />
                                    <StatusChip
                                        status={peer.outboundStatus}
                                        label="OUT"
                                    />
                                </>
                            ) : (
                                <StatusChip
                                    status={
                                        hasInbound(peer)
                                            ? peer.inboundStatus
                                            : peer.outboundStatus
                                    }
                                />
                            )}
                            <span className="text-[10px] uppercase text-gray-500">
                                {peer.direction === "BOTH"
                                    ? "TWO-WAY"
                                    : peer.direction}
                            </span>
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

function AddPeerPanel({
    onHost,
    onLink,
    onPair,
    busy,
}: {
    onHost: (name: string, scopes: FederationScope[]) => Promise<void>;
    onLink: (
        name: string,
        baseUrl: string,
        token: string,
        options: LinkDirectionOptions,
    ) => Promise<void>;
    onPair: (
        name: string,
        baseUrl: string,
        code: string,
        options: LinkDirectionOptions,
    ) => Promise<void>;
    busy: boolean;
}) {
    const [mode, setMode] = useState<AddMode>("link");
    return (
        <div className="rounded-lg border border-white/[0.06] bg-surface-hover p-4">
            <div className="mb-4 flex flex-wrap gap-2">
                <ModeButton mode="link" active={mode} onSelect={setMode}>
                    Link with token
                </ModeButton>
                <ModeButton mode="pair" active={mode} onSelect={setMode}>
                    Pair with code
                </ModeButton>
                <ModeButton mode="host" active={mode} onSelect={setMode}>
                    Issue host credential
                </ModeButton>
            </div>
            {mode === "host" ? (
                <HostCredentialForm onSubmit={onHost} busy={busy} />
            ) : (
                <ConsumerLinkForm
                    mode={mode}
                    onLink={onLink}
                    onPair={onPair}
                    busy={busy}
                />
            )}
        </div>
    );
}

function ModeButton({
    mode,
    active,
    onSelect,
    children,
}: {
    mode: AddMode;
    active: AddMode;
    onSelect: (mode: AddMode) => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={() => onSelect(mode)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ${active === mode ? "bg-white text-black" : "bg-white/5 text-gray-300 hover:bg-white/10"}`}
        >
            {children}
        </button>
    );
}

function HostCredentialForm({
    onSubmit,
    busy,
}: {
    onSubmit: (name: string, scopes: FederationScope[]) => Promise<void>;
    busy: boolean;
}) {
    const [name, setName] = useState("");
    const [embeddings, setEmbeddings] = useState(false);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        const scopes: FederationScope[] = embeddings
            ? [...DEFAULT_SCOPES, "embeddings:read"]
            : DEFAULT_SCOPES;
        await onSubmit(name, scopes);
        setName("");
    };
    return (
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
            <label className="block text-xs text-gray-300">
                Peer name
                <input
                    required
                    maxLength={120}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className={`${inputClassName} mt-1`}
                    placeholder="Family server"
                />
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300">
                <input
                    type="checkbox"
                    checked={embeddings}
                    onChange={(event) => setEmbeddings(event.target.checked)}
                />
                Share embeddings (opt-in)
            </label>
            <SubmitButton busy={busy} label="Issue credential" />
        </form>
    );
}

function ConsumerLinkForm({
    mode,
    onLink,
    onPair,
    busy,
}: {
    mode: Exclude<AddMode, "host">;
    onLink: (
        name: string,
        baseUrl: string,
        token: string,
        options: LinkDirectionOptions,
    ) => Promise<void>;
    onPair: (
        name: string,
        baseUrl: string,
        code: string,
        options: LinkDirectionOptions,
    ) => Promise<void>;
    busy: boolean;
}) {
    const [name, setName] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    const [secret, setSecret] = useState("");
    const [twoWay, setTwoWay] = useState(false);
    const [embeddings, setEmbeddings] = useState(false);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        const options: LinkDirectionOptions = { twoWay, embeddings };
        if (mode === "link") await onLink(name, baseUrl, secret, options);
        else await onPair(name, baseUrl, secret, options);
        setSecret("");
    };
    return (
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
            <label className="block text-xs text-gray-300">
                Peer name
                <input
                    required={mode === "pair"}
                    maxLength={120}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className={`${inputClassName} mt-1`}
                    placeholder="Friend's server"
                />
            </label>
            <label className="block text-xs text-gray-300">
                Peer URL
                <input
                    required
                    type="url"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    className={`${inputClassName} mt-1`}
                    placeholder="https://soundspan.example"
                />
            </label>
            <label className="block text-xs text-gray-300">
                {mode === "link" ? "Token" : "Pairing code"}
                <input
                    required
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    className={`${inputClassName} mt-1`}
                    autoComplete="off"
                />
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300">
                <input
                    type="checkbox"
                    checked={twoWay}
                    onChange={(event) => setTwoWay(event.target.checked)}
                />
                Two-way — also share this library back with the peer
            </label>
            {twoWay && (
                <label className="ml-6 flex items-center gap-2 text-xs text-gray-300">
                    <input
                        type="checkbox"
                        checked={embeddings}
                        onChange={(event) =>
                            setEmbeddings(event.target.checked)
                        }
                    />
                    Share embeddings (opt-in)
                </label>
            )}
            <SubmitButton
                busy={busy}
                label={mode === "link" ? "Link peer" : "Pair peer"}
            />
        </form>
    );
}

function SubmitButton({ busy, label }: { busy: boolean; label: string }) {
    return (
        <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-semibold text-black disabled:opacity-50"
        >
            {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
                <Plus className="h-3.5 w-3.5" />
            )}
            {label}
        </button>
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

function PairingCodeControl(props: {
    busy: boolean;
    pairingCode: string | null;
    onCreate: () => void;
}) {
    return (
        <>
            <button
                type="button"
                onClick={props.onCreate}
                disabled={props.busy}
                className={secondaryButtonClassName}
            >
                <LinkIcon className="h-3.5 w-3.5" />
                Create pairing code
            </button>
            {props.pairingCode && (
                <p className="text-sm text-gray-300">
                    Pairing code:{" "}
                    <code className="rounded bg-black/30 px-2 py-1 text-white">
                        {props.pairingCode}
                    </code>
                </p>
            )}
        </>
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
        <>
            <AddPeerPanel
                busy={props.busy}
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
                onLink={(name, baseUrl, token, options) =>
                    run(async () => {
                        await api.linkFederationPeer(
                            buildLinkPeerInput(name, baseUrl, token, options),
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
            />
            <PairingCodeControl
                busy={props.busy}
                pairingCode={props.pairingCode}
                onCreate={() =>
                    void run(async () => {
                        const result =
                            await api.createFederationPairingCode(
                                DEFAULT_SCOPES,
                            );
                        props.setPairingCode(result.code);
                    })
                }
            />
        </>
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
            setError(errorMessage(caught));
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
            setError(errorMessage(caught));
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
            <PeerManagementPanel
                loading={props.loading}
                peers={props.peers}
                busyPeerId={props.busyPeerId}
                runPeerAction={props.runPeerAction}
                setCredential={props.setCredential}
                setDeletePeer={props.setDeletePeer}
                loadPeers={props.loadPeers}
            />
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
export function FederationSection() {
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
        setError(errorMessage(caught));
    } finally {
        setBusy(false);
    }
}
