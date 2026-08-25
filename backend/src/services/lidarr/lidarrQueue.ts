import { logger } from "../../utils/logger";
import { toErrorMessage } from "../../utils/errors";
import { getSystemSettings } from "../../utils/systemSettings";
import {
    allSettledWithConcurrency,
    LidarrHttpClient,
    LidarrHttpError,
} from "./lidarrHttpClient";

interface QueueItem {
    id: number;
    albumId?: number;
    album?: { title?: string };
    title: string;
    status: string;
    downloadId: string;
    trackedDownloadStatus: string;
    trackedDownloadState: string;
    statusMessages: { title: string; messages: string[] }[];
    sizeleft?: number;
    size?: number;
}

function isFailedQueueItem(item: QueueItem): boolean {
    return (
        item.status === "warning" ||
        item.status === "failed" ||
        item.trackedDownloadStatus === "warning" ||
        item.trackedDownloadStatus === "error" ||
        item.trackedDownloadState === "importPending" ||
        item.trackedDownloadState === "importFailed" ||
        Boolean(item.statusMessages?.length)
    );
}

function queueItemTitle(item: QueueItem): string {
    return item.title || item.album?.title || "Unknown";
}

function summarizeQueueDeletions(
    items: QueueItem[],
    results: PromiseSettledResult<unknown>[],
): { removed: number; errors: string[] } {
    const errors: string[] = [];
    let removed = 0;
    for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (
            result.status === "fulfilled" ||
            (result.reason instanceof LidarrHttpError &&
                result.reason.status === 404)
        ) {
            removed += 1;
            logger.debug(`    Removed: ${queueItemTitle(items[index])}`);
        } else {
            errors.push(
                `Failed to remove ${items[index].id}: ${toErrorMessage(result.reason)}`,
            );
        }
    }
    return { removed, errors };
}

async function searchFailedAlbums(
    client: LidarrHttpClient,
    items: QueueItem[],
    signal?: AbortSignal,
): Promise<void> {
    const albumIds = items.flatMap((item) =>
        item.albumId === undefined ? [] : [item.albumId],
    );
    if (albumIds.length === 0) return;
    try {
        await client.post(
            "/api/v1/command",
            { name: "AlbumSearch", albumIds },
            { timeoutMs: 10_000, maxRetries: 0, signal },
        );
    } catch (error: unknown) {
        signal?.throwIfAborted();
        logger.debug(` Failed to trigger search: ${toErrorMessage(error)}`);
    }
}

interface QueueResponse {
    totalRecords: number;
    records: QueueItem[];
}

interface HistoryRecord {
    id: number;
    albumId: number;
    downloadId: string;
    eventType: string;
    date: string;
    data: {
        droppedPath?: string;
        importedPath?: string;
    };
    album: {
        id: number;
        title: string;
        foreignAlbumId: string;
    };
    artist: {
        name: string;
    };
}

interface HistoryResponse {
    records: HistoryRecord[];
}

const FAILED_IMPORT_PATTERNS = [
    "No files found are eligible for import",
    "Not an upgrade for existing",
    "Not a Custom Format upgrade",
    "missing tracks",
    "Album match is not close enough",
    "Artist name mismatch",
    "automatic import is not possible",
    "Unable to extract",
    "Failed to extract",
    "Unpacking failed",
    "unpack error",
    "Error extracting",
    "extraction failed",
    "corrupt archive",
    "invalid archive",
    "CRC failed",
    "bad archive",
    "Download failed",
    "import failed",
    "Sample",
];

function createClient(lidarrUrl: string, apiKey: string): LidarrHttpClient {
    return new LidarrHttpClient(
        { baseUrl: lidarrUrl, apiKey },
        { timeoutMs: 30_000 },
    );
}

async function createSettingsClient(): Promise<LidarrHttpClient | null> {
    const settings = await getSystemSettings();
    if (
        !settings?.lidarrEnabled ||
        !settings.lidarrUrl ||
        !settings.lidarrApiKey
    ) {
        return null;
    }
    return createClient(settings.lidarrUrl, settings.lidarrApiKey);
}

