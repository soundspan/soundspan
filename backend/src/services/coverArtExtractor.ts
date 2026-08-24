import * as fs from "fs";
import { logger } from "../utils/logger";
import * as path from "path";
import * as crypto from "crypto";
import { parseFile } from "music-metadata";

// Full metadata parsing can allocate multi-megabyte cover buffers off-heap.
// Serialize extraction across scanner instances to cap that memory spike.
let extractionTail: Promise<void> = Promise.resolve();

function runSerializedExtraction<T>(work: () => Promise<T>): Promise<T> {
    const result = extractionTail.then(work, work);
    extractionTail = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

/**
 * Represents the CoverArtExtractor class.
 */
export class CoverArtExtractor {
    private coverCachePath: string;

    constructor(coverCachePath: string) {
        this.coverCachePath = coverCachePath;

        // Ensure cache directory exists
        if (!fs.existsSync(this.coverCachePath)) {
            fs.mkdirSync(this.coverCachePath, { recursive: true });
        }
    }

    /**
     * Extract cover art from audio file and save to cache
     * Returns relative path to cached cover art, or null if none found
     */
    async extractCoverArt(
        audioFilePath: string,
        albumId: string,
    ): Promise<string | null> {
        try {
            const cacheFileName = `${albumId}.jpg`;
            const cachePath = path.join(this.coverCachePath, cacheFileName);
            if (fs.existsSync(cachePath)) {
                return cacheFileName;
            }
            return await runSerializedExtraction(() =>
                this.extractUncachedCover(
                    audioFilePath,
                    cacheFileName,
                    cachePath,
                ),
            );
        } catch (err) {
            logger.error(
                `[COVER-ART] Failed to extract from ${audioFilePath}:`,
                err,
            );
            return null;
        }
    }

    private async extractUncachedCover(
        audioFilePath: string,
        cacheFileName: string,
        cachePath: string,
    ): Promise<string | null> {
        if (fs.existsSync(cachePath)) return cacheFileName;
        const metadata = await parseFile(audioFilePath);
        const picture = metadata.common.picture?.[0];
        if (!picture) return null;
        await fs.promises.writeFile(cachePath, picture.data);
        logger.debug(
            `[COVER-ART] Extracted cover art from ${path.basename(audioFilePath)}: ${cacheFileName}`,
        );
        return cacheFileName;
    }

    /**
     * Get cover art URL for album
     * Returns relative path if available, or null
     */
    async getCoverArtPath(albumId: string): Promise<string | null> {
        const cacheFileName = `${albumId}.jpg`;
        const cachePath = path.join(this.coverCachePath, cacheFileName);

        if (fs.existsSync(cachePath)) {
            return cacheFileName;
        }

        return null;
    }
}
