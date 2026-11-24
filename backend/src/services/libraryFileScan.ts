import { scanQueue } from "../workers/queues";

/**
 * Queue a scan of files soundspan just wrote into the music library, such as
 * a downloaded TIDAL song. The scan worker adds only these files, so the song
 * joins the library within seconds instead of after a full library walk.
 * Scans share one queue, so this never overlaps a full scan.
 */
export async function requestLibraryFileScan(
    userId: string | null,
    relativePaths: readonly string[],
    source: string,
): Promise<void> {
    if (relativePaths.length === 0) return;
    await scanQueue.add(
        "scan",
        { userId, source, paths: [...relativePaths] },
        { removeOnComplete: true, removeOnFail: 50 },
    );
}