function isStuck(item: QueueItem): boolean {
    const messages =
        item.statusMessages?.flatMap((status) => status.messages) ?? [];
    const hasFailedPattern = messages.some((message) =>
        FAILED_IMPORT_PATTERNS.some((pattern) =>
            message.toLowerCase().includes(pattern.toLowerCase()),
        ),
    );
    const isStuckWarning =
        item.trackedDownloadStatus === "warning" &&
        item.trackedDownloadState === "importPending";
    return (
        hasFailedPattern ||
        isStuckWarning ||
        item.trackedDownloadState === "importFailed"
    );
}

async function removeStuckItem(
    client: LidarrHttpClient,
    item: QueueItem,
    signal?: AbortSignal,
): Promise<boolean> {
    try {
        await client.delete(`/api/v1/queue/${item.id}`, {
            params: {
                removeFromClient: true,
                blocklist: true,
                skipRedownload: false,
            },
            timeoutMs: 10_000,
            maxRetries: 0,
            signal,
        });
        logger.debug(`   Removed and blocklisted: ${item.title}`);
        return true;
    } catch (error: unknown) {
        if (error instanceof LidarrHttpError && error.status === 404)
            return true;
        logger.error(
            `    Failed to remove ${item.title}:`,
            toErrorMessage(error),
        );
        return false;
    }
}

/** Removes stuck queue entries and lets Lidarr search for replacements. */
export async function cleanStuckDownloads(
    lidarrUrl: string,
    apiKey: string,
    signal?: AbortSignal,
): Promise<{ removed: number; items: string[] }> {
    const client = createClient(lidarrUrl, apiKey);
    try {
        const response = await client.get<QueueResponse>("/api/v1/queue", {
            params: {
                page: 1,
                pageSize: 100,
                includeUnknownArtistItems: true,
            },
            timeoutMs: 10_000,
            maxRetries: 0,
            signal,
        });
        logger.debug(
            ` Queue cleaner: checking ${response.data.records.length} items`,
        );
        const removed: string[] = [];
        for (const item of response.data.records.slice(0, 100)) {
            signal?.throwIfAborted();
            const messages =
                item.statusMessages?.flatMap((status) => status.messages) ?? [];
            logger.debug(`   - ${item.title}`);
            logger.debug(
                `      Status: ${item.status}, TrackedStatus: ${item.trackedDownloadStatus}, State: ${item.trackedDownloadState}`,
            );
            if (messages.length > 0) {
                logger.debug(`      Messages: ${messages.join("; ")}`);
            }
            if (
                isStuck(item) &&
                (await removeStuckItem(client, item, signal))
            ) {
                removed.push(item.title);
            }
        }
        if (removed.length > 0) {
            logger.debug(
                ` Queue cleaner: removed ${removed.length} stuck item(s)`,
            );
        }
        return { removed: removed.length, items: removed };
    } catch (error: unknown) {
        logger.error("Queue clean failed:", toErrorMessage(error));
        throw error;
    }
}

/** Removes and blocklists one queued download, accepting DELETE-only 404s. */
export async function blocklistQueueDownload(
    client: LidarrHttpClient,
    downloadId: string,
    skipRedownload: boolean,
): Promise<boolean> {
    let response;
    try {
        response = await client.get<QueueResponse>("/api/v1/queue", {
            params: { page: 1, pageSize: 100 },
            timeoutMs: 10_000,
        });
    } catch (error: unknown) {
        logger.error("[LIDARR] Failed to blocklist:", toErrorMessage(error));
        return false;
    }
    const item = response.data.records.find(
        (record) => record.downloadId === downloadId,
    );
    if (!item) {
        logger.debug(
            `[LIDARR] Download ${downloadId} not found in queue (may already be removed)`,
        );
        return true;
    }
    try {
        logger.debug(`[LIDARR] Blocklisting and removing: ${item.title}`);
        await client.delete(`/api/v1/queue/${item.id}`, {
            params: { removeFromClient: true, blocklist: true, skipRedownload },
            timeoutMs: 10_000,
        });
        logger.debug(`[LIDARR] Successfully blocklisted: ${item.title}`);
        return true;
    } catch (error: unknown) {
        if (error instanceof LidarrHttpError && error.status === 404)
            return true;
        logger.error("[LIDARR] Failed to blocklist:", toErrorMessage(error));
        return false;
    }
}

