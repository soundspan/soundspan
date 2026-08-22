"use client";

import { useState, type FormEvent } from "react";
import { KeyRound, Link as LinkIcon, Loader2, Plus } from "lucide-react";
import type {
    FederationScope,
    LinkFederationPeerInput,
    PairFederationPeerInput,
} from "@/lib/api/federation";

export const DEFAULT_SCOPES: FederationScope[] = [
    "library:read",
    "stream:read",
];

const inputClassName =
    "w-full rounded-lg border border-white/10 bg-surface px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:border-white/30 focus:outline-none";
const secondaryButtonClassName =
    "inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1.5 text-xs font-medium text-white hover:border-white/40 disabled:cursor-not-allowed disabled:opacity-50";

const FEDERATION_ERROR_MESSAGES: Record<string, string> = {
    FEDERATION_PEER_UNREACHABLE:
        "Could not reach the peer. Check the URL and that the instance is online.",
    FEDERATION_PEER_TLS:
        "The peer's TLS certificate failed validation. Federation requires a valid HTTPS certificate.",
    FEDERATION_PEER_UNAUTHORIZED:
        "The peer rejected the credential. The token may have been revoked or rotated.",
    FEDERATION_PEER_INVALID:
        "The peer responded, but not like a compatible soundspan instance. Check the URL points at the backend.",
    FEDERATION_CODE_USED:
        "That pairing code was already used. Ask the other admin for a fresh one.",
    FEDERATION_CODE_EXPIRED:
        "That pairing code has expired. Codes last 30 minutes — ask the other admin for a fresh one.",
    FEDERATION_SCOPE_MISMATCH:
        "The requested access exceeds what the pairing code grants. Ask the other admin to issue a code with the needed scopes.",
    FEDERATION_PEER_CONFLICT:
        "A peer link to that URL already exists. Revoke or delete it first.",
};

/** Maps a federation API failure onto an admin-actionable message. */
export function federationErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        const data = (error as Error & { data?: Record<string, unknown> }).data;
        const code = typeof data?.code === "string" ? data.code : null;
        if (code && FEDERATION_ERROR_MESSAGES[code]) {
            return FEDERATION_ERROR_MESSAGES[code];
        }
        return error.message;
    }
    return "Federation request failed";
}

/** Maps the connect form onto the link (token) request body. */
export function buildLinkPeerInput(
    name: string,
    baseUrl: string,
    token: string,
): LinkFederationPeerInput {
    return {
        baseUrl,
        token,
        ...(name.trim() ? { name: name.trim() } : {}),
    };
}

