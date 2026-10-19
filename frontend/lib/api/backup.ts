import { type ApiClientConstructor } from "./core";

/** Phases a restore reports while it runs, in order. */
export type RestoreState =
    | "idle"
    | "uploading"
    | "validating"
    | "resetting"
    | "replaying"
    | "loading"
    | "migrating"
    | "reencrypting"
    | "complete"
    | "failed";

/** What a finished restore brought back. */
export interface RestoreSummary {
    backupCreatedAt: string;
    backupAppVersion: string;
    appVersion: string;
    tables: number;
    rows: number;
    migrationsAppliedAfterLoad: number;
    credentialsReencrypted: number;
    credentialsUndecryptable: number;
    apiKeysNeedReissue: boolean;
}

/** Restore progress as reported by `GET /api/restore/status`. */
export interface RestoreStatus {
    available: boolean;
    state: RestoreState;
    progress: {
        completedTables: number;
        totalTables: number;
        completedRows: number;
        totalRows: number;
    } | null;
    error: { code: string; message: string } | null;
    summary: RestoreSummary | null;
    restartRequired: boolean;
}

/** A chunked upload session for a backup file. */
export interface RestoreUploadSession {
    uploadId: string;
    chunkSizeBytes: number;
    totalChunks: number;
    expiresAt: string;
}

/** The backup a validated upload will restore. */
export interface RestoreStartResult {
    restoreId: string;
    backupCreatedAt: string;
    backupAppVersion: string;
    appVersion: string;
}

/** Error raised by a failed chunk upload, shaped like core request errors. */
export interface RestoreChunkError extends Error {
    status: number;
    data: { error?: string; code?: string };
}

async function toChunkError(response: Response): Promise<RestoreChunkError> {
    const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
    };
    const error = new Error(
        data.error || "The backup upload failed.",
    ) as RestoreChunkError;
    error.status = response.status;
    error.data = data;
    return error;
}

/** Add backup and restore operations to an API client base class. */
export function WithBackup<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class BackupApi extends Base {
        /**
         * Wrap this server's encryption key with `passphrase` and grant the
         * browser a five-minute, single-use cookie for the backup download
         * (admin only). Responds 204.
         */
        async createBackupDownloadSession(passphrase: string): Promise<void> {
            await this.request<void>("/backup/session", {
                method: "POST",
                body: JSON.stringify({ passphrase }),
            });
        }

        /** Read restore availability and progress (no sign-in needed). */
        async getRestoreStatus(): Promise<RestoreStatus> {
            return this.request<RestoreStatus>("/restore/status");
        }

        /** Open a chunked upload for a backup file of `sizeBytes` bytes. */
        async startRestoreUpload(
            sizeBytes: number,
        ): Promise<RestoreUploadSession> {
            return this.request<RestoreUploadSession>("/restore/uploads", {
                method: "POST",
                body: JSON.stringify({ sizeBytes }),
            });
        }

        /**
         * Send one chunk of the backup file. Uses a raw fetch because the
         * shared request helper always sends JSON.
         */
        async uploadRestoreChunk(
            uploadId: string,
            index: number,
            chunk: Blob,
            signal?: AbortSignal,
        ): Promise<void> {
            const response = await fetch(
                `${this.getBaseUrl()}/api/restore/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/octet-stream" },
                    body: chunk,
                    credentials: "include",
                    signal,
                },
            );
            if (!response.ok) {
                throw await toChunkError(response);
            }
        }

        /** Check the passphrase and start restoring the uploaded backup. */
        async completeRestoreUpload(
            uploadId: string,
            passphrase: string,
        ): Promise<RestoreStartResult> {
            return this.request<RestoreStartResult>(
                `/restore/uploads/${encodeURIComponent(uploadId)}/complete`,
                {
                    method: "POST",
                    body: JSON.stringify({ passphrase }),
                },
            );
        }

        /** Cancel an upload and delete what the server staged for it. */
        async cancelRestoreUpload(uploadId: string): Promise<void> {
            await this.request<void>(
                `/restore/uploads/${encodeURIComponent(uploadId)}`,
                { method: "DELETE" },
            );
        }
    }
    return BackupApi;
}
