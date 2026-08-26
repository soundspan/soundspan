import { logger } from "../../utils/logger";

const eventLogger = logger.child("DownloadJobEvents");

/** Payloads for the closed download-job event vocabulary. */
export interface DownloadJobEventPayloads {
    "download.completed": {
        jobId: string;
        userId: string;
        subject: string;
        artistId?: unknown;
    };
    "download.exhausted": {
        jobId: string;
        userId: string;
        subject: string;
        reason: string;
    };
    "download.timedOut": {
        jobId: string;
        subject: string;
    };
}

/** Results returned by download-job event subscribers. */
export interface DownloadJobEventResults {
    "download.completed": void;
    "download.exhausted": void;
    "download.timedOut": { timeoutExtended: boolean };
}

export type DownloadJobEventName = keyof DownloadJobEventPayloads;
type DownloadJobEventListener<K extends DownloadJobEventName> = (
    payload: DownloadJobEventPayloads[K],
) => Promise<DownloadJobEventResults[K]>;

/** In-process typed emitter for download notification-policy events. */
export class DownloadJobEvents {
    private readonly listeners: {
        [K in DownloadJobEventName]: Set<DownloadJobEventListener<K>>;
    } = {
        "download.completed": new Set(),
        "download.exhausted": new Set(),
        "download.timedOut": new Set(),
    };

    /** Subscribe to one event and return its unsubscribe function. */
    on<K extends DownloadJobEventName>(
        eventName: K,
        listener: DownloadJobEventListener<K>,
    ): () => void {
        const listeners = this.listeners[eventName] as Set<
            DownloadJobEventListener<K>
        >;
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    /** Publish one event to every registered listener. */
    async emit<K extends DownloadJobEventName>(
        eventName: K,
        payload: DownloadJobEventPayloads[K],
    ): Promise<DownloadJobEventResults[K][]> {
        const listeners = this.listeners[eventName] as Set<
            DownloadJobEventListener<K>
        >;
        const settled = await Promise.allSettled(
            Array.from(listeners, (listener) =>
                Promise.resolve().then(() => listener(payload)),
            ),
        );
        const results: DownloadJobEventResults[K][] = [];
        settled.forEach((result) => {
            if (result.status === "fulfilled") {
                results.push(result.value);
                return;
            }
            eventLogger.error("Download job event subscriber failed", {
                eventName,
                error: result.reason,
            });
        });
        return results;
    }
}
