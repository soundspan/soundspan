import type { Job } from "bull";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { ALBUM_DOWNLOAD_QUEUE_OWNER } from "../../services/albumDownloadQueueOwnership";
import { enqueueAlbumDownloadInBackground } from "../../services/albumDownloadQueueService";
import { patchDownloadJobMetadata } from "../../services/downloadJobStatus";
import { lastFmService } from "../../services/lastfm";
import { musicBrainzService } from "../../services/musicbrainz";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { asPlainObject } from "../../utils/plainObject";
import {
    classifyReleaseGroup,
    type ReleaseGroupEligibility,
} from "./artistExpansionEligibility";

const log = logger.child("ArtistDownloadExpansionProcessor");
const payloadSchema = z
    .object({
        jobId: z.string(),
        artistMbid: z.string(),
        artistName: z.string(),
        downloadType: z.enum(["library", "discovery"]),
        rootFolderPath: z.string(),
        userId: z.string(),
    })
    .strict();
const MAX_RELEASE_GROUPS = 100;
const RECENT_FAILURE_AGE_MS = 30_000;

type ArtistExpansionPayload = z.infer<typeof payloadSchema>;
type ArtistAlbumCreateResult =
    | { kind: "created"; jobId: string; subject: string }
    | { kind: "already_queued" | "recently_failed" };
type ReleaseGroupResult = ArtistAlbumCreateResult | { kind: "in_library" };

interface ExpansionCounts {
    albumCount: number;
    skippedInLibrary: number;
    skippedQueued: number;
    skippedRecentlyFailed: number;
    skippedIneligible: number;
}

interface ExpansionResult {
    counts: ExpansionCounts;
    filteredReasons: Record<string, number>;
}

type IneligibilityReason = Extract<
    ReleaseGroupEligibility,
    { eligible: false }
>["reason"];

interface ArtistAlbumJobInput {
    payload: ArtistExpansionPayload;
    artistName: string;
    albumMbid: string;
    albumTitle: string;
    batchId: string;
}

/**
 * Persisted failure text is code-owned: the stored job error is returned to
 * clients via GET /api/downloads, so raw error detail stays in server logs.
 */
const EXPANSION_FAILED_TEXT = "Artist expansion failed — see server logs";

async function resolveCanonicalArtistName(
    artistMbid: string,
    artistName: string,
): Promise<string> {
    try {
        const artist = await musicBrainzService.getArtist(artistMbid);
        return artist?.name || artistName;
    } catch (error) {
        log.warn("MusicBrainz artist lookup failed", { artistMbid, error });
    }
    try {
        const correction = await lastFmService.getArtistCorrection(artistName);
        return correction?.canonicalName || artistName;
    } catch (error) {
        log.warn("Last.fm artist correction failed", { artistMbid, error });
        return artistName;
    }
}

async function readBatchId(jobId: string): Promise<string> {
    const job = await prisma.downloadJob.findUnique({
        where: { id: jobId },
        select: { metadata: true },
    });
    const batchId = asPlainObject(job?.metadata).batchId;
    if (typeof batchId !== "string" || !batchId) {
        throw new Error("Artist expansion batch metadata is missing");
    }
    return batchId;
}

async function findAlbumSkipReason(
    transaction: Prisma.TransactionClient,
    albumMbid: string,
): Promise<"already_queued" | "recently_failed" | null> {
    const active = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM "DownloadJob"
        WHERE "targetMbid" = ${albumMbid}
        AND status IN ('pending', 'processing')
        FOR UPDATE SKIP LOCKED
    `;
    if (active.length > 0) return "already_queued";
    const recentFailed = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM "DownloadJob"
        WHERE "targetMbid" = ${albumMbid}
        AND status = 'failed'
        AND "completedAt" >= ${new Date(Date.now() - RECENT_FAILURE_AGE_MS)}
        FOR UPDATE SKIP LOCKED
    `;
    return recentFailed.length > 0 ? "recently_failed" : null;
}

async function createArtistAlbumRow(
    transaction: Prisma.TransactionClient,
    input: ArtistAlbumJobInput,
): Promise<ArtistAlbumCreateResult> {
    const { payload, artistName, albumMbid, albumTitle, batchId } = input;
    const subject = `${artistName} - ${albumTitle}`;
    const createdAt = new Date();
    const job = await transaction.downloadJob.create({
        data: {
            userId: payload.userId,
            subject,
            type: "album",
            targetMbid: albumMbid,
            status: "pending",
            metadata: {
                queuedVia: ALBUM_DOWNLOAD_QUEUE_OWNER,
                downloadType: payload.downloadType,
                rootFolderPath: payload.rootFolderPath,
                artistName,
                artistMbid: payload.artistMbid,
                albumTitle,
                batchId,
                statusText: "Queued",
                batchArtist: artistName,
                createdAt: createdAt.toISOString(),
            },
        },
    });
    return { kind: "created", jobId: job.id, subject };
}

async function createAlbumJobInTransaction(
    transaction: Prisma.TransactionClient,
    input: ArtistAlbumJobInput,
): Promise<ArtistAlbumCreateResult> {
    const skipReason = await findAlbumSkipReason(transaction, input.albumMbid);
    if (skipReason) return { kind: skipReason };
    return createArtistAlbumRow(transaction, input);
}

async function createArtistAlbumJob(
    payload: ArtistExpansionPayload,
    artistName: string,
    albumMbid: string,
    albumTitle: string,
    batchId: string,
): Promise<ArtistAlbumCreateResult> {
    return prisma.$transaction((transaction) =>
        createAlbumJobInTransaction(transaction, {
            payload,
            artistName,
            albumMbid,
            albumTitle,
            batchId,
        }),
    );
}

