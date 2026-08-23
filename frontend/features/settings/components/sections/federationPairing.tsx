"use client";

import { useState, type FormEvent } from "react";
import { KeyRound, Link as LinkIcon, Loader2, Plus } from "lucide-react";
import type {
    FederationScope,
    LinkFederationPeerInput,
} from "@/lib/api/federation";

export const DEFAULT_SCOPES: FederationScope[] = [
    "library:read",
    "stream:read",
    "social:read",
];

const inputClassName =
    "w-full rounded-lg border border-white/10 bg-surface px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:border-white/30 focus:outline-none";

const FEDERATION_ERROR_MESSAGES: Record<string, string> = {
    FEDERATION_PEER_UNREACHABLE:
        "Could not reach the peer. Check the URL and that the instance is online.",
    FEDERATION_PEER_TLS:
        "The peer's TLS certificate failed validation. Federation requires a valid HTTPS certificate.",
    FEDERATION_PEER_UNAUTHORIZED:
        "The peer rejected the credential. The token may have been revoked or rotated.",
    FEDERATION_PEER_INVALID:
        "The peer responded, but not like a compatible soundspan instance. Check the URL points at the backend.",
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

/** Maps the host form's share options onto the credential's scope grant. */
export function buildHostScopes(options: {
    embeddings: boolean;
}): FederationScope[] {
    return [
        ...DEFAULT_SCOPES,
        ...(options.embeddings ? (["embeddings:read"] as const) : []),
    ];
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
        await onSubmit(name, buildHostScopes({ embeddings }));
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
            <p className="text-xs text-gray-500">
                Online-status sharing is built in: users who turn on “Share
                online presence” in their Social settings appear in the other
                server’s Social tab. Nothing is shared for users who haven’t
                opted in.
            </p>
            <SubmitButton busy={busy} label="Issue credential" />
        </form>
    );
}

/** Client-role form: connect to a host with the credential they issued. */
export function ConsumerConnectForm({
    onLink,
    busy,
}: {
    onLink: (name: string, baseUrl: string, token: string) => Promise<void>;
    busy: boolean;
}) {
    const [name, setName] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    const [token, setToken] = useState("");
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        await onLink(name, baseUrl, token);
        setToken("");
    };
    return (
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
            <label className="block text-xs text-gray-300">
                Peer name
                <input
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
                Token
                <input
                    required
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    className={`${inputClassName} mt-1`}
                    autoComplete="off"
                />
            </label>
            <SubmitButton busy={busy} label="Connect with token" />
        </form>
    );
}

export interface FederationAddPanelProps {
    busy: boolean;
    onHost: (name: string, scopes: FederationScope[]) => Promise<void>;
    onLink: (name: string, baseUrl: string, token: string) => Promise<void>;
}

/** Explicit host/client pairing panel: share and connect are separate acts. */
export function FederationAddPanel(props: FederationAddPanelProps) {
    return (
        <div className="space-y-4">
            <div className="rounded-lg border border-white/[0.06] bg-surface-hover p-4">
                <h4 className="flex items-center gap-2 text-sm font-medium text-white">
                    <KeyRound className="h-4 w-4" />
                    Share my library
                </h4>
                <p className="mt-1 text-xs text-gray-400">
                    Give another soundspan instance read access to this library.
                    Issue a credential and send it to the other admin — it is
                    shown once.
                </p>
                <div className="mt-3">
                    <HostCredentialForm
                        onSubmit={props.onHost}
                        busy={props.busy}
                    />
                </div>
            </div>
            <div className="rounded-lg border border-white/[0.06] bg-surface-hover p-4">
                <h4 className="flex items-center gap-2 text-sm font-medium text-white">
                    <LinkIcon className="h-4 w-4" />
                    Connect to a library
                </h4>
                <p className="mt-1 text-xs text-gray-400">
                    Use the token another admin issued for you to read their
                    library.
                </p>
                <div className="mt-3">
                    <ConsumerConnectForm
                        onLink={props.onLink}
                        busy={props.busy}
                    />
                </div>
            </div>
            <p className="text-xs text-gray-500">
                Two-way sharing is two deliberate steps: you connect to them
                with a token they issued, and they connect to you with a
                credential you issue above. Each direction succeeds or fails on
                its own — nothing is set up silently.
            </p>
        </div>
    );
}
