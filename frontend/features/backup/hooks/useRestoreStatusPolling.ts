"use client";

import { useCallback, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { createFrontendLogger } from "@/lib/logger";
import { RESTORE_STATUS_POLL_MS } from "../backupRestoreModel";
import {
    POLLING_FLOW_KINDS,
    flowFromStatus,
    type RestoreFlow,
} from "../restoreFlowModel";

const logger = createFrontendLogger("Backup.useRestoreStatusPolling");

/** Consecutive failed checks before the page says it can't reach the server. */
const FAILURES_BEFORE_RECONNECTING = 3;
/** Longest wait between two checks while the server can't be reached. */
const MAX_RECONNECT_WAIT_MS = 30_000;

/** Wait before the next check after `failures` consecutive failed checks. */
export function nextStatusCheckDelayMs(failures: number): number {
    if (failures < FAILURES_BEFORE_RECONNECTING) return RESTORE_STATUS_POLL_MS;
    const doublings = failures - FAILURES_BEFORE_RECONNECTING + 1;
    return Math.min(
        RESTORE_STATUS_POLL_MS * 2 ** doublings,
        MAX_RECONNECT_WAIT_MS,
    );
}

/**
 * Follow `GET /api/restore/status` while the flow needs it. Each check is
 * scheduled on a timer through a ref, so a check can queue the next one
 * without the callback referring to itself. A server that can't be reached
 * is retried with backoff behind a non-final "reconnecting" step, because
 * the restore keeps running on the server either way.
 */
export function useRestoreStatusPolling(setFlow: (flow: RestoreFlow) => void) {
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
            if (failures.current >= FAILURES_BEFORE_RECONNECTING) {
                setFlow({ kind: "reconnecting" });
            }
            schedule(nextStatusCheckDelayMs(failures.current));
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
            if (POLLING_FLOW_KINDS.has(next.kind)) {
                schedule(RESTORE_STATUS_POLL_MS);
            }
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
