"use client";

/**
 * Admin backup download. The backend wraps this server's encryption key with
 * the passphrase the admin types, then grants the browser a short-lived,
 * single-use cookie for the download path; the browser then downloads the
 * file natively so even very large backups stream straight to disk.
 */

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { SettingsSection } from "../ui";
import { api } from "@/lib/api";
import { createFrontendLogger } from "@/lib/logger";
import { BRAND_NAME } from "@/lib/brand";
import {
    BACKUP_FILE_EXTENSION,
    MIN_BACKUP_PASSPHRASE_LENGTH,
    readApiErrorCode,
    readApiErrorStatus,
    validateBackupPassphrase,
} from "@/features/backup/backupRestoreModel";

const logger = createFrontendLogger("Settings.BackupSection");

const INPUT_CLASS =
    "w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-brand/30";

type BackupStatus =
    | { kind: "idle" }
    | { kind: "preparing" }
    | { kind: "started" }
    | { kind: "error"; message: string };

/** Start a native browser download of the backup file from `url`. */
export function startBackupDownload(doc: Document, url: string): void {
    const link = doc.createElement("a");
    link.href = url;
    link.download = "";
    link.rel = "noopener";
    doc.body.appendChild(link);
    link.click();
    link.remove();
}

function errorMessageFor(error: unknown): string {
    if (readApiErrorCode(error) === "BACKUP_IN_PROGRESS") {
        return "Another backup is running. Try again when it finishes.";
    }
    if (readApiErrorStatus(error) === 429) {
        return "Too many backup requests. Wait a few minutes, then try again.";
    }
    return "Couldn't start the backup. Check the backend logs and try again.";
}

function StatusLine({ status }: { status: BackupStatus }) {
    if (status.kind === "error") {
        return (
            <p role="alert" className="mt-3 text-xs text-red-300">
                {status.message}
            </p>
        );
    }
    const text =
        status.kind === "started"
            ? "Your browser is downloading the backup. Large libraries take a while. Check your browser's downloads list: if the download failed or stopped early, start a new backup here. The download link works once and expires after five minutes."
            : `The file is named ${BRAND_NAME}-backup-<date>${BACKUP_FILE_EXTENSION}.`;
    return (
        <p role="status" className="mt-3 text-xs text-gray-400">
            {text}
        </p>
    );
}

/** Render the admin backup download controls. */
export function BackupSection() {
    const [passphrase, setPassphrase] = useState("");
    const [confirmation, setConfirmation] = useState("");
    const [status, setStatus] = useState<BackupStatus>({ kind: "idle" });
    const busy = status.kind === "preparing";

    const handleDownload = async (event: React.FormEvent) => {
        event.preventDefault();
        const problem = validateBackupPassphrase(passphrase, confirmation);
        if (problem) {
            setStatus({ kind: "error", message: problem });
            return;
        }
        setStatus({ kind: "preparing" });
        try {
            await api.createBackupDownloadSession(passphrase);
            startBackupDownload(document, api.getBackupDownloadUrl());
            setPassphrase("");
            setConfirmation("");
            setStatus({ kind: "started" });
        } catch (error) {
            logger.error("Failed to start the backup download", error);
            setStatus({ kind: "error", message: errorMessageFor(error) });
        }
    };

    return (
        <SettingsSection
            id="backup"
            title="Backup"
            description={`Download everything in ${BRAND_NAME}'s database: accounts, settings, service connections, playlists, listening history, and your analyzed library. Music files are not included. To restore, deploy a fresh ${BRAND_NAME}, mount your music, and choose Restore from a backup on the first-run screen.`}
        >
            <form onSubmit={handleDownload} className="space-y-3 max-w-md">
                <p className="text-xs text-gray-400">
                    Choose a passphrase of at least{" "}
                    {MIN_BACKUP_PASSPHRASE_LENGTH} characters. It protects the
                    stored passwords and service connections in the file, and
                    the backup can&apos;t be restored without it. The file also
                    holds personal data, so keep it somewhere private.
                </p>
                <label className="block space-y-1">
                    <span className="text-xs text-gray-300">
                        Backup passphrase
                    </span>
                    <input
                        type="password"
                        autoComplete="new-password"
                        value={passphrase}
                        onChange={(event) => setPassphrase(event.target.value)}
                        className={INPUT_CLASS}
                    />
                </label>
                <label className="block space-y-1">
                    <span className="text-xs text-gray-300">
                        Confirm backup passphrase
                    </span>
                    <input
                        type="password"
                        autoComplete="new-password"
                        value={confirmation}
                        onChange={(event) =>
                            setConfirmation(event.target.value)
                        }
                        className={INPUT_CLASS}
                    />
                </label>
                <button
                    type="submit"
                    disabled={busy}
                    className="inline-flex items-center gap-2 px-4 py-1.5 text-sm bg-white text-black font-medium rounded-full hover:scale-105 transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {busy ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                        <Download className="w-4 h-4" />
                    )}
                    Download backup
                </button>
            </form>
            <StatusLine status={status} />
        </SettingsSection>
    );
}
