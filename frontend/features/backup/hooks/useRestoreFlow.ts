"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { createFrontendLogger } from "@/lib/logger";
import { RESTORE_STATUS_POLL_MS } from "../backupRestoreModel";
import {
    flowFromStartError,
    flowFromStatus,
    type RestoreFlow,
} from "../restoreFlowModel";
import { uploadBackupFile } from "../restoreUploader";

export type { RestoreFlow } from "../restoreFlowModel";

const logger = createFrontendLogger("Backup.useRestoreFlow");

/** Consecutive failed status checks before the page stops asking. */
const MAX_STATUS_FAILURES = 30;
const LOST_CONTACT =
    "Lost contact with the server. Reload this page to check on the restore.";

/** The restore flow plus the actions the page can take. */
export interface RestoreFlowControls {
    flow: RestoreFlow;
    start: (file: File, passphrase: string) => void;
    retryPassphrase: (passphrase: string) => void;
    cancel: () => void;
    reset: () => void;
}

function abortedByUser(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

/** Ask the server to drop a half-finished upload; failures only log. */
function discardUpload(uploadId: { current: string | null }): void {
    const id = uploadId.current;
    uploadId.current = null;
    if (!id) return;
    void api.cancelRestoreUpload(id).catch((error: unknown) => {
        logger.warn("Could not cancel the restore upload", error);
    });
}

/**
 * Follow `GET /api/restore/status` until the restore stops running. Each
 * check is scheduled on a timer through a ref, so a check can queue the next
 * one without the callback referring to itself.
 */
function useRestoreStatusPolling(setFlow: (flow: RestoreFlow) => void) {
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const failures = useRef(0);
    const mounted = useRef(true);
    const runCheck = useRef<() => void>(() => undefined);

    const stop = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
    }, []);

    const schedule = useCallback(
        (delayMs: number) => {
            stop();
            timer.current = setTimeout(() => runCheck.current(), delayMs);
        },
        [stop],
    );

    const handleFailure = useCallback(
        (error: unknown) => {
            failures.current += 1;
            logger.warn("Restore status check failed", error);
            if (!mounted.current) return;
            if (failures.current >= MAX_STATUS_FAILURES) {
                setFlow({
                    kind: "failed",
                    message: LOST_CONTACT,
                    freshInstallIntact: false,
                });
                return;
            }
            schedule(RESTORE_STATUS_POLL_MS);
        },
        [schedule, setFlow],
    );

    const check = useCallback(async () => {
        try {
            const status = await api.getRestoreStatus();
            failures.current = 0;
            if (!mounted.current) return;
            const next = flowFromStatus(status);
            setFlow(next);
            if (next.kind === "restoring") schedule(RESTORE_STATUS_POLL_MS);
        } catch (error) {
            handleFailure(error);
        }
    }, [handleFailure, schedule, setFlow]);

    useEffect(() => {
        runCheck.current = () => void check();
    }, [check]);

    useEffect(() => {
        mounted.current = true;
        schedule(0);
        return () => {
            mounted.current = false;
            stop();
        };
    }, [schedule, stop]);

    const pollNow = useCallback(() => schedule(0), [schedule]);
    return { pollNow, stop, mounted };
}

/**
 * Drive a fresh-install restore: upload the backup in chunks, start the
 * restore, then follow its progress until it completes or fails. A page
 * reload during a restore picks the progress back up from the server, and a
 * wrong passphrase keeps the uploaded file so only the passphrase is retyped.
 */
export function useRestoreFlow(): RestoreFlowControls {
    const [flow, setFlow] = useState<RestoreFlow>({ kind: "checking" });
    const { pollNow, stop, mounted } = useRestoreStatusPolling(setFlow);
    const uploadAbort = useRef<AbortController | null>(null);
    const uploadId = useRef<string | null>(null);

    useEffect(() => () => uploadAbort.current?.abort(), []);

    const finishStart = useCallback(
        async (id: string, passphrase: string) => {
            setFlow({ kind: "starting" });
            await api.completeRestoreUpload(id, passphrase);
            uploadId.current = null;
            setFlow({ kind: "restoring", status: null });
            pollNow();
        },
        [pollNow],
    );

    const handleStartError = useCallback(
        (error: unknown) => {
            if (!mounted.current) return;
            if (abortedByUser(error)) {
                discardUpload(uploadId);
                setFlow({ kind: "form", error: null });
                return;
            }
            logger.error("Restore did not start", error);
            const next = flowFromStartError(error, uploadId.current !== null);
            if (next.kind === "form") discardUpload(uploadId);
            setFlow(next);
        },
        [mounted],
    );

    const runUpload = useCallback(
        async (file: File, passphrase: string) => {
            const abort = new AbortController();
            uploadAbort.current = abort;
            setFlow({ kind: "uploading", sentBytes: 0, totalBytes: file.size });
            const session = await api.startRestoreUpload(file.size);
            uploadId.current = session.uploadId;
            await uploadBackupFile({
                file,
                session,
                uploadChunk: (id, index, chunk, signal) =>
                    api.uploadRestoreChunk(id, index, chunk, signal),
                onProgress: (sentBytes) => {
                    if (!mounted.current) return;
                    setFlow({
                        kind: "uploading",
                        sentBytes,
                        totalBytes: file.size,
                    });
                },
                signal: abort.signal,
            });
            await finishStart(session.uploadId, passphrase);
        },
        [finishStart, mounted],
    );

    const start = useCallback(
        (file: File, passphrase: string) => {
            stop();
            void runUpload(file, passphrase).catch(handleStartError);
        },
        [handleStartError, runUpload, stop],
    );

    const retryPassphrase = useCallback(
        (passphrase: string) => {
            const id = uploadId.current;
            if (!id) {
                setFlow({ kind: "form", error: null });
                return;
            }
            void finishStart(id, passphrase).catch(handleStartError);
        },
        [finishStart, handleStartError],
    );

    const cancel = useCallback(() => {
        uploadAbort.current?.abort();
        discardUpload(uploadId);
        setFlow({ kind: "form", error: null });
    }, []);

    const reset = useCallback(() => {
        setFlow({ kind: "form", error: null });
    }, []);

    return { flow, start, retryPassphrase, cancel, reset };
}
