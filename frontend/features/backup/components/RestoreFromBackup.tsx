"use client";

import { useState } from "react";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import {
    BACKUP_FILE_EXTENSION,
    validateBackupPassphrase,
} from "../backupRestoreModel";
import { useRestoreFlow } from "../hooks/useRestoreFlow";
import {
    OtherUploadView,
    ReconnectingView,
    RestoreCompleteView,
    RestoreUnavailableView,
    RestoreFailedView,
    RestoreRunningView,
    UploadProgressView,
} from "./RestoreProgressViews";

const INPUT_CLASS =
    "w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all";
const PRIMARY_BUTTON_CLASS =
    "w-full py-3.5 bg-brand text-black font-bold rounded-lg hover:bg-brand-dark transition-all disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-brand/30";

function ErrorBox({ message }: { message: string | null }) {
    if (!message) return null;
    return (
        <div
            role="alert"
            className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-sm text-red-400"
        >
            {message}
        </div>
    );
}

function PassphraseField({
    value,
    onChange,
}: {
    value: string;
    onChange: (value: string) => void;
}) {
    return (
        <div>
            <label
                htmlFor="restore-passphrase"
                className="block text-sm font-medium text-white/90 mb-1.5"
            >
                Backup passphrase
            </label>
            <input
                id="restore-passphrase"
                type="password"
                autoComplete="off"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className={INPUT_CLASS}
                placeholder="The passphrase you chose when you downloaded the backup"
                required
            />
        </div>
    );
}

function RestoreForm({
    error,
    onStart,
}: {
    error: string | null;
    onStart: (file: File, passphrase: string) => void;
}) {
    const [file, setFile] = useState<File | null>(null);
    const [passphrase, setPassphrase] = useState("");
    const [formError, setFormError] = useState<string | null>(null);

    const handleSubmit = (event: React.FormEvent) => {
        event.preventDefault();
        if (!file) {
            setFormError(`Choose a ${BACKUP_FILE_EXTENSION} file.`);
            return;
        }
        const problem = validateBackupPassphrase(passphrase);
        if (problem) {
            setFormError(problem);
            return;
        }
        setFormError(null);
        onStart(file, passphrase);
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-4">
            <div>
                <label
                    htmlFor="restore-file"
                    className="block text-sm font-medium text-white/90 mb-1.5"
                >
                    Backup file
                </label>
                <input
                    id="restore-file"
                    type="file"
                    accept={BACKUP_FILE_EXTENSION}
                    onChange={(event) =>
                        setFile(event.target.files?.[0] ?? null)
                    }
                    className="block w-full text-sm text-white/70 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
                />
            </div>
            <PassphraseField value={passphrase} onChange={setPassphrase} />
            <ErrorBox message={formError ?? error} />
            <button type="submit" className={PRIMARY_BUTTON_CLASS}>
                Restore
            </button>
        </form>
    );
}

function PassphraseRetryForm({
    error,
    onRetry,
    onStartOver,
}: {
    error: string;
    onRetry: (passphrase: string) => void;
    onStartOver: () => void;
}) {
    const [passphrase, setPassphrase] = useState("");
    const [formError, setFormError] = useState<string | null>(null);
    const handleSubmit = (event: React.FormEvent) => {
        event.preventDefault();
        const problem = validateBackupPassphrase(passphrase);
        if (problem) {
            setFormError(problem);
            return;
        }
        setFormError(null);
        onRetry(passphrase);
    };
    return (
        <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-sm text-white/70">
                The file is uploaded. Type the passphrase again to restore it.
            </p>
            <PassphraseField value={passphrase} onChange={setPassphrase} />
            <ErrorBox message={formError ?? error} />
            <button type="submit" className={PRIMARY_BUTTON_CLASS}>
                Restore
            </button>
            <button
                type="button"
                onClick={onStartOver}
                className="w-full py-2 text-sm text-white/60 hover:text-white transition-colors"
            >
                Choose a different file
            </button>
        </form>
    );
}

function BackLink({ onBack }: { onBack?: () => void }) {
    if (!onBack) return null;
    return (
        <button
            type="button"
            onClick={onBack}
            className="text-sm text-white/60 hover:text-white transition-colors"
        >
            Create a new account instead
        </button>
    );
}

function RestoreFlowBody({ onBack }: { onBack?: () => void }) {
    const { flow, start, retryPassphrase, cancel, reset } = useRestoreFlow();
    switch (flow.kind) {
        case "checking":
        case "starting":
            return (
                <div
                    className="flex items-center gap-3 text-white/70"
                    role="status"
                >
                    <GradientSpinner size="sm" />
                    {flow.kind === "checking"
                        ? "Checking the server…"
                        : "Checking the backup and passphrase…"}
                </div>
            );
        case "form":
            return (
                <>
                    <RestoreForm error={flow.error} onStart={start} />
                    <BackLink onBack={onBack} />
                </>
            );
        case "passphrase":
            return (
                <PassphraseRetryForm
                    error={flow.error}
                    onRetry={retryPassphrase}
                    onStartOver={cancel}
                />
            );
        case "uploading":
            return (
                <UploadProgressView
                    sentBytes={flow.sentBytes}
                    totalBytes={flow.totalBytes}
                    onCancel={cancel}
                />
            );
        case "otherUpload":
            return <OtherUploadView expiresAt={flow.expiresAt} />;
        case "unavailable":
            return <RestoreUnavailableView />;
        case "reconnecting":
            return <ReconnectingView />;
        case "restoring":
            return <RestoreRunningView status={flow.status} />;
        case "complete":
            return <RestoreCompleteView status={flow.status} />;
        case "failed":
            return (
                <>
                    <RestoreFailedView
                        message={flow.message}
                        freshInstallIntact={flow.freshInstallIntact}
                        onRetry={reset}
                    />
                    {flow.freshInstallIntact && <BackLink onBack={onBack} />}
                </>
            );
    }
}

/**
 * First-run restore: upload a backup downloaded from another server's Admin
 * page and bring everything in its database back on this fresh install.
 */
export function RestoreFromBackup({ onBack }: { onBack?: () => void }) {
    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-2xl font-bold text-white mb-1">
                    Restore from a backup
                </h2>
                <p className="text-white/60">
                    Bring back accounts, settings, playlists, listening history,
                    and your analyzed library from a backup file. Music files
                    aren&apos;t in the backup, so mount the same music folder on
                    this server first.
                </p>
            </div>
            <RestoreFlowBody onBack={onBack} />
        </div>
    );
}