function recordAlbumResult(
    result: ReleaseGroupResult,
    counts: ExpansionCounts,
): void {
    if (result.kind === "created") counts.albumCount += 1;
    if (result.kind === "in_library") counts.skippedInLibrary += 1;
    if (result.kind === "already_queued") counts.skippedQueued += 1;
    if (result.kind === "recently_failed") counts.skippedRecentlyFailed += 1;
}

async function processReleaseGroup(
    payload: ArtistExpansionPayload,
    artistName: string,
    batchId: string,
    releaseGroup: { id: string; title: string },
): Promise<ReleaseGroupResult> {
    const localAlbum = await prisma.album.findFirst({
        where: { rgMbid: releaseGroup.id, location: "LIBRARY" },
        select: { id: true },
    });
    if (localAlbum) return { kind: "in_library" };
    const result = await createArtistAlbumJob(
        payload,
        artistName,
        releaseGroup.id,
        releaseGroup.title,
        batchId,
    );
    enqueueCreatedAlbum(
        result,
        payload,
        artistName,
        releaseGroup.id,
        releaseGroup.title,
    );
    return result;
}

function enqueueCreatedAlbum(
    result: ArtistAlbumCreateResult,
    payload: ArtistExpansionPayload,
    artistName: string,
    albumMbid: string,
    albumTitle: string,
): void {
    if (result.kind !== "created") return;
    enqueueAlbumDownloadInBackground({
        jobId: result.jobId,
        type: "album",
        mbid: albumMbid,
        subject: result.subject,
        artistName,
        artistMbid: payload.artistMbid,
        albumTitle,
    });
}

function createExpansionResult(): ExpansionResult {
    return {
        counts: {
            albumCount: 0,
            skippedInLibrary: 0,
            skippedQueued: 0,
            skippedRecentlyFailed: 0,
            skippedIneligible: 0,
        },
        filteredReasons: {},
    };
}

function recordIneligibleReleaseGroup(
    expansion: ExpansionResult,
    reason: IneligibilityReason,
): void {
    expansion.counts.skippedIneligible += 1;
    expansion.filteredReasons[reason] =
        (expansion.filteredReasons[reason] ?? 0) + 1;
}

function logExpansionSummary(
    artistMbid: string,
    total: number,
    expansion: ExpansionResult,
): void {
    log.info("Artist expansion eligibility summarized", {
        artistMbid,
        total,
        ...expansion.counts,
        filteredReasons: expansion.filteredReasons,
    });
}

async function expandReleaseGroups(
    payload: ArtistExpansionPayload,
    artistName: string,
    batchId: string,
): Promise<ExpansionResult> {
    const releaseGroups = await musicBrainzService.getReleaseGroupsWithCredits(
        payload.artistMbid,
        ["album", "ep"],
        MAX_RELEASE_GROUPS,
    );
    const expansion = createExpansionResult();
    const total = Math.min(releaseGroups.length, MAX_RELEASE_GROUPS);
    for (let index = 0; index < total; index += 1) {
        const releaseGroup = releaseGroups[index];
        const eligibility = classifyReleaseGroup(
            releaseGroup,
            payload.artistMbid,
        );
        if (!eligibility.eligible) {
            recordIneligibleReleaseGroup(expansion, eligibility.reason);
            continue;
        }
        const result = await processReleaseGroup(
            payload,
            artistName,
            batchId,
            releaseGroup,
        );
        recordAlbumResult(result, expansion.counts);
    }
    logExpansionSummary(payload.artistMbid, total, expansion);
    return expansion;
}

async function completeExpansion(
    jobId: string,
    counts: ExpansionCounts,
    filteredReasons: Record<string, number>,
): Promise<void> {
    const statusText =
        counts.albumCount === 0
            ? "No missing albums to download"
            : `Queued ${counts.albumCount} albums`;
    await patchDownloadJobMetadata(
        jobId,
        { ...counts, filteredReasons, statusText },
        { status: "completed", completedAt: new Date() },
    );
}

async function failExpansion(jobId: string, error: unknown): Promise<void> {
    log.error("Artist expansion failed", { jobId, error });
    try {
        await patchDownloadJobMetadata(
            jobId,
            { statusText: EXPANSION_FAILED_TEXT },
            {
                status: "failed",
                error: EXPANSION_FAILED_TEXT,
                completedAt: new Date(),
            },
        );
    } catch (persistenceError) {
        log.error("Failed to persist artist expansion failure", {
            jobId,
            error: persistenceError,
        });
    }
}

/** Validate and expand one queued artist into durable album jobs. */
export async function processArtistDownloadExpansion(
    job: Job<unknown>,
): Promise<void> {
    const payload = payloadSchema.parse(job.data);
    await job.progress(0);
    try {
        const batchId = await readBatchId(payload.jobId);
        await patchDownloadJobMetadata(
            payload.jobId,
            {
                statusText: "Enumerating discography",
            },
            {
                status: "processing",
                startedAt: new Date(),
                error: null,
            },
        );
        const artistName = await resolveCanonicalArtistName(
            payload.artistMbid,
            payload.artistName,
        );
        const expansion = await expandReleaseGroups(
            payload,
            artistName,
            batchId,
        );
        await job.progress(100);
        await completeExpansion(
            payload.jobId,
            expansion.counts,
            expansion.filteredReasons,
        );
    } catch (error) {
        await failExpansion(payload.jobId, error);
        throw error;
    }
}
