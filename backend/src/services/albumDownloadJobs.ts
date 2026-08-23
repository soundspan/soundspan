import type { DownloadJob, Prisma } from "@prisma/client";
import { lastFmService } from "./lastfm";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

const log = logger.child?.("AlbumDownloadJobs") ?? logger;
const ACTIVE_DOWNLOAD_STATUSES = ["pending", "processing"] as const;

type AlbumDownloadDatabase = Pick<
    Prisma.TransactionClient,
    "$queryRaw" | "downloadJob"
>;

/** Input shared by every album download-job creator. */
export interface CreateAlbumDownloadJobParams {
    userId: string;
    mbid: string;
    subject: string;
    artistName?: string;
    albumTitle?: string;
    downloadType: "library" | "discovery";
    rootFolderPath: string;
}

/** A newly created job or the active job that already owns the album. */
export interface AlbumDownloadJobResult {
    job: DownloadJob;
    duplicate: boolean;
    duplicateSource?: "locked" | "unique";
    verifiedArtistName?: string;
}

function isP2002(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
    );
}

/** Resolve the canonical artist name used in album download metadata. */
export async function resolveAlbumDownloadArtistName(
    artistName?: string,
): Promise<string | undefined> {
    if (!artistName) return artistName;
    try {
        const correction = await lastFmService.getArtistCorrection(artistName);
        if (correction?.corrected) return correction.canonicalName;
    } catch (error) {
        log.warn(`LastFM correction lookup failed for "${artistName}":`, error);
    }
    return artistName;
}

async function findActiveJob(
    database: AlbumDownloadDatabase,
    mbid: string,
): Promise<DownloadJob | null> {
    return database.downloadJob.findFirst({
        where: {
            targetMbid: mbid,
            status: { in: [...ACTIVE_DOWNLOAD_STATUSES] },
        },
        orderBy: { createdAt: "asc" },
    });
}

async function createWithDatabase(
    database: AlbumDownloadDatabase,
    params: CreateAlbumDownloadJobParams,
    verifiedArtistName?: string,
): Promise<AlbumDownloadJobResult> {
    const existingJobs = await database.$queryRaw<DownloadJob[]>`
        SELECT *
        FROM "DownloadJob"
        WHERE "targetMbid" = ${params.mbid}
        AND status IN ('pending', 'processing')
        FOR UPDATE SKIP LOCKED
    `;
    if (existingJobs.length > 0) {
        return {
            job: existingJobs[0],
            duplicate: true,
            duplicateSource: "locked",
            verifiedArtistName,
        };
    }
    const job = await database.downloadJob.create({
        data: {
            userId: params.userId,
            subject: params.subject,
            type: "album",
            targetMbid: params.mbid,
            status: "pending",
            metadata: {
                downloadType: params.downloadType,
                rootFolderPath: params.rootFolderPath,
                artistName: verifiedArtistName,
                albumTitle: params.albumTitle,
            },
        },
    });
    return { job, duplicate: false, verifiedArtistName };
}

/** Create or reuse the active album download job under the existing lock fence. */
export async function createAlbumDownloadJob(
    params: CreateAlbumDownloadJobParams,
    database?: AlbumDownloadDatabase,
    verifiedArtistNameOverride?: string,
): Promise<AlbumDownloadJobResult> {
    const verifiedArtistName =
        verifiedArtistNameOverride ??
        (await resolveAlbumDownloadArtistName(params.artistName));
    if (database) {
        return createWithDatabase(database, params, verifiedArtistName);
    }
    try {
        return await prisma.$transaction((transaction) =>
            createWithDatabase(transaction, params, verifiedArtistName),
        );
    } catch (error) {
        if (!isP2002(error)) throw error;
        const job = await findActiveJob(prisma, params.mbid);
        if (!job) throw error;
        return {
            job,
            duplicate: true,
            duplicateSource: "unique",
            verifiedArtistName,
        };
    }
}
