"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { api } from "@/lib/api";
import type { ExternalIdentity } from "@/lib/api/auth";
import { createFrontendLogger } from "@/lib/logger";
import { formatDate } from "@/utils/formatTime";

const logger = createFrontendLogger("Settings.LinkedIdentitiesPanel");

interface IdentityCardProps {
    identity: ExternalIdentity;
    providerName: string;
    onUnlink: (identity: ExternalIdentity) => void;
}

function IdentityCard({ identity, providerName, onUnlink }: IdentityCardProps) {
    return (
        <div className="flex items-start justify-between gap-4 rounded-lg border border-white/5 bg-white/[0.03] p-4">
            <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-white">
                        {identity.displayName || identity.email || providerName}
                    </p>
                    <Badge variant="info" title={identity.provider}>
                        {providerName}
                    </Badge>
                </div>
                {identity.email && (
                    <p className="truncate text-xs text-gray-400">
                        {identity.email}
                    </p>
                )}
                <p className="text-xs text-gray-400">
                    Subject {identity.subjectHint} · Linked{" "}
                    {formatDate(identity.createdAt)}
                </p>
            </div>
            <button
                type="button"
                onClick={() => onUnlink(identity)}
                className="text-sm text-red-400 transition-colors hover:text-red-300"
            >
                Unlink
            </button>
        </div>
    );
}

interface UnlinkIdentityModalProps {
    identity: ExternalIdentity | null;
    error: string;
    unlinking: boolean;
    onClose: () => void;
    onConfirm: () => void;
}

function UnlinkIdentityModal({
    identity,
    error,
    unlinking,
    onClose,
    onConfirm,
}: UnlinkIdentityModalProps) {
    return (
        <Modal
            isOpen={identity !== null}
            onClose={onClose}
            title="Unlink SSO account"
        >
            <div className="space-y-4">
                <p className="text-sm text-gray-300">
                    Unlink this identity from your soundspan account?
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
                        disabled={unlinking}
                        className="rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                        {unlinking ? "Unlinking..." : "Unlink"}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

interface LinkedIdentitiesPanelProps {
    providerName: string;
}

interface IdentityListProps extends LinkedIdentitiesPanelProps {
    identities: ExternalIdentity[];
    loading: boolean;
    onUnlink: (identity: ExternalIdentity) => void;
}

function IdentityList({
    identities,
    loading,
    providerName,
    onUnlink,
}: IdentityListProps) {
    if (loading) {
        return <p className="text-sm text-gray-400">Loading identities...</p>;
    }
    if (identities.length === 0) {
        return <p className="text-sm text-gray-400">No SSO identity linked.</p>;
    }
    return identities.map((identity) => (
        <IdentityCard
            key={identity.id}
            identity={identity}
            providerName={providerName}
            onUnlink={onUnlink}
        />
    ));
}

function useIdentityData() {
    const [identities, setIdentities] = useState<ExternalIdentity[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    useEffect(() => {
        let active = true;
        const load = async () => {
            try {
                const result = await api.getExternalIdentities();
                if (active) setIdentities(result.identities);
            } catch (error) {
                logger.error("Failed to load linked identities", { error });
                if (active) setLoadError("Failed to load linked identities");
            } finally {
                if (active) setLoading(false);
            }
        };
        void load();
        return () => {
            active = false;
        };
    }, []);
    return { identities, setIdentities, loading, loadError };
}

function useIdentityLink() {
    const [linking, setLinking] = useState(false);
    const [error, setError] = useState("");
    const link = async () => {
        setLinking(true);
        setError("");
        try {
            const { redirectUrl } = await api.startOidcLink();
            window.location.assign(redirectUrl);
        } catch (linkError) {
            logger.error("Failed to start OIDC link", { error: linkError });
            setError(
                linkError instanceof Error
                    ? linkError.message
                    : "Failed to start SSO linking",
            );
            setLinking(false);
        }
    };
    return { linking, error, link };
}

function useIdentityUnlink(
    setIdentities: Dispatch<SetStateAction<ExternalIdentity[]>>,
) {
    const [unlinking, setUnlinking] = useState(false);
    const [error, setError] = useState("");
    const [credential, setCredential] = useState<ExternalIdentity | null>(null);
    const unlink = async () => {
        if (!credential) return;
        setUnlinking(true);
        setError("");
        try {
            await api.unlinkExternalIdentity(credential.id);
            setIdentities((current) =>
                current.filter((item) => item.id !== credential.id),
            );
            setCredential(null);
        } catch (unlinkError) {
            setError(
                unlinkError instanceof Error
                    ? unlinkError.message
                    : "Failed to unlink identity",
            );
        } finally {
            setUnlinking(false);
        }
    };
    const close = () => {
        setCredential(null);
        setError("");
    };
    return { unlinking, error, credential, setCredential, unlink, close };
}

/** Renders linked OIDC identity controls for the current user. */
export function LinkedIdentitiesPanel({
    providerName,
}: LinkedIdentitiesPanelProps) {
    const { identities, setIdentities, loading, loadError } = useIdentityData();
    const link = useIdentityLink();
    const unlink = useIdentityUnlink(setIdentities);
    const visibleError = link.error || loadError;

    return (
        <div className="space-y-3">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h3 className="text-sm font-medium text-white">
                        Linked identities
                    </h3>
                    <p className="mt-0.5 text-xs text-gray-400">
                        Manage the SSO accounts that can sign in as you.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => void link.link()}
                    disabled={link.linking}
                    className="rounded-full bg-white px-4 py-1.5 text-sm font-medium text-black transition-transform hover:scale-105 disabled:opacity-50"
                >
                    {link.linking
                        ? "Opening SSO..."
                        : `Link ${providerName} account`}
                </button>
            </div>
            {visibleError && !unlink.credential && (
                <p role="alert" className="text-sm text-red-400">
                    {visibleError}
                </p>
            )}
            <IdentityList
                identities={identities}
                loading={loading}
                providerName={providerName}
                onUnlink={unlink.setCredential}
            />
            <UnlinkIdentityModal
                identity={unlink.credential}
                error={unlink.error}
                unlinking={unlink.unlinking}
                onClose={unlink.close}
                onConfirm={() => void unlink.unlink()}
            />
        </div>
    );
}