/** Maps the connect form onto the pair (code) request body. */
export function buildPairPeerInput(
    name: string,
    baseUrl: string,
    code: string,
    options: { embeddings: boolean },
): PairFederationPeerInput {
    return {
        name,
        baseUrl,
        code,
        ...(options.embeddings
            ? { scopes: [...DEFAULT_SCOPES, "embeddings:read" as const] }
            : {}),
    };
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

function RoleModeButton({
    active,
    onSelect,
    children,
}: {
    active: boolean;
    onSelect: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onSelect}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ${active ? "bg-white text-black" : "bg-white/5 text-gray-300 hover:bg-white/10"}`}
        >
            {children}
        </button>
    );
}

/** Host-role form: issue a long-lived credential for a named consumer. */
export function HostCredentialForm({
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
                Name for the instance you are sharing with
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
                Also share embeddings (used for vibe features)
            </label>
            <SubmitButton busy={busy} label="Issue credential" />
        </form>
    );
}

/** Client-role form: redeem a pairing code or token against a peer URL. */
export function ConsumerConnectForm({
    mode,
    onLink,
    onPair,
    busy,
}: {
    mode: "link" | "pair";
    onLink: (name: string, baseUrl: string, token: string) => Promise<void>;
    onPair: (
        name: string,
        baseUrl: string,
        code: string,
        options: { embeddings: boolean },
    ) => Promise<void>;
    busy: boolean;
}) {
    const [name, setName] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    const [secret, setSecret] = useState("");
    const [embeddings, setEmbeddings] = useState(false);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (mode === "link") await onLink(name, baseUrl, secret);
        else await onPair(name, baseUrl, secret, { embeddings });
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
            {mode === "pair" && (
                <label className="flex items-center gap-2 text-xs text-gray-300">
                    <input
                        type="checkbox"
                        checked={embeddings}
                        onChange={(event) =>
                            setEmbeddings(event.target.checked)
                        }
                    />
                    Request embeddings from this peer (used for vibe features)
                </label>
            )}
            <SubmitButton
                busy={busy}
                label={mode === "link" ? "Connect with token" : "Connect"}
            />
        </form>
    );
}

function PairingCodePanel(props: {
    busy: boolean;
    pairingCode: string | null;
    onCreate: (options: { embeddings: boolean }) => void;
}) {
    const [embeddings, setEmbeddings] = useState(false);
    return (
        <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs text-gray-300">
                <input
                    type="checkbox"
                    checked={embeddings}
                    onChange={(event) => setEmbeddings(event.target.checked)}
                />
                Also allow embeddings (used for vibe features)
            </label>
            <button
                type="button"
                onClick={() => props.onCreate({ embeddings })}
                disabled={props.busy}
                className={secondaryButtonClassName}
            >
                <LinkIcon className="h-3.5 w-3.5" />
                Generate pairing code
            </button>
            {props.pairingCode && (
                <p className="text-sm text-gray-300">
                    Pairing code:{" "}
                    <code className="rounded bg-black/30 px-2 py-1 text-white">
                        {props.pairingCode}
                    </code>
                </p>
            )}
            <p className="text-xs text-gray-500">
                Send this code to the other admin. It is valid for 30 minutes
                and can be used once. They redeem it under “Connect to a
                library” on their instance.
            </p>
        </div>
    );
}

export interface FederationAddPanelProps {
    busy: boolean;
    pairingCode: string | null;
    onHost: (name: string, scopes: FederationScope[]) => Promise<void>;
    onLink: (name: string, baseUrl: string, token: string) => Promise<void>;
    onPair: (
        name: string,
        baseUrl: string,
        code: string,
        options: { embeddings: boolean },
    ) => Promise<void>;
    onCreateCode: (options: { embeddings: boolean }) => void;
}

/** Explicit host/client pairing panel: share and connect are separate acts. */
export function FederationAddPanel(props: FederationAddPanelProps) {
    const [shareMode, setShareMode] = useState<"code" | "credential">("code");
    const [connectMode, setConnectMode] = useState<"pair" | "link">("pair");
    return (
        <div className="space-y-4">
            <div className="rounded-lg border border-white/[0.06] bg-surface-hover p-4">
                <h4 className="flex items-center gap-2 text-sm font-medium text-white">
                    <KeyRound className="h-4 w-4" />
                    Share my library
                </h4>
                <p className="mt-1 text-xs text-gray-400">
                    Give another soundspan instance read access to this library.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                    <RoleModeButton
                        active={shareMode === "code"}
                        onSelect={() => setShareMode("code")}
                    >
                        Pairing code
                    </RoleModeButton>
                    <RoleModeButton
                        active={shareMode === "credential"}
                        onSelect={() => setShareMode("credential")}
                    >
                        Host credential
                    </RoleModeButton>
                </div>
                <div className="mt-3">
                    {shareMode === "code" ? (
                        <PairingCodePanel
                            busy={props.busy}
                            pairingCode={props.pairingCode}
                            onCreate={props.onCreateCode}
                        />
                    ) : (
                        <HostCredentialForm
                            onSubmit={props.onHost}
                            busy={props.busy}
                        />
                    )}
                </div>
            </div>
            <div className="rounded-lg border border-white/[0.06] bg-surface-hover p-4">
                <h4 className="flex items-center gap-2 text-sm font-medium text-white">
                    <LinkIcon className="h-4 w-4" />
                    Connect to a library
                </h4>
                <p className="mt-1 text-xs text-gray-400">
                    Use a pairing code or token another admin gave you to read
                    their library.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                    <RoleModeButton
                        active={connectMode === "pair"}
                        onSelect={() => setConnectMode("pair")}
                    >
                        Pair with code
                    </RoleModeButton>
                    <RoleModeButton
                        active={connectMode === "link"}
                        onSelect={() => setConnectMode("link")}
                    >
                        Link with token
                    </RoleModeButton>
                </div>
                <div className="mt-3">
                    <ConsumerConnectForm
                        mode={connectMode}
                        onLink={props.onLink}
                        onPair={props.onPair}
                        busy={props.busy}
                    />
                </div>
            </div>
            <p className="text-xs text-gray-500">
                Two-way sharing is two deliberate steps: you connect to them
                here, and they connect to you with a code or credential you
                generate above. Each direction succeeds or fails on its own —
                nothing is set up silently.
            </p>
        </div>
    );
}
