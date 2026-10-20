import type { DownloadJob } from "@prisma/client";
import { parseArtistAlbumSubject } from "../../utils/downloadSubject";
import { asPlainObject } from "../../utils/plainObject";

/** Album identifiers and optional artist needed for one processing job. */
export interface ReconciliationAlbumTarget {
    mbids: string[];
    artistName?: string;
}

/** Lidarr data required by one download reconciliation cycle. */
export interface ReconciliationScope {
    needsQueue: boolean;
    albumTargets: ReconciliationAlbumTarget[];
}

/** Empty reconciliation scope for callers with no active jobs. */
export const EMPTY_RECONCILIATION_SCOPE: ReconciliationScope = {
    needsQueue: false,
    albumTargets: [],
};

type ReconciliationScopeJob = Pick<
    DownloadJob,
    "status" | "targetMbid" | "metadata" | "subject" | "lidarrRef"
>;

function collectMbids(job: ReconciliationScopeJob): string[] {
    const metadata = asPlainObject(job.metadata);
    const primary =
        job.targetMbid ||
        String(metadata.albumMbid || metadata.lidarrMbid || "");
    const lidarrMbid =
        typeof metadata.lidarrMbid === "string" ? metadata.lidarrMbid : "";
    return [...new Set([primary, lidarrMbid].filter(Boolean))];
}

function findArtistName(job: ReconciliationScopeJob): string | undefined {
    const metadata = asPlainObject(job.metadata);
    if (typeof metadata.artistName === "string") return metadata.artistName;
    const parsed = parseArtistAlbumSubject(job.subject);
    return parsed.artist !== job.subject ? parsed.artist : undefined;
}

/** Build the bounded Lidarr snapshot scope required by active jobs. */
export function buildReconciliationScope(
    activeJobs: ReconciliationScopeJob[],
): ReconciliationScope {
    const albumTargets = activeJobs
        .filter(({ status }) => status === "processing")
        .map((job) => {
            const artistName = findArtistName(job);
            return {
                mbids: collectMbids(job),
                ...(artistName === undefined ? {} : { artistName }),
            };
        });
    return { needsQueue: activeJobs.length > 0, albumTargets };
}
