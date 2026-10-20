import type { RestoreUploadSession } from "@/lib/api/backup";
import {
    MAX_CHUNK_ATTEMPTS,
    chunkRange,
    chunkRetryWaitMs,
    isRetryableChunkError,
} from "./backupRestoreModel";

/** The chunk-upload call the uploader needs; `api.uploadRestoreChunk` fits. */
export type UploadChunk = (
    uploadId: string,
    index: number,
    chunk: Blob,
    signal?: AbortSignal,
) => Promise<void>;

/** Inputs for one backup file upload. */
export interface UploadBackupFileOptions {
    file: Blob;
    session: RestoreUploadSession;
    uploadChunk: UploadChunk;
    onProgress: (sentBytes: number) => void;
    signal: AbortSignal;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Wait `ms`, or reject with an AbortError as soon as `signal` aborts. */
function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("The upload was cancelled.", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, ms);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
    });
}

async function uploadOneChunk(
    options: UploadBackupFileOptions,
    index: number,
    chunk: Blob,
): Promise<void> {
    const wait = options.wait ?? defaultWait;
    for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt += 1) {
        try {
            await options.uploadChunk(
                options.session.uploadId,
                index,
                chunk,
                options.signal,
            );
            return;
        } catch (error) {
            const lastAttempt = attempt === MAX_CHUNK_ATTEMPTS;
            if (
                lastAttempt ||
                options.signal.aborted ||
                !isRetryableChunkError(error)
            ) {
                throw error;
            }
            await wait(chunkRetryWaitMs(error, attempt), options.signal);
        }
    }
}

/**
 * Send a backup file to the server in the chunks the upload session asked
 * for, one at a time and in order, retrying transient failures a few times.
 * Throws the first error that retries can't fix.
 */
export async function uploadBackupFile(
    options: UploadBackupFileOptions,
): Promise<void> {
    const { file, session } = options;
    const expectedChunks = Math.ceil(file.size / session.chunkSizeBytes);
    if (session.totalChunks !== expectedChunks || session.totalChunks < 1) {
        throw new Error(
            "The server planned a different upload than this file needs.",
        );
    }
    for (let index = 0; index < session.totalChunks; index += 1) {
        if (options.signal.aborted) {
            throw new DOMException("The upload was cancelled.", "AbortError");
        }
        const { start, end } = chunkRange(
            index,
            session.chunkSizeBytes,
            file.size,
        );
        await uploadOneChunk(options, index, file.slice(start, end));
        options.onProgress(end);
    }
}
