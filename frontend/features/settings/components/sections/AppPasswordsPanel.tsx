"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Copy } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { api } from "@/lib/api";
import type { AppPasswordMetadata, CreatedAppPassword } from "@/lib/api/auth";
import { createFrontendLogger } from "@/lib/logger";
import { formatDate } from "@/utils/formatTime";

const logger = createFrontendLogger("Settings.AppPasswordsPanel");

interface SecretDisplayProps {
    credential: CreatedAppPassword;
    copied: boolean;
    onCopy: () => void;
    onDismiss: () => void;
}

function SecretDisplay({
    credential,
    copied,
    onCopy,
    onDismiss,
}: SecretDisplayProps) {
    return (
        <div className="space-y-3 rounded-lg border border-yellow-700/50 bg-yellow-900/20 p-4">
            <h4 className="text-sm font-medium text-yellow-200">
                Your new app password
            </h4>
            <div className="flex items-center gap-2">
                <input
                    aria-label="New app password"
                    readOnly
                    value={credential.secret}
                    className="min-w-0 flex-1 rounded border border-yellow-700/50 bg-black/50 px-3 py-2 font-mono text-sm text-white"
                />
                <button
                    type="button"
                    onClick={onCopy}
                    className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-1.5 text-sm font-medium text-black"
                >
                    <Copy className="h-4 w-4" />
                    {copied ? "Copied!" : "Copy"}
                </button>
            </div>
            <p className="text-xs text-yellow-200">
                Save it now. You won&apos;t see this again.
            </p>
            <div className="flex justify-end">
                <button
                    type="button"
                    onClick={onDismiss}
                    className="text-sm text-gray-400 hover:text-white"
                >
                    Dismiss
                </button>
            </div>
        </div>
    );
}

interface AppPasswordRowProps {
    credential: AppPasswordMetadata;
    onRevoke: (credential: AppPasswordMetadata) => void;
}

function AppPasswordRow({ credential, onRevoke }: AppPasswordRowProps) {
    return (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-white/5 bg-white/[0.03] p-4">
            <div>
                <p className="text-sm font-medium text-white">
                    {credential.displayName}
                </p>
                <p className="mt-0.5 text-xs text-gray-400">
                    Created {formatDate(credential.createdAt)} · Last used{" "}
                    {credential.lastUsedAt
                        ? formatDate(credential.lastUsedAt)
                        : "Never"}
                </p>
            </div>
            <button
                type="button"
                onClick={() => onRevoke(credential)}
                className="text-sm text-red-400 hover:text-red-300"
            >
                Revoke
            </button>
        </div>
    );
}

