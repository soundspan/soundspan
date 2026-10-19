"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { createFrontendLogger } from "@/lib/logger";
import {
    classifyStartError,
    flowFromStatus,
    type RestoreFlow,
} from "../restoreFlowModel";
import { uploadBackupFile } from "../restoreUploader";
import { useRestoreStatusPolling } from "./useRestoreStatusPolling";

export type { RestoreFlow } from "../restoreFlowModel";

const logger = createFrontendLogger("Backup.useRestoreFlow");

/** Status steps that show the start went through (or ended already). */
const STARTED_KINDS: ReadonlySet<RestoreFlow["kind"]> = new Set([
    "restoring",
    "complete",
    "restoredIncomplete",
    "failed",
]);

const START_UNCLEAR =
    "Couldn't confirm that the restore started. The file is still uploaded; type the passphrase to try again.";

/** The restore flow plus the actions the page can take. */
export interface RestoreFlowControls {
    flow: RestoreFlow;
    start: (file: File, passphrase: string) => void;
    retryPassphrase: (passphrase: string) => void;
    cancel: () => void;
    reset: () => void;
}

/** One upload-and-start attempt; a newer attempt never touches an older one. */
interface RestoreRun {
    abort: AbortController;
    uploadId: string | null;
    startSent: boolean;
}

/** Marks an error thrown by the start (`/complete`) request. */
class StartRequestError extends Error {
    constructor(readonly cause: unknown) {
        super("The restore start request failed");
    }
}

