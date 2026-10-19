import fs from "fs/promises";
import path from "path";
import { config } from "../../config";
import { RestoreError } from "./backupErrors";

const SWEEP_AGE_MS = 15 * 60 * 1000;
const MINIMUM_FREE_MARGIN_BYTES = 1024 * 1024 * 1024;

function stagingUnavailable(cause: unknown): RestoreError {
    return new RestoreError(
        "RESTORE_STAGING_UNAVAILABLE",
        "Restore staging storage is unavailable",
        { cause },
    );
}

/** Resolve the restore staging sibling of the configured transcode cache. */
export function restoreStagingDirectory(): string {
    return path.join(
        path.dirname(path.resolve(config.music.transcodeCachePath)),
        "restore-staging",
    );
}

/** Resolve a capability-named staged upload beneath the fixed staging root. */
export function restoreUploadPath(uploadId: string): string {
    return path.join(restoreStagingDirectory(), `${uploadId}.upload`);
}

/** Require free space for the declared archive plus a ten-percent margin. */
export async function ensureRestoreStorage(sizeBytes: number): Promise<void> {
    const directory = restoreStagingDirectory();
    try {
        await fs.mkdir(directory, { recursive: true });
    } catch (cause) {
        throw stagingUnavailable(cause);
    }
    let stats;
    try {
        stats = await fs.statfs(directory);
    } catch (cause) {
        throw new RestoreError(
            "INSUFFICIENT_STORAGE",
            "Available restore storage could not be determined",
            { cause },
        );
    }
    const required =
        sizeBytes +
        Math.max(Math.ceil(sizeBytes / 10), MINIMUM_FREE_MARGIN_BYTES);
    if (stats.bavail * stats.bsize < required) {
        throw new RestoreError(
            "INSUFFICIENT_STORAGE",
            "Insufficient storage for this backup",
        );
    }
}

/** Delete staged upload files older than the upload-session idle lifetime. */
export async function sweepRestoreStaging(now = Date.now()): Promise<void> {
    const directory = restoreStagingDirectory();
    try {
        await fs.mkdir(directory, { recursive: true });
    } catch (cause) {
        throw stagingUnavailable(cause);
    }
    const entries = (
        await fs.readdir(directory, { withFileTypes: true })
    ).slice(0, 10_000);
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".upload")) continue;
        const filePath = path.join(directory, entry.name);
        const stats = await fs.stat(filePath).catch(() => null);
        if (stats && now - stats.mtimeMs > SWEEP_AGE_MS) {
            await fs.unlink(filePath).catch(() => undefined);
        }
    }
}
