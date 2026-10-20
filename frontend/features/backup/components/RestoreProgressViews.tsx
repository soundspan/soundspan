"use client";

import { CheckCircle2, AlertTriangle } from "lucide-react";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import type { RestoreStatus } from "@/lib/api/backup";
import { BRAND_NAME, BRAND_SLUG } from "@/lib/brand";
import { formatBytes } from "@/features/library-health/format";
import {
    restorePhaseLabel,
    restoreProgressPercent,
} from "../backupRestoreModel";

/** Restart commands shown after a restore, one per deployment type. */
export const RESTART_COMMANDS: ReadonlyArray<{
    label: string;
    command: string;
}> = [
    {
        label: "All-in-one container",
        command: `docker restart ${BRAND_SLUG}`,
    },
    { label: "Docker Compose", command: "docker compose restart" },
    {
        label: "Kubernetes (Helm)",
        command:
            "kubectl -n <namespace> rollout restart deployment -l app.kubernetes.io/instance=<release>",
    },
];

function ProgressBar({
    percent,
    label,
}: {
    percent: number | null;
    label: string;
}) {
    return (
        <div
            className="h-2 w-full rounded-full bg-white/10 overflow-hidden"
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
        >
            <div
                className={`h-full bg-brand transition-all ${percent === null ? "w-1/3 animate-pulse" : ""}`}
                style={percent === null ? undefined : { width: `${percent}%` }}
            />
        </div>
    );
}

/** Upload progress while the backup file goes to the server. */
export function UploadProgressView({
    sentBytes,
    totalBytes,
    onCancel,
}: {
    sentBytes: number;
    totalBytes: number;
    onCancel: () => void;
}) {
    const percent =
        totalBytes > 0 ? Math.floor((sentBytes / totalBytes) * 100) : 0;
    return (
        <div className="space-y-4">
            <p className="text-white/80 text-sm">
                Uploading the backup: {formatBytes(sentBytes)} of{" "}
                {formatBytes(totalBytes)}. Keep this page open until the upload
                finishes; leaving the page cancels it.
            </p>
            <ProgressBar percent={percent} label="Backup upload progress" />
            <button
                type="button"
                onClick={onCancel}
                className="px-4 py-2 text-sm text-white/70 border border-white/10 rounded-lg hover:text-white hover:bg-white/10 transition-colors"
            >
                Cancel upload
            </button>
        </div>
    );
}

/** An upload that another page or tab started holds the server's upload slot. */
export function OtherUploadView({ expiresAt }: { expiresAt: string | null }) {
    return (
        <div className="space-y-2" role="status">
            <p className="text-white/80 text-sm">
                Another upload of a backup is in progress on this server.
            </p>
            <p className="text-sm text-white/60">
                {expiresAt
                    ? `If it was yours and its page was closed, it expires by ${new Date(expiresAt).toLocaleTimeString()}. This page updates when it ends.`
                    : "This page updates when it ends."}
            </p>
        </div>
    );
}

/** Server-side restore progress. */
export function RestoreRunningView({
    status,
}: {
    status: RestoreStatus | null;
}) {
    const state = status?.state ?? "validating";
    const progress = status?.progress ?? null;
    return (
        <div className="space-y-4">
            <div className="flex items-center gap-3">
                <GradientSpinner size="sm" />
                <p className="text-white font-medium" role="status">
                    {restorePhaseLabel(state)}
                </p>
            </div>
            <ProgressBar
                percent={restoreProgressPercent(progress)}
                label="Restore progress"
            />
            {progress && progress.totalRows > 0 && (
                <p className="text-xs text-white/50">
                    {progress.completedRows.toLocaleString()} of{" "}
                    {progress.totalRows.toLocaleString()} rows in{" "}
                    {progress.completedTables} of {progress.totalTables} tables
                </p>
            )}
            <p className="text-sm text-white/60">
                The restore runs on the server. You can close this page and come
                back; it keeps going.
            </p>
        </div>
    );
}

function RestoreSummaryList({ status }: { status: RestoreStatus }) {
    const summary = status.summary;
    if (!summary) return null;
    return (
        <ul className="text-sm text-white/70 space-y-1 list-disc pl-5">
            <li>
                Restored {summary.rows.toLocaleString()} rows in{" "}
                {summary.tables} tables from a backup taken{" "}
                {new Date(summary.backupCreatedAt).toLocaleString()} on version{" "}
                {summary.backupAppVersion}.
            </li>
            {summary.migrationsAppliedAfterLoad > 0 && (
                <li>
                    Upgraded the restored data to version {summary.appVersion}.
                </li>
            )}
            {summary.credentialsUndecryptable > 0 && (
                <li>
                    {summary.credentialsUndecryptable} stored credentials
                    couldn&apos;t be read and need to be entered again.
                </li>
            )}
            {summary.migrationChecksumWarnings > 0 && (
                <li>
                    {summary.migrationChecksumWarnings} of the backup&apos;s
                    database changes were recorded differently than this
                    version&apos;s copies; the restore used this version&apos;s.
                </li>
            )}
            {summary.apiKeysNeedReissue && (
                <li>
                    API keys, linked devices, and incoming federation peers need
                    new credentials, because this server signs them with a
                    different key.
                </li>
            )}
        </ul>
    );
}