function abortedByUser(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

/** Ask the server to drop a run's half-finished upload; failures only log. */
function discardRunUpload(run: RestoreRun | null): void {
    const id = run?.uploadId;
    if (!run || !id) return;
    run.uploadId = null;
    void api.cancelRestoreUpload(id).catch((error: unknown) => {
        logger.warn("Could not cancel the restore upload", error);
    });
}

/**
 * Leaving the page mid-upload (close, reload, navigate) cancels the upload
 * on the server, so the fresh install's single upload slot is not held until
 * it expires. Once the start request is sent the upload belongs to the
 * restore, so it is left alone.
 */
function useReleaseUploadOnExit(getRun: () => RestoreRun | null) {
    useEffect(() => {
        const releaseOnExit = () => {
            const run = getRun();
            if (run?.uploadId && !run.startSent) {
                api.cancelRestoreUploadOnExit(run.uploadId);
            }
        };
        window.addEventListener("pagehide", releaseOnExit);
        return () => {
            window.removeEventListener("pagehide", releaseOnExit);
            const run = getRun();
            run?.abort.abort();
            if (!run?.startSent) discardRunUpload(run);
        };
    }, [getRun]);
}

/**
 * Drive a fresh-install restore: upload the backup in chunks, start the
 * restore, then follow its progress until it completes or fails. A page
 * reload during a restore picks the progress back up from the server, a
 * wrong passphrase keeps the uploaded file so only the passphrase is
 * retyped, and an upload this page didn't start is followed until it ends.
 */
export function useRestoreFlow(): RestoreFlowControls {
    const [flow, setFlow] = useState<RestoreFlow>({ kind: "checking" });
    const { pollNow, stop, mounted } = useRestoreStatusPolling(setFlow);
    const activeRun = useRef<RestoreRun | null>(null);
    const getActiveRun = useCallback(() => activeRun.current, []);
    useReleaseUploadOnExit(getActiveRun);

    const finishStart = useCallback(
        async (run: RestoreRun, passphrase: string) => {
            const id = run.uploadId;
            if (!id) throw new Error("The upload is no longer available.");
            run.startSent = true;
            setFlow({ kind: "starting" });
            try {
                await api.completeRestoreUpload(id, passphrase);
            } catch (error) {
                throw new StartRequestError(error);
            }
            run.uploadId = null;
            if (!mounted.current || activeRun.current !== run) return;
            setFlow({ kind: "restoring", status: null });
            pollNow();
        },
        [mounted, pollNow],
    );

    // A start that failed without a clear answer may still have started the
    // restore: follow it if the status says so, otherwise keep the upload
    // and ask for the passphrase again.
    const recheckAfterUnclearStart = useCallback(
        (run: RestoreRun) => {
            // The start request counts as sent until the re-check decides,
            // so leaving the page meanwhile doesn't cancel an upload the
            // server may be restoring.
            const keepUpload = () => {
                run.startSent = false;
                setFlow({ kind: "passphrase", error: START_UNCLEAR });
            };
            void api
                .getRestoreStatus()
                .then((status) => {
                    if (!mounted.current || activeRun.current !== run) return;
                    const next = flowFromStatus(status);
                    if (!STARTED_KINDS.has(next.kind)) {
                        keepUpload();
                        return;
                    }
                    run.uploadId = null;
                    setFlow(next);
                    pollNow();
                })
                .catch(() => {
                    if (mounted.current && activeRun.current === run)
                        keepUpload();
                });
        },
        [mounted, pollNow],
    );

    const handleRunError = useCallback(
        (run: RestoreRun, error: unknown) => {
            if (!mounted.current || activeRun.current !== run) {
                // A cancelled or superseded attempt still releases the upload
                // it may have opened after it was cancelled.
                if (!run.startSent) discardRunUpload(run);
                return;
            }
            if (abortedByUser(error)) {
                discardRunUpload(run);
                setFlow({ kind: "form", error: null });
                return;
            }
            logger.error("Restore did not start", error);
            const fromStart = error instanceof StartRequestError;
            const cause = fromStart ? error.cause : error;
            const outcome = classifyStartError(cause, fromStart);
            if (outcome.kind === "recheck") {
                recheckAfterUnclearStart(run);
                return;
            }
            run.startSent = false;
            if (outcome.kind === "form") discardRunUpload(run);
            setFlow(outcome);
        },
        [mounted, recheckAfterUnclearStart],
    );

    const runUpload = useCallback(
        async (run: RestoreRun, file: File, passphrase: string) => {
            setFlow({ kind: "uploading", sentBytes: 0, totalBytes: file.size });
            const session = await api.startRestoreUpload(file.size);
            run.uploadId = session.uploadId;
            if (run.abort.signal.aborted) {
                throw new DOMException(
                    "The upload was cancelled.",
                    "AbortError",
                );
            }
            await uploadBackupFile({
                file,
                session,
                uploadChunk: (id, index, chunk, signal) =>
                    api.uploadRestoreChunk(id, index, chunk, signal),
                onProgress: (sentBytes) => {
                    if (!mounted.current || activeRun.current !== run) return;
                    setFlow({
                        kind: "uploading",
                        sentBytes,
                        totalBytes: file.size,
                    });
                },
                signal: run.abort.signal,
            });
            await finishStart(run, passphrase);
        },
        [finishStart, mounted],
    );

    const start = useCallback(
        (file: File, passphrase: string) => {
            stop();
            const run: RestoreRun = {
                abort: new AbortController(),
                uploadId: null,
                startSent: false,
            };
            activeRun.current = run;
            void runUpload(run, file, passphrase).catch((error: unknown) =>
                handleRunError(run, error),
            );
        },
        [handleRunError, runUpload, stop],
    );

    const retryPassphrase = useCallback(
        (passphrase: string) => {
            const run = activeRun.current;
            if (!run?.uploadId) {
                setFlow({ kind: "form", error: null });
                return;
            }
            void finishStart(run, passphrase).catch((error: unknown) =>
                handleRunError(run, error),
            );
        },
        [finishStart, handleRunError],
    );

    const cancel = useCallback(() => {
        const run = activeRun.current;
        activeRun.current = null;
        run?.abort.abort();
        discardRunUpload(run);
        setFlow({ kind: "form", error: null });
    }, []);

    const reset = useCallback(() => {
        setFlow({ kind: "form", error: null });
    }, []);

    return { flow, start, retryPassphrase, cancel, reset };
}
