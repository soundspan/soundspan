import { prisma } from "../utils/db";
import { Prisma } from "@prisma/client";

/**
 * Lifecycle statuses used by generic import jobs.
 */
export type ImportJobLifecycleStatus =
    | "pending"
    | "resolving"
    | "creating_playlist"
    | "completed"
    | "failed"
    | "cancelled"
    | "cancelling";

/**
 * Summary counts persisted with each generic import job.
 */
export interface ImportJobSummary {
    total: number;
    local: number;
    youtube: number;
    tidal: number;
    unresolved: number;
}

/**
 * Stored representation for a generic import job.
 */
export interface StoredImportJob {
    id: string;
    userId: string;
    sourceType: string;
    sourceId: string;
    sourceUrl: string;
    normalizedSource: string;
    playlistName: string;
    requestedPlaylistName: string | null;
    status: ImportJobLifecycleStatus;
    progress: number;
    summary: ImportJobSummary;
    resolvedTracks: Prisma.JsonValue | null;
    createdPlaylistId: string | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Payload used when creating a new generic import job.
 */
export interface CreateImportJobInput {
    userId: string;
    sourceType: string;
    sourceId: string;
    sourceUrl: string;
    playlistName: string;
    requestedPlaylistName?: string;
    status?: ImportJobLifecycleStatus;
    progress?: number;
    summary: ImportJobSummary;
    resolvedTracks?: Prisma.InputJsonValue;
}

/**
 * Mutable fields for generic import job lifecycle updates.
 */
export interface UpdateImportJobInput {
    status?: ImportJobLifecycleStatus;
    progress?: number;
    summary?: ImportJobSummary;
    resolvedTracks?: Prisma.InputJsonValue | null;
    createdPlaylistId?: string | null;
    error?: string | null;
}

const ACTIVE_IMPORT_JOB_STATUSES: ImportJobLifecycleStatus[] = [
    "pending",
    "resolving",
    "creating_playlist",
    "cancelling",
];

function toImportSummaryJson(summary: ImportJobSummary): Prisma.InputJsonValue {
    return {
        total: summary.total,
        local: summary.local,
        youtube: summary.youtube,
        tidal: summary.tidal,
        unresolved: summary.unresolved,
    };
}

function toNullableJsonUpdateValue(
    value: Prisma.InputJsonValue | null
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
    return value === null ? Prisma.JsonNull : value;
}

function buildNormalizedSource(sourceType: string, sourceId: string): string {
    return `${sourceType.trim().toLowerCase()}:${sourceId.trim()}`;
}

type ImportJobPersistenceRecord = {
    id: string;
    userId: string;
    sourceType: string;
    sourceId: string;
    sourceUrl: string;
    normalizedSource: string;
    playlistName: string;
    requestedPlaylistName: string | null;
    status: string;
    progress: number;
    summary: Prisma.JsonValue;
    resolvedTracks: Prisma.JsonValue | null;
    createdPlaylistId: string | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
};

function toStoredImportJob(record: ImportJobPersistenceRecord): StoredImportJob {
    return {
        ...record,
        status: record.status as ImportJobLifecycleStatus,
        summary: record.summary as unknown as ImportJobSummary,
    };
}

class ImportJobStore {
    /**
     * Persists a new generic import job for the universal import flow.
     */
    async createJob(input: CreateImportJobInput): Promise<StoredImportJob> {
        const created = await prisma.importJob.create({
            data: {
                userId: input.userId,
                sourceType: input.sourceType,
                sourceId: input.sourceId,
                sourceUrl: input.sourceUrl,
                normalizedSource: buildNormalizedSource(
                    input.sourceType,
                    input.sourceId
                ),
                playlistName: input.playlistName,
                requestedPlaylistName: input.requestedPlaylistName ?? null,
                status: input.status ?? "pending",
                progress: input.progress ?? 0,
                summary: toImportSummaryJson(input.summary),
                ...(input.resolvedTracks !== undefined ?
                    { resolvedTracks: input.resolvedTracks }
                :   {}),
                createdPlaylistId: null,
                error: null,
            },
        });
        return toStoredImportJob(created as unknown as ImportJobPersistenceRecord);
    }

    /**
     * Updates lifecycle state and result metadata for an existing generic import job.
     */
    async updateJob(
        jobId: string,
        input: UpdateImportJobInput
    ): Promise<StoredImportJob> {
        const updated = await prisma.importJob.update({
            where: { id: jobId },
            data: {
                ...(input.status !== undefined ? { status: input.status } : {}),
                ...(input.progress !== undefined ?
                    { progress: input.progress }
                :   {}),
                ...(input.summary ?
                    { summary: toImportSummaryJson(input.summary) }
                :   {}),
                ...(input.resolvedTracks !== undefined ?
                    {
                        resolvedTracks: toNullableJsonUpdateValue(
                            input.resolvedTracks
                        ),
                    }
                :   {}),
                ...(input.createdPlaylistId !== undefined ?
                    { createdPlaylistId: input.createdPlaylistId }
                :   {}),
                ...(input.error !== undefined ? { error: input.error } : {}),
            },
        });
        return toStoredImportJob(updated as unknown as ImportJobPersistenceRecord);
    }

    /**
     * Retrieves a generic import job by id.
     */
    async getJob(jobId: string): Promise<StoredImportJob | null> {
        const job = await prisma.importJob.findUnique({
            where: { id: jobId },
        });
        return job ?
                toStoredImportJob(job as unknown as ImportJobPersistenceRecord)
            :   null;
    }

    /**
     * Lists generic import jobs for a user, newest first.
     */
    async listJobsForUser(
        userId: string,
        limit = 25
    ): Promise<StoredImportJob[]> {
        const jobs = await prisma.importJob.findMany({
            where: { userId },
            orderBy: { updatedAt: "desc" },
            take: limit,
        });
        return jobs.map((job) =>
            toStoredImportJob(job as unknown as ImportJobPersistenceRecord)
        );
    }

    /**
     * Finds the newest active generic import job for a normalized source and user.
     */
    async findActiveJobForSource(
        userId: string,
        normalizedSource: string
    ): Promise<StoredImportJob | null> {
        const job = await prisma.importJob.findFirst({
            where: {
                userId,
                normalizedSource,
                status: { in: ACTIVE_IMPORT_JOB_STATUSES },
            },
            orderBy: { updatedAt: "desc" },
        });
        return job ?
                toStoredImportJob(job as unknown as ImportJobPersistenceRecord)
            :   null;
    }
}

/**
 * Shared import job store singleton for universal import job persistence.
 */
export const importJobStore = new ImportJobStore();