/** Clears failed queue entries and asks Lidarr to search their albums again. */
export async function clearFailedQueue(
    client: LidarrHttpClient,
    signal?: AbortSignal,
): Promise<{ removed: number; errors: string[] }> {
    try {
        const response = await client.get<QueueResponse>("/api/v1/queue", {
            timeoutMs: 10_000,
            maxRetries: 0,
            signal,
        });
        const failedItems = (response.data.records ?? [])
            .slice(0, 100)
            .filter(isFailedQueueItem);
        const results = await allSettledWithConcurrency(
            failedItems,
            2,
            (item) =>
                client.delete(`/api/v1/queue/${item.id}`, {
                    params: {
                        removeFromClient: true,
                        blocklist: true,
                        skipRedownload: false,
                    },
                    timeoutMs: 10_000,
                    maxRetries: 0,
                    signal,
                }),
        );
        signal?.throwIfAborted();
        const summary = summarizeQueueDeletions(failedItems, results);
        await searchFailedAlbums(client, failedItems, signal);
        return summary;
    } catch (error: unknown) {
        const message = toErrorMessage(error);
        logger.error("   Queue cleanup failed:", message);
        return { removed: 0, errors: [message] };
    }
}

/** Returns recently imported Lidarr downloads. */
export async function getRecentCompletedDownloads(
    lidarrUrl: string,
    apiKey: string,
    sinceMinutes: number = 5,
): Promise<HistoryRecord[]> {
    const client = createClient(lidarrUrl, apiKey);
    try {
        const response = await client.get<HistoryResponse>("/api/v1/history", {
            params: {
                page: 1,
                pageSize: 100,
                sortKey: "date",
                sortDirection: "descending",
                eventType: 3,
            },
        });
        const cutoff = new Date(Date.now() - sinceMinutes * 60 * 1000);
        return response.data.records.filter(
            (record) => new Date(record.date) >= cutoff,
        );
    } catch (error: unknown) {
        logger.error("Failed to fetch Lidarr history:", toErrorMessage(error));
        throw error;
    }
}

/** Returns the current Lidarr queue count. */
export async function getQueueCount(
    lidarrUrl: string,
    apiKey: string,
): Promise<number> {
    const client = createClient(lidarrUrl, apiKey);
    try {
        const response = await client.get<QueueResponse>("/api/v1/queue", {
            params: { page: 1, pageSize: 1 },
        });
        return response.data.totalRecords;
    } catch (error: unknown) {
        logger.error("Failed to get queue count:", toErrorMessage(error));
        return 0;
    }
}

/** Returns all items in the configured Lidarr queue. */
export async function getQueue(): Promise<QueueItem[]> {
    const client = await createSettingsClient();
    if (!client) return [];
    try {
        const response = await client.get<QueueResponse>("/api/v1/queue", {
            params: {
                page: 1,
                pageSize: 100,
                includeUnknownArtistItems: true,
            },
        });
        return response.data.records ?? [];
    } catch (error: unknown) {
        logger.error("Failed to get Lidarr queue:", toErrorMessage(error));
        return [];
    }
}

/** Reports whether a configured Lidarr download remains active. */
export async function isDownloadActive(
    downloadId: string,
): Promise<{ active: boolean; status?: string; progress?: number }> {
    const client = await createSettingsClient();
    if (!client) return { active: false };
    try {
        const response = await client.get<QueueResponse>("/api/v1/queue", {
            params: {
                page: 1,
                pageSize: 100,
                includeUnknownArtistItems: true,
            },
        });
        const item = response.data.records.find(
            (record) => record.downloadId === downloadId,
        );
        if (!item) return { active: false, status: "not_found" };
        const active =
            item.status === "downloading" ||
            (item.trackedDownloadState === "downloading" &&
                item.trackedDownloadStatus !== "warning");
        return {
            active,
            status: item.trackedDownloadState || item.status,
            progress:
                item.sizeleft && item.size
                    ? Math.round((1 - item.sizeleft / item.size) * 100)
                    : undefined,
        };
    } catch (error: unknown) {
        logger.error("Failed to check download status:", toErrorMessage(error));
        return { active: false };
    }
}
