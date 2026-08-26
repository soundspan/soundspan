import type { DownloadJob } from "@prisma/client";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import { toErrorMessage } from "../../utils/errors";
import { logger } from "../../utils/logger";
import { asPlainObject } from "../../utils/plainObject";
import { getSystemSettings } from "../../utils/systemSettings";
import { lidarrService } from "../lidarr";
import type { LidarrAlbum } from "../lidarr/lidarrTypes";

export type AlbumRetryResult = {
    retried: boolean;
    failed: boolean;
    jobId?: string;
};

type RetryJob = Pick<
    DownloadJob,
    | "id"
    | "userId"
    | "subject"
    | "targetMbid"
    | "artistMbid"
    | "discoveryBatchId"
    | "metadata"
>;

type AlbumRetryDecision =
    | {
          kind: "exhaust";
          reason: "discovery" | "exact-match" | "missing-artist";
      }
    | { kind: "search"; artistMbid: string; artistName?: string };

interface AlbumRetryDependencies {
    markJobExhausted: (
        job: RetryJob,
        reason: string,
    ) => Promise<AlbumRetryResult>;
    startDownload: (
        jobId: string,
        artistName: string,
        albumTitle: string,
        albumMbid: string,
        userId: string,
    ) => Promise<{ success: boolean; error?: string }>;
}

/** Choose whether a job may search another album from the same artist. */
export function decideAlbumRetry(job: RetryJob): AlbumRetryDecision {
    const metadata = asPlainObject(job.metadata);
    if (job.discoveryBatchId) return { kind: "exhaust", reason: "discovery" };
    if (
        metadata.spotifyImportJobId ||
        metadata.downloadType === "spotify_import" ||
        metadata.noFallback
    ) {
        return { kind: "exhaust", reason: "exact-match" };
    }
    const artistMbid = job.artistMbid || metadata.artistMbid;
    if (typeof artistMbid !== "string" || !artistMbid) {
        return { kind: "exhaust", reason: "missing-artist" };
    }
    return {
        kind: "search",
        artistMbid,
        artistName:
            typeof metadata.artistName === "string"
                ? metadata.artistName
                : undefined,
    };
}

/** Select the first untried studio album, or the first untried release. */
export function selectNextAlbum(
    albums: LidarrAlbum[],
    triedAlbumMbids: ReadonlySet<string>,
): LidarrAlbum | undefined {
    const untried = albums.filter(
        (album) => !triedAlbumMbids.has(album.foreignAlbumId),
    );
    return (
        untried.find((album) => {
            const albumType = album.albumType;
            return (
                typeof albumType !== "string" ||
                albumType.toLowerCase() === "album"
            );
        }) ?? untried[0]
    );
}

async function exhaustWithoutSearch(
    job: RetryJob,
    reason: string,
    decision: Extract<AlbumRetryDecision, { kind: "exhaust" }>,
    dependencies: AlbumRetryDependencies,
): Promise<AlbumRetryResult> {
    const metadata = asPlainObject(job.metadata);
    const result = await dependencies.markJobExhausted(job, reason);
    if (decision.reason === "exact-match" && metadata.spotifyImportJobId) {
        const { spotifyImportService } = await import("../spotifyImport");
        await spotifyImportService.checkImportCompletion(
            String(metadata.spotifyImportJobId),
        );
    }
    return result;
}

async function findNextAlbum(
    job: RetryJob,
    artistMbid: string,
): Promise<LidarrAlbum | undefined> {
    const albums = await lidarrService.getArtistAlbums(artistMbid);
    if (!albums?.length) return undefined;
    const artistJobs = await prisma.downloadJob.findMany({
        where: {
            artistMbid,
            status: { in: ["processing", "completed", "failed", "exhausted"] },
        },
        select: { targetMbid: true },
    });
    const triedAlbumMbids = new Set(
        artistJobs.map(({ targetMbid }) => targetMbid),
    );
    triedAlbumMbids.add(job.targetMbid);
    return selectNextAlbum(albums, triedAlbumMbids);
}

async function createFallbackJob(
    job: RetryJob,
    nextAlbum: LidarrAlbum,
    artistMbid: string,
    artistName?: string,
): Promise<string> {
    const metadata = asPlainObject(job.metadata);
    await prisma.downloadJob.update({
        where: { id: job.id },
        data: {
            status: "exhausted",
            error: `All releases exhausted - trying: ${nextAlbum.title}`,
            completedAt: new Date(),
        },
    });
    const settings = await getSystemSettings();
    const defaultMusicPath = settings?.musicPath || config.music.musicPath;
    const newJob = await prisma.downloadJob.create({
        data: {
            userId: job.userId,
            subject: `${artistName || "Unknown"} - ${nextAlbum.title}`,
            type: "album",
            targetMbid: nextAlbum.foreignAlbumId,
            status: "pending",
            discoveryBatchId: job.discoveryBatchId,
            artistMbid,
            metadata: {
                artistName,
                artistMbid,
                albumTitle: nextAlbum.title,
                albumMbid: nextAlbum.foreignAlbumId,
                lidarrAlbumId: nextAlbum.id,
                sameArtistFallback: true,
                originalJobId: job.id,
                downloadType: metadata.downloadType || "library",
                rootFolderPath: metadata.rootFolderPath || defaultMusicPath,
            },
        },
    });
    return newJob.id;
}

/** Execute the same-artist album fallback policy for an exhausted job. */
export async function tryNextAlbumFromArtist(
    job: RetryJob,
    reason: string,
    dependencies: AlbumRetryDependencies,
): Promise<AlbumRetryResult> {
    const decision = decideAlbumRetry(job);
    if (decision.kind === "exhaust") {
        return exhaustWithoutSearch(job, reason, decision, dependencies);
    }
    try {
        const nextAlbum = await findNextAlbum(job, decision.artistMbid);
        if (!nextAlbum) {
            return dependencies.markJobExhausted(job, reason);
        }
        logger.debug(
            `[RETRY] Trying next album from same artist: ${nextAlbum.title}`,
        );
        const newJobId = await createFallbackJob(
            job,
            nextAlbum,
            decision.artistMbid,
            decision.artistName,
        );
        const result = await dependencies.startDownload(
            newJobId,
            decision.artistName || "Unknown Artist",
            nextAlbum.title,
            nextAlbum.foreignAlbumId,
            job.userId,
        );
        return result.success
            ? { retried: true, failed: false, jobId: newJobId }
            : { retried: false, failed: true, jobId: newJobId };
    } catch (error) {
        logger.error(
            `   Error trying same-artist fallback: ${toErrorMessage(error)}`,
        );
        return dependencies.markJobExhausted(job, reason);
    }
}