function RestartInstructions() {
    return (
        <div className="space-y-2">
            <p className="text-sm text-white/70">
                Restart every {BRAND_NAME} container or pod. For example:
            </p>
            <ul className="space-y-2">
                {RESTART_COMMANDS.map(({ label, command }) => (
                    <li key={label}>
                        <p className="text-xs text-white/50">{label}</p>
                        <code className="block text-xs text-white/90 bg-black/40 border border-white/10 rounded px-3 py-2 break-all">
                            {command}
                        </code>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** The data is restored, but the last steps need a restart to finish. */
export function RestoreIncompleteView({ message }: { message: string }) {
    return (
        <div className="space-y-4">
            <div
                role="alert"
                className="flex items-start gap-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4"
            >
                <AlertTriangle
                    className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5"
                    aria-hidden="true"
                />
                <p className="text-sm text-yellow-200">{message}</p>
            </div>
            <RestartInstructions />
            <p className="text-sm text-white/70">
                After the restart, sign in with an account from your backup.
            </p>
        </div>
    );
}

/** Restore finished: explain the restart that completes it. */
export function RestoreCompleteView({ status }: { status: RestoreStatus }) {
    return (
        <div className="space-y-4">
            <div className="flex items-center gap-3" role="status">
                <CheckCircle2
                    className="w-6 h-6 text-green-400"
                    aria-hidden="true"
                />
                <h3 className="text-lg font-semibold text-white">
                    {status.restartRequired
                        ? `Restore complete. Restart ${BRAND_NAME} to finish.`
                        : "Restore complete."}
                </h3>
            </div>
            <RestoreSummaryList status={status} />
            {status.restartRequired && <RestartInstructions />}
            <p className="text-sm text-white/70">
                {status.restartRequired
                    ? "After the restart, sign in with an account from your backup."
                    : "Sign in with an account from your backup."}
            </p>
        </div>
    );
}

/** Restore stopped with an error; says whether the fresh install is intact. */
export function RestoreFailedView({
    message,
    freshInstallIntact,
    canRestoreAgain,
    onRetry,
}: {
    message: string;
    freshInstallIntact: boolean;
    canRestoreAgain: boolean;
    onRetry: () => void;
}) {
    return (
        <div className="space-y-4">
            <div
                role="alert"
                className="flex items-start gap-3 bg-red-500/10 border border-red-500/30 rounded-lg p-4"
            >
                <AlertTriangle
                    className="w-5 h-5 text-red-400 shrink-0 mt-0.5"
                    aria-hidden="true"
                />
                <div className="text-sm text-red-300 space-y-1">
                    <p>{message}</p>
                    {freshInstallIntact ? (
                        <p className="text-red-300/80">
                            Nothing was restored. This server is still a fresh
                            install.
                        </p>
                    ) : canRestoreAgain ? (
                        <p className="text-red-300/80">
                            The database may hold part of the backup. Restoring
                            again replaces it.
                        </p>
                    ) : (
                        <p className="text-red-300/80">
                            The database may hold part of the backup. Reset the
                            database (see Reset the database in the Backup and
                            Restore guide), restart {BRAND_NAME}, then reload
                            this page and restore again.
                        </p>
                    )}
                </div>
            </div>
            {canRestoreAgain && (
                <button
                    type="button"
                    onClick={onRetry}
                    className="px-4 py-2 text-sm text-white border border-white/10 rounded-lg hover:bg-white/10 transition-colors"
                >
                    {freshInstallIntact ? "Try again" : "Restore again"}
                </button>
            )}
        </div>
    );
}

/** The server can't take a restore right now; the page keeps checking. */
export function RestoreUnavailableView() {
    return (
        <p className="text-sm text-white/70" role="status">
            This server can&apos;t take a restore right now: it already has an
            account, or a restore holds it. This page keeps checking.
        </p>
    );
}

/** Status checks keep failing; the page keeps retrying with backoff. */
export function ReconnectingView({
    statusUnavailable,
}: {
    statusUnavailable: boolean;
}) {
    return (
        <div className="flex items-center gap-3 text-white/70" role="status">
            <GradientSpinner size="sm" />
            {statusUnavailable
                ? "The server can't report the restore's progress right now (its Redis may be down). Still trying; a restore that is running keeps going."
                : "Can't reach the server right now. Still trying; a restore that is running keeps going on the server."}
        </div>
    );
}
