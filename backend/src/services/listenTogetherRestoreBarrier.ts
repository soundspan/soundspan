import type { Namespace } from "socket.io";
import { getRestoreBarrier } from "./backup/restartRequired";
import { logger } from "../utils/logger";

const log = logger.child("ListenTogetherSocket");

/** Reject new Listen Together connections while restored state is unsafe. */
export function configureListenTogetherRestoreBarrier(ns: Namespace): void {
    ns.use(async (_socket, next) => {
        try {
            const barrier = await getRestoreBarrier();
            if (!barrier) {
                next();
                return;
            }
            const error = new Error(barrier.message) as Error & {
                data: { code: string };
            };
            error.data = { code: barrier.code };
            next(error);
        } catch (error) {
            log.error("Failed to evaluate the restore barrier", error);
            next(new Error("Service availability check failed"));
        }
    });
}
