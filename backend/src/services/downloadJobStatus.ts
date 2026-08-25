import type { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";

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
