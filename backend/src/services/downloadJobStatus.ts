import type { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { asPlainObject } from "../utils/plainObject";

/** Persisted states used by download jobs. */
export type DownloadJobStatus =
    | "pending"
    | "processing"
    | "completed"
    | "failed"
    | "exhausted"
    | "cancelled";

/** Download-job states that can still perform work. */
export const ACTIVE_DOWNLOAD_JOB_STATUSES: DownloadJobStatus[] = [
    "pending",
    "processing",
];

/** Terminal membership used by download history and notification policy. */
export const TERMINAL_DOWNLOAD_JOB_STATUSES: DownloadJobStatus[] = [
    "completed",
    "failed",
    "exhausted",
];

interface CompleteDownloadJobOptions {
    completedAt?: Date;
    data?: Omit<
        Prisma.DownloadJobUpdateInput,
        "status" | "completedAt" | "metadata"
    >;
}

interface FailDownloadJobOptions {
    completedAt?: Date;
    data?: Omit<
        Prisma.DownloadJobUpdateInput,
        "status" | "error" | "completedAt" | "metadata"
    >;
}

type DownloadJobMetadataExtraData = Omit<
    Prisma.DownloadJobUpdateInput,
    "metadata"
>;
type DownloadJobMetadataPatch =
    | Record<string, unknown>
    | ((current: Record<string, unknown>) => Record<string, unknown>);

/**
 * Merge metadata over a caller-provided row snapshot and perform one update.
 *
 * Use this after fetching the download-job row. It avoids another select but
 * trades a fresh read for the caller's snapshot, preserving pre-#746 behavior.
 */
export async function patchDownloadJobMetadataFrom(
    currentMetadata: unknown,
    jobId: string,
    patch: DownloadJobMetadataPatch,
    extraData?: DownloadJobMetadataExtraData,
): Promise<void> {
    const current = asPlainObject(currentMetadata);
    const metadata =
        typeof patch === "function" ? patch(current) : { ...current, ...patch };

    await prisma.downloadJob.update({
        where: { id: jobId },
        data: {
            ...extraData,
            metadata: metadata as Prisma.InputJsonObject,
        },
    });
}

/**
 * Merge metadata into one download job with optional fields in the same write.
 *
 * This helper still performs a non-atomic read-modify-write. It centralizes the
 * operation so a future PostgreSQL JSONB-atomic implementation has one seam.
 */
export async function patchDownloadJobMetadata(
    jobId: string,
    patch: DownloadJobMetadataPatch,
    extraData?: DownloadJobMetadataExtraData,
): Promise<void> {
    const job = await prisma.downloadJob.findUnique({
        where: { id: jobId },
        select: { metadata: true },
    });
    await patchDownloadJobMetadataFrom(job?.metadata, jobId, patch, extraData);
}

/** Mark one download job completed without changing caller-owned metadata. */
export async function completeDownloadJob(
    jobId: string,
    options: CompleteDownloadJobOptions = {},
): Promise<void> {
    await prisma.downloadJob.update({
        where: { id: jobId },
        data: {
            ...options.data,
            status: "completed",
            completedAt: options.completedAt ?? new Date(),
        },
    });
}

/** Mark one download job failed without changing caller-owned metadata. */
export async function failDownloadJob(
    jobId: string,
    error: string,
    options: FailDownloadJobOptions = {},
): Promise<void> {
    await prisma.downloadJob.update({
        where: { id: jobId },
        data: {
            ...options.data,
            status: "failed",
            error,
            completedAt: options.completedAt ?? new Date(),
        },
    });
}
