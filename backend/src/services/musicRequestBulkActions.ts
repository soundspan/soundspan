import type { MusicRequest } from "@prisma/client";
import { recordMusicRequestAction } from "../metrics";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { resolveAlbumDownloadArtistName } from "./albumDownloadJobs";
import {
    approveRequest,
    type DownloadDispatch,
    normalizeOptionalText,
    ONE_DAY_MS,
} from "./musicRequestService";
import {
    buildRequestNotificationMetadata,
    notificationService,
} from "./notificationService";

const log = logger.child("MusicRequestBulkActions");

/** Maximum per-user approvals processed by one bulk request. */
export const MAX_BULK_APPROVALS = 25;
/** Maximum stale denials processed by one bulk request. */
export const MAX_BULK_STALE_DENIALS = 200;
const ARTIST_LOOKUP_CONCURRENCY = 5;

interface BulkApprovalResult {
    approved: number;
    fulfilled: number;
    skipped: number;
    failed: number;
    remaining: number;
    dispatches: DownloadDispatch[];
}

type DenialRow = Pick<
    MusicRequest,
    "id" | "userId" | "rgMbid" | "artistName" | "albumTitle"
>;
type ApprovalRow = Pick<MusicRequest, "id" | "artistName">;

async function applyApproval(
    adminId: string,
    requestId: string,
    verifiedArtistName: string,
    result: BulkApprovalResult,
): Promise<void> {
    try {
        const approval = await approveRequest(adminId, requestId, {
            verifiedArtistName,
        });
        if (approval.kind !== "updated") {
            result.skipped += 1;
            return;
        }
        if (approval.request.status === "fulfilled") result.fulfilled += 1;
        else result.approved += 1;
        if (approval.dispatch) result.dispatches.push(approval.dispatch);
    } catch (error) {
        result.failed += 1;
        log.error("Bulk request approval failed", { requestId, error });
    }
}

async function resolveArtistNames(
    rows: ApprovalRow[],
): Promise<Map<string, string>> {
    const artistNames = [...new Set(rows.map((row) => row.artistName))];
    const resolved = new Map<string, string>();
    for (
        let offset = 0;
        offset < MAX_BULK_APPROVALS;
        offset += ARTIST_LOOKUP_CONCURRENCY
    ) {
        const chunk = artistNames.slice(
            offset,
            offset + ARTIST_LOOKUP_CONCURRENCY,
        );
        if (chunk.length === 0) break;
        const names = await Promise.all(
            chunk.map((artistName) =>
                resolveAlbumDownloadArtistName(artistName),
            ),
        );
        for (
            let index = 0;
            index < ARTIST_LOOKUP_CONCURRENCY && index < chunk.length;
            index += 1
        ) {
            resolved.set(chunk[index], names[index] ?? chunk[index]);
        }
    }
    return resolved;
}

/** Approve one user's oldest pending requests with bounded sequential work. */
export async function approvePendingRequestsForUser(
    adminId: string,
    userId: string,
): Promise<BulkApprovalResult> {
    const rows = await prisma.musicRequest.findMany({
        where: { userId, status: "pending" },
        select: { id: true, artistName: true },
        orderBy: { createdAt: "asc" },
        take: MAX_BULK_APPROVALS,
    });
    const artistNames = await resolveArtistNames(rows);
    const result: BulkApprovalResult = {
        approved: 0,
        fulfilled: 0,
        skipped: 0,
        failed: 0,
        remaining: 0,
        dispatches: [],
    };
    for (
        let index = 0;
        index < rows.length && index < MAX_BULK_APPROVALS;
        index += 1
    ) {
        const row = rows[index];
        await applyApproval(
            adminId,
            row.id,
            artistNames.get(row.artistName) ?? row.artistName,
            result,
        );
    }
    result.remaining = await prisma.musicRequest.count({
        where: { userId, status: "pending" },
    });
    return result;
}

async function notifyBulkDenial(
    request: DenialRow,
    reason?: string,
): Promise<void> {
    try {
        await notificationService.notifyRequestDenied(
            request.userId,
            buildRequestNotificationMetadata(request),
            reason,
        );
    } catch (error) {
        log.warn("Bulk denial notification failed", {
            requestId: request.id,
            error,
        });
    }
}

async function denyStaleRequest(
    adminId: string,
    request: DenialRow,
    reason: string | undefined,
    reviewedAt: Date,
): Promise<boolean> {
    const changed = await prisma.musicRequest.updateMany({
        where: { id: request.id, status: "pending" },
        data: {
            status: "denied",
            deniedReason: reason,
            reviewedById: adminId,
            reviewedAt,
            cooldownUntil: null,
        },
    });
    if (changed.count === 0) return false;
    recordMusicRequestAction("denied");
    await notifyBulkDenial(request, reason);
    return true;
}

async function applyStaleDenial(
    adminId: string,
    request: DenialRow,
    reason: string | undefined,
    reviewedAt: Date,
): Promise<boolean> {
    try {
        return await denyStaleRequest(adminId, request, reason, reviewedAt);
    } catch (error) {
        log.error("Bulk stale request denial failed", {
            requestId: request.id,
            error,
        });
        return false;
    }
}

/** Deny the oldest bounded batch of stale pending requests without cooldown. */
export async function denyStaleRequests(
    adminId: string,
    olderThanDays: number,
    reason?: string,
): Promise<{ denied: number; remaining: number }> {
    const reviewedAt = new Date();
    const cutoff = new Date(reviewedAt.getTime() - olderThanDays * ONE_DAY_MS);
    const where = { status: "pending", createdAt: { lt: cutoff } } as const;
    const rows = await prisma.musicRequest.findMany({
        where,
        select: {
            id: true,
            userId: true,
            rgMbid: true,
            artistName: true,
            albumTitle: true,
        },
        orderBy: { createdAt: "asc" },
        take: MAX_BULK_STALE_DENIALS,
    });
    let denied = 0;
    const deniedReason = normalizeOptionalText(reason);
    for (
        let index = 0;
        index < rows.length && index < MAX_BULK_STALE_DENIALS;
        index += 1
    ) {
        if (
            await applyStaleDenial(
                adminId,
                rows[index],
                deniedReason,
                reviewedAt,
            )
        )
            denied += 1;
    }
    const remaining = await prisma.musicRequest.count({ where });
    return { denied, remaining };
}
