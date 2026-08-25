import { randomUUID } from "crypto";
import type { DownloadJob, Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { ARTIST_DOWNLOAD_EXPANSION_OWNER } from "./albumDownloadQueueOwnership";
import { ACTIVE_DOWNLOAD_JOB_STATUSES } from "./downloadJobStatus";

type ArtistExpansionDatabase = Pick<
    Prisma.TransactionClient,
    "$queryRaw" | "downloadJob"
>;

/** Input for one durable artist discography-expansion row. */
export interface CreateArtistDownloadExpansionJobParams {
    userId: string;
    artistMbid: string;
    artistName: string;
    downloadType: "library" | "discovery";
    rootFolderPath: string;
}

/** A newly created artist row or the active row that already owns expansion. */
export interface ArtistDownloadExpansionJobResult {
    job: DownloadJob;
    duplicate: boolean;
}

function isP2002(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
    );
}

async function createWithDatabase(
    database: ArtistExpansionDatabase,
    params: CreateArtistDownloadExpansionJobParams,
): Promise<ArtistDownloadExpansionJobResult> {
    const existingJobs = await database.$queryRaw<DownloadJob[]>`
        SELECT *
        FROM "DownloadJob"
        WHERE "targetMbid" = ${params.artistMbid}
        AND type = 'artist'
        AND status IN ('pending', 'processing')
        FOR UPDATE SKIP LOCKED
    `;
    if (existingJobs.length > 0) {
        return { job: existingJobs[0], duplicate: true };
    }
    const job = await database.downloadJob.create({
        data: {
            userId: params.userId,
            type: "artist",
            targetMbid: params.artistMbid,
            subject: params.artistName,
            status: "pending",
            metadata: {
                queuedVia: ARTIST_DOWNLOAD_EXPANSION_OWNER,
                downloadType: params.downloadType,
                rootFolderPath: params.rootFolderPath,
                artistName: params.artistName,
                batchId: randomUUID(),
                statusText: "Queued",
            },
        },
    });
    return { job, duplicate: false };
}

async function findActiveArtistJob(
    artistMbid: string,
): Promise<DownloadJob | null> {
    return prisma.downloadJob.findFirst({
        where: {
            targetMbid: artistMbid,
            type: "artist",
            status: { in: [...ACTIVE_DOWNLOAD_JOB_STATUSES] },
        },
        orderBy: { createdAt: "asc" },
    });
}

/** Create or reuse the active artist expansion row under the lock fence. */
export async function createArtistDownloadExpansionJob(
    params: CreateArtistDownloadExpansionJobParams,
): Promise<ArtistDownloadExpansionJobResult> {
    try {
        return await prisma.$transaction((transaction) =>
            createWithDatabase(transaction, params),
        );
    } catch (error) {
        if (!isP2002(error)) throw error;
        const job = await findActiveArtistJob(params.artistMbid);
        if (!job) throw error;
        return { job, duplicate: true };
    }
}