interface AppPasswordFormProps {
    displayName: string;
    creating: boolean;
    onDisplayNameChange: (value: string) => void;
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function AppPasswordForm({
    displayName,
    creating,
    onDisplayNameChange,
    onSubmit,
}: AppPasswordFormProps) {
    return (
        <form onSubmit={onSubmit} className="flex items-end gap-3">
            <div className="min-w-0 flex-1">
                <label
                    htmlFor="app-password-display-name"
                    className="mb-1.5 block text-sm text-gray-300"
                >
                    Name
                </label>
                <input
                    id="app-password-display-name"
                    value={displayName}
                    onChange={(event) =>
                        onDisplayNameChange(event.target.value)
                    }
                    maxLength={64}
                    placeholder="e.g. Phone or living room player"
                    className="w-full rounded-md border-0 bg-line-strong px-3 py-2 text-sm text-white outline-none placeholder:text-gray-400 focus:bg-line-muted"
                />
            </div>
            <button
                type="submit"
                disabled={!displayName.trim() || creating}
                className="rounded-full bg-white px-4 py-2 text-sm font-medium text-black hover:scale-105 disabled:opacity-50"
            >
                {creating ? "Creating..." : "Create app password"}
            </button>
        </form>
    );
}

interface AppPasswordListProps {
    credentials: AppPasswordMetadata[];
    loading: boolean;
    onRevoke: (credential: AppPasswordMetadata) => void;
}

function AppPasswordList({
    credentials,
    loading,
    onRevoke,
}: AppPasswordListProps) {
    if (loading) {
        return (
            <p className="text-sm text-gray-400">Loading app passwords...</p>
        );
    }
    if (credentials.length === 0) {
        return (
            <p className="text-sm text-gray-400">No app passwords created.</p>
        );
    }
    return credentials.map((credential) => (
        <AppPasswordRow
            key={credential.id}
            credential={credential}
            onRevoke={onRevoke}
        />
    ));
}

interface RevokeModalProps {
    credential: AppPasswordMetadata | null;
    revoking: boolean;
    error: string;
    onClose: () => void;
    onConfirm: () => void;
}

function RevokeModal({
    credential,
    revoking,
    error,
    onClose,
    onConfirm,
}: RevokeModalProps) {
    return (
        <Modal
            isOpen={credential !== null}
            onClose={onClose}
            title="Revoke app password"
        >
            <div className="space-y-4">
                <p className="text-sm text-gray-300">
                    Revoke {credential?.displayName}? Apps using it will stop
                    connecting.
                </p>
                {error && (
                    <p role="alert" className="text-sm text-red-400">
                        {error}
                    </p>
                )}
                <div className="flex justify-end gap-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 text-sm text-gray-400 hover:text-white"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={revoking}
                        className="rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                        {revoking ? "Revoking..." : "Revoke"}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

function useAppPasswordData() {
    const [credentials, setCredentials] = useState<AppPasswordMetadata[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    useEffect(() => {
        let active = true;
        void api
            .listAppPasswords()
            .then((result) => {
                if (active) setCredentials(result.appPasswords);
            })
            .catch((error: unknown) => {
                logger.error("Failed to load app passwords", { error });
                if (active) setLoadError("Failed to load app passwords");
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => {
            active = false;
        };
    }, []);
    return { credentials, setCredentials, loading, loadError };
}

function appPasswordMetadata(
    credential: CreatedAppPassword,
): AppPasswordMetadata {
    return {
        id: credential.id,
        displayName: credential.displayName,
        createdAt: credential.createdAt,
        lastUsedAt: credential.lastUsedAt,
    };
}

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}

function useAppPasswordCreation(
    addCredential: (credential: AppPasswordMetadata) => void,
) {
    const [displayName, setDisplayName] = useState("");
    const [created, setCreated] = useState<CreatedAppPassword | null>(null);
    const [creating, setCreating] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState("");
    const create = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const name = displayName.trim();
        if (!name) return;
        setCreating(true);
        setError("");
        try {
            const result = await api.createAppPassword(name);
            setCreated(result.appPassword);
            addCredential(appPasswordMetadata(result.appPassword));
            setDisplayName("");
            setCopied(false);
        } catch (createError) {
            setError(
                errorMessage(createError, "Failed to create app password"),
            );
        } finally {
            setCreating(false);
        }
    };
    const copy = async () => {
        if (!created) return;
        try {
            await navigator.clipboard.writeText(created.secret);
            setCopied(true);
        } catch (copyError) {
            logger.error("Failed to copy app password", { error: copyError });
            setError("Failed to copy app password");
        }
    };
    const dismiss = () => {
        setCreated(null);
        setCopied(false);
    };
    return {
        displayName,
        setDisplayName,
        created,
        creating,
        copied,
        error,
        create,
        copy,
        dismiss,
    };
}

function useAppPasswordRevocation(removeCredential: (id: string) => void) {
    const [credential, setCredential] = useState<AppPasswordMetadata | null>(
        null,
    );
    const [revoking, setRevoking] = useState(false);
    const [error, setError] = useState("");
    const revoke = async () => {
        if (!credential) return;
        setRevoking(true);
        setError("");
        try {
            await api.revokeAppPassword(credential.id);
            removeCredential(credential.id);
            setCredential(null);
        } catch (revokeError) {
            setError(
                revokeError instanceof Error
                    ? revokeError.message
                    : "Failed to revoke app password",
            );
        } finally {
            setRevoking(false);
        }
    };
    const close = () => {
        setCredential(null);
        setError("");
    };
    return { credential, setCredential, revoking, error, revoke, close };
}

/** Renders app-password creation and revocation controls for OpenSubsonic clients. */
export function AppPasswordsPanel() {
    const data = useAppPasswordData();
    const creation = useAppPasswordCreation((credential) =>
        data.setCredentials((current) => [credential, ...current]),
    );
    const revocation = useAppPasswordRevocation((id) =>
        data.setCredentials((current) =>
            current.filter((credential) => credential.id !== id),
        ),
    );
    const visibleError = creation.error || data.loadError;

    return (
        <div className="space-y-3 border-t border-white/5 pt-5">
            <div>
                <h3 className="text-sm font-medium text-white">
                    App passwords
                </h3>
                <p className="mt-0.5 text-xs text-gray-400">
                    Use app passwords in OpenSubsonic apps instead of your
                    account password.
                </p>
            </div>
            {creation.created && (
                <SecretDisplay
                    credential={creation.created}
                    copied={creation.copied}
                    onCopy={() => void creation.copy()}
                    onDismiss={creation.dismiss}
                />
            )}
            <AppPasswordForm
                displayName={creation.displayName}
                creating={creation.creating}
                onDisplayNameChange={creation.setDisplayName}
                onSubmit={(event) => void creation.create(event)}
            />
            {visibleError && !revocation.credential && (
                <p role="alert" className="text-sm text-red-400">
                    {visibleError}
                </p>
            )}
            <AppPasswordList
                credentials={data.credentials}
                loading={data.loading}
                onRevoke={revocation.setCredential}
            />
            <RevokeModal
                credential={revocation.credential}
                revoking={revocation.revoking}
                error={revocation.error}
                onClose={revocation.close}
                onConfirm={() => void revocation.revoke()}
            />
        </div>
    );
}
