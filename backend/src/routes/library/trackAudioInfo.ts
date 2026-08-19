import fs from "fs";
import { config } from "../../config";
import {
    AudioStreamingService,
    type Quality as StreamingQuality,
} from "../../services/audioStreaming";
import { prisma, Prisma } from "../../utils/db";
import {
    AUDIO_INFO_CACHE_TTL_MS,
    audioInfoCache,
    buildAudioInfoCacheKey,
    normalizeStreamingQuality,
    pruneAudioInfoCache,
    readAudioInfoPayload,
} from "../../utils/libraryAudioInfo";

/** Fields required to resolve source or federated track audio information. */
export const TRACK_AUDIO_INFO_SELECT = {
    filePath: true,
    fileModified: true,
    fileSize: true,
    duration: true,
    mime: true,
    origin: true,
} satisfies Prisma.TrackSelect;

/** Identifies tracks whose audio information must come from peer metadata. */
export function isFederatedAudioInfoTrack(track: { origin: string }): boolean {
    return track.origin === "FEDERATED";
}

/** Resolves the local file containing the requested playback representation. */
export async function resolvePlaybackAudioInfoPath(
    trackId: string,
    fileModified: Date,
    absolutePath: string,
    userId: string,
    qualityValue: unknown,
) {
    const queryQuality = normalizeStreamingQuality(qualityValue);
    let requestedQuality: StreamingQuality = queryQuality ?? "medium";
    if (!queryQuality) {
        const settings = await prisma.userSettings.findUnique({
            where: { userId },
            select: { playbackQuality: true },
        });
        requestedQuality =
            normalizeStreamingQuality(settings?.playbackQuality) ?? "medium";
    }

    const service = new AudioStreamingService(
        config.music.musicPath,
        config.music.transcodeCachePath,
        config.music.transcodeCacheMaxGb,
    );
    try {
        const playbackFile = await service.getStreamFilePath(
            trackId,
            requestedQuality,
            fileModified,
            absolutePath,
        );
        return { metadataPath: playbackFile.filePath, requestedQuality };
    } finally {
        service.destroy();
    }
}

/** Reads and caches metadata for a local source or playback file. */
export async function loadLocalAudioInfo(
    trackId: string,
    filePath: string,
    fileModified: Date,
    metadataPath: string,
    cacheScope: "source" | "playback",
    cacheQuality: StreamingQuality | null,
) {
    const cacheKey = buildAudioInfoCacheKey(trackId, filePath, fileModified, {
        scope: cacheScope,
        quality: cacheQuality,
    });
    const now = Date.now();
    const cachedEntry = audioInfoCache.get(cacheKey);
    if (cachedEntry && cachedEntry.expiresAt > now) return cachedEntry.payload;
    if (cachedEntry) audioInfoCache.delete(cacheKey);
    if (!fs.existsSync(metadataPath)) return null;

    const payload = await readAudioInfoPayload(metadataPath);
    audioInfoCache.set(cacheKey, {
        payload,
        expiresAt: now + AUDIO_INFO_CACHE_TTL_MS,
    });
    pruneAudioInfoCache(now);
    return payload;
}
