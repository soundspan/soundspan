import type { Album, DownloadJob, MusicRequest, Prisma } from "@prisma/client";
import { config } from "../config";
import { recordMusicRequestAction } from "../metrics";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";
import {
    createAlbumDownloadJob,
    resolveAlbumDownloadArtistName,
    type AlbumDownloadJobResult,
    type CreateAlbumDownloadJobParams,
} from "./albumDownloadJobs";
import { ALBUM_DOWNLOAD_QUEUE_OWNER } from "./albumDownloadQueueOwnership";
import { ACTIVE_DOWNLOAD_JOB_STATUSES } from "./downloadJobStatus";
import {
    buildRequestNotificationMetadata,
    listAdminRecipientIds,
    notificationService,
} from "./notificationService";

const log = logger.child("MusicRequestService");
const DEFAULT_REQUEST_LIST_LIMIT = 50;
const OPEN_REQUEST_STATUSES = ["pending", "approved"] as const;

type RequestLibraryLinks = {
    albumId: string | null;
    artistId: string | null;
};
type RequestDownloadLink = { downloadStatus: string | null };
type LinkableRequest = Pick<
    MusicRequest,
    "rgMbid" | "artistMbid" | "downloadJobId"
>;
type AlbumLink = Pick<Album, "id" | "rgMbid" | "location" | "artistId">;
type ReviewableRequestStatus = "pending" | "failed";

/** Stable persisted status vocabulary for the request queue. */
export const MUSIC_REQUEST_STATUSES = [
    "pending",
    "approved",
    "denied",
    "fulfilled",
    "failed",
    "cancelled",
] as const;

/** Persisted request status accepted by administrator list filtering. */
export type MusicRequestStatus = (typeof MUSIC_REQUEST_STATUSES)[number];
/** Stable reason returned when a request transition conflicts. */
export type RequestConflictReason = "not_reviewable" | "open_request_exists";
/** Create-time conflict and quota decisions exposed to the route boundary. */
export type MusicRequestErrorCode =
    | "already_in_library"
    | "already_requested"
    | "already_downloading"
    | "recently_denied"
    | "daily_cap";

/** Stable service failure used by the route's HTTP conflict mapping. */
export class MusicRequestServiceError extends Error {
    constructor(
        public readonly code: MusicRequestErrorCode,
        message: string,
        public readonly retryAfter?: Date,
    ) {
        super(message);
        this.name = "MusicRequestServiceError";
    }
}

/** Bounded filters accepted by music request list services. */
export interface MusicRequestListOptions {
    status?: MusicRequestStatus;
    limit: number;
    offset: number;
}

/** Paged music request result returned by list services. */
export interface MusicRequestPage<T> {
    requests: T[];
    total: number;
    offset: number;
    limit: number;
}

/** Validated album request input from the HTTP boundary. */
export interface CreateMusicRequestInput {
    artistName: string;
    albumTitle: string;
    artistMbid?: string;
    rgMbid: string;
    note?: string;
}

/** Result of an ownership-safe or administrator request transition. */
export type RequestTransitionResult =
    | { kind: "not_found" }
    | { kind: "conflict"; reason: RequestConflictReason }
    | { kind: "updated"; request: MusicRequest };

/** Dispatcher input returned only for a fresh approval job. */
export interface DownloadDispatch {
    jobId: string;
    type: "album";
    mbid: string;
    subject: string;
    artistName?: string;
    artistMbid?: string;
    albumTitle?: string;
}

/** Approval result including optional background dispatch ownership. */
export type ApprovalResult =
    | { kind: "not_found" }
    | { kind: "conflict"; reason: RequestConflictReason }
    | {
          kind: "updated";
          request: MusicRequest;
          duplicate: boolean;
          dispatch: DownloadDispatch | null;
      };

/** Optional values resolved by a bounded bulk-approval caller. */
export interface ApproveRequestOptions {
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

/** Milliseconds in one 24-hour request policy window. */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Trim optional text and collapse blank input to undefined. */
export function normalizeOptionalText(value?: string): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}

function cooldownError(cooldownUntil: Date): never {
    recordMusicRequestAction("rejected_cooldown");
    throw new MusicRequestServiceError(
        "recently_denied",
        "This album was declined recently and can be requested again later",
        cooldownUntil,
    );
}

function duplicateError(code: MusicRequestErrorCode, message: string): never {
    recordMusicRequestAction("rejected_duplicate");
    throw new MusicRequestServiceError(code, message);
}

async function rejectIfOwned(rgMbid: string): Promise<void> {
    // Library rows with synthetic `temp-` or `federation:` rgMbids cannot match
    // a real release-group MBID here; administrator review is the backstop.
    const owned = await prisma.album.findFirst({
        where: { rgMbid, location: "LIBRARY" },
        select: { id: true },
    });
    if (owned)
        duplicateError("already_in_library", "Album is already in the library");
}

async function rejectIfOpenRequest(rgMbid: string): Promise<void> {
    const open = await prisma.musicRequest.findFirst({
        where: { rgMbid, status: { in: [...OPEN_REQUEST_STATUSES] } },
        select: { id: true },
    });
    if (open)
        duplicateError("already_requested", "Album has already been requested");
}

async function rejectIfDownloading(rgMbid: string): Promise<void> {
    const active = await prisma.downloadJob.findFirst({
        where: {
            targetMbid: rgMbid,
            status: { in: ACTIVE_DOWNLOAD_JOB_STATUSES },
        },
        select: { id: true },
    });
    if (active)
        duplicateError("already_downloading", "Album is already downloading");
}

async function rejectIfCoolingDown(rgMbid: string): Promise<void> {
    if (config.requests.deniedCooldownDays === 0) return;
    const denied = await prisma.musicRequest.findFirst({
        where: {
            rgMbid,
            status: "denied",
            cooldownUntil: { gt: new Date() },
        },
        select: { cooldownUntil: true },
        orderBy: { cooldownUntil: "desc" },
    });
    if (denied?.cooldownUntil) cooldownError(denied.cooldownUntil);
}

function dailyCutoff(now = new Date()): Date {
    return new Date(now.getTime() - ONE_DAY_MS);
}

async function requestsInLastDay(userId: string): Promise<number> {
    return prisma.musicRequest.count({
        where: { userId, createdAt: { gt: dailyCutoff() } },
    });
}

async function rejectIfAtDailyCap(userId: string): Promise<void> {
    const count = await requestsInLastDay(userId);
    if (count < config.requests.dailyCapPerUser) return;
    recordMusicRequestAction("rejected_cap");
    throw new MusicRequestServiceError(
        "daily_cap",
        "Daily request limit reached",
    );
}

async function notifyAdminsOfSubmission(request: MusicRequest): Promise<void> {
    try {
        const [requester, adminIds] = await Promise.all([
            prisma.user.findUnique({
                where: { id: request.userId },
                select: { username: true },
            }),
            listAdminRecipientIds(),
        ]);
        const metadata = buildRequestNotificationMetadata(request);
        const outcomes = await Promise.allSettled(
            adminIds.map((adminId) =>
                notificationService.notifyRequestSubmitted(
                    adminId,
                    requester?.username || "A user",
                    metadata,
                ),
            ),
        );
        if (outcomes.some((outcome) => outcome.status === "rejected")) {
            log.warn("One or more request submission notifications failed", {
                requestId: request.id,
            });
        }
    } catch (error) {
        log.warn("Request submission notification fan-out failed", {
            requestId: request.id,
            error,
        });
    }
}

/** Create one pending album request after ordered deduplication and quota checks. */
export async function createRequest(
    userId: string,
    input: CreateMusicRequestInput,
): Promise<MusicRequest> {
    // These deduplication and quota reads are intentionally best effort. Races
    // may create cross-user duplicates or exceed the daily cap; approval shares
    // active jobs and re-checks ownership before starting a download.
    await rejectIfOwned(input.rgMbid);
    await rejectIfOpenRequest(input.rgMbid);
    await rejectIfDownloading(input.rgMbid);
    await rejectIfCoolingDown(input.rgMbid);
    await rejectIfAtDailyCap(userId);
    let request: MusicRequest;
    try {
        request = await prisma.musicRequest.create({
            data: {
                userId,
                type: "album",
                artistName: input.artistName,
                albumTitle: input.albumTitle,
                artistMbid: input.artistMbid,
                rgMbid: input.rgMbid,
                note: normalizeOptionalText(input.note),
            },
        });
    } catch (error) {
        if (isP2002(error)) {
            duplicateError(
                "already_requested",
                "Album has already been requested",
            );
        }
        throw error;
    }
    recordMusicRequestAction("created");
    log.info("Music request created", { requestId: request.id, userId });
    await notifyAdminsOfSubmission(request);
    return request;
}

function mapPreferredAlbums(albums: AlbumLink[]): Map<string, AlbumLink> {
    const preferred = new Map<string, AlbumLink>();
    for (const album of albums) {
        const current = preferred.get(album.rgMbid);
        if (
            !current ||
            (current.location !== "LIBRARY" && album.location === "LIBRARY")
        ) {
            preferred.set(album.rgMbid, album);
        }
    }
    return preferred;
}

async function attachLibraryLinks<T extends LinkableRequest>(
    rows: T[],
): Promise<Array<T & RequestLibraryLinks>> {
    if (rows.length === 0) return [];
    const rgMbids = [...new Set(rows.map((row) => row.rgMbid))];
    const albums = await prisma.album.findMany({
        where: { rgMbid: { in: rgMbids } },
        select: { id: true, rgMbid: true, location: true, artistId: true },
    });
    const albumsByMbid = mapPreferredAlbums(albums);
    const artistsByMbid = await resolveFallbackArtists(rows, albumsByMbid);
    return addLibraryLinks(rows, albumsByMbid, artistsByMbid);
}

async function resolveFallbackArtists<T extends LinkableRequest>(
    rows: T[],
    albumsByMbid: Map<string, AlbumLink>,
): Promise<Map<string, string>> {
    const fallbackMbids = [
        ...new Set(
            rows
                .filter((row) => !albumsByMbid.has(row.rgMbid))
                .map((row) => row.artistMbid)
                .filter((mbid): mbid is string => mbid !== null),
        ),
    ];
    const artists = fallbackMbids.length
        ? await prisma.artist.findMany({
              where: { mbid: { in: fallbackMbids } },
              select: { id: true, mbid: true },
          })
        : [];
    return new Map(artists.map((artist) => [artist.mbid, artist.id]));
}

function addLibraryLinks<T extends LinkableRequest>(
    rows: T[],
    albumsByMbid: Map<string, AlbumLink>,
    artistsByMbid: Map<string, string>,
): Array<T & RequestLibraryLinks> {
    return rows.map((row) => {
        const album = albumsByMbid.get(row.rgMbid);
        return {
            ...row,
            albumId: album?.id ?? null,
            artistId:
                album?.artistId ??
                (row.artistMbid
                    ? (artistsByMbid.get(row.artistMbid) ?? null)
                    : null),
        };
    });
}

async function attachDownloadStatuses<T extends LinkableRequest>(
    rows: T[],
): Promise<Array<T & RequestDownloadLink>> {
    const jobIds = [
        ...new Set(
            rows.flatMap((row) =>
                row.downloadJobId ? [row.downloadJobId] : [],
            ),
        ),
    ];
    const jobs = jobIds.length
        ? await prisma.downloadJob.findMany({
              where: { id: { in: jobIds } },
              select: { id: true, status: true },
          })
        : [];
    const statuses = new Map(jobs.map((job) => [job.id, job.status]));
    return rows.map((row) => ({
        ...row,
        downloadStatus: row.downloadJobId
            ? (statuses.get(row.downloadJobId) ?? null)
            : null,
    }));
}

async function enrichRequestRows<T extends LinkableRequest>(
    rows: T[],
): Promise<Array<T & RequestLibraryLinks & RequestDownloadLink>> {
    const linked = await attachLibraryLinks(rows);
    return attachDownloadStatuses(linked);
}

function listOptions(
    options?: MusicRequestListOptions,
): MusicRequestListOptions {
    return (
        options ?? {
            limit: DEFAULT_REQUEST_LIST_LIMIT,
            offset: 0,
        }
    );
}

/** List the caller's filtered request history newest first. */
export async function listRequestsForUser(
    userId: string,
    requestedOptions?: MusicRequestListOptions,
): Promise<
    MusicRequestPage<MusicRequest & RequestLibraryLinks & RequestDownloadLink>
> {
    const options = listOptions(requestedOptions);
    const where = {
        userId,
        ...(options.status ? { status: options.status } : {}),
    };
    const [rows, total] = await Promise.all([
        prisma.musicRequest.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: options.offset,
            take: options.limit,
        }),
        prisma.musicRequest.count({ where }),
    ]);
    return {
        requests: await enrichRequestRows(rows),
        total,
        offset: options.offset,
        limit: options.limit,
    };
}

/** Return current feature availability and the rolling 24-hour allowance. */
export async function getRequestAvailability(userId: string): Promise<{
    enabled: true;
    remainingToday: number;
    dailyCap: number;
    deniedCooldownDays: number;
}> {
    const dailyCap = config.requests.dailyCapPerUser;
    const used = await requestsInLastDay(userId);
    return {
        enabled: true,
        remainingToday: Math.max(0, dailyCap - used),
        dailyCap,
        deniedCooldownDays: config.requests.deniedCooldownDays,
    };
}

/** Cancel the caller's pending request without revealing other users' rows. */
export async function cancelOwnRequest(
    userId: string,
    id: string,
): Promise<RequestTransitionResult> {
    const changed = await prisma.musicRequest.updateMany({
        where: { id, userId, status: "pending" },
        data: { status: "cancelled" },
    });
    if (changed.count === 0) {
        const own = await prisma.musicRequest.findFirst({
            where: { id, userId },
            select: { id: true, status: true },
        });
        return own
            ? { kind: "conflict", reason: "not_reviewable" }
            : { kind: "not_found" };
    }
    const request = await prisma.musicRequest.findUnique({ where: { id } });
    if (!request) return { kind: "not_found" };
    recordMusicRequestAction("cancelled");
    log.info("Music request cancelled", { requestId: id, userId });
    return { kind: "updated", request };
}

/** List one bounded administrator queue page with requester identity. */
export async function listAllRequests(
    requestedOptions?: MusicRequestListOptions,
): Promise<
    MusicRequestPage<
        MusicRequest &
            RequestLibraryLinks &
            RequestDownloadLink & { user: { id: string; username: string } }
    >
> {
    const options = listOptions(requestedOptions);
    const where = options.status ? { status: options.status } : undefined;
    const [rows, total] = await Promise.all([
        prisma.musicRequest.findMany({
            where,
            include: { user: { select: { id: true, username: true } } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: options.offset,
            take: options.limit,
        }),
        prisma.musicRequest.count({ where }),
    ]);
    return {
        requests: await enrichRequestRows(rows),
        total,
        offset: options.offset,
        limit: options.limit,
    };
}

/** Return every request status count with absent groups zero-filled. */
export async function getRequestCounts(): Promise<
    Record<MusicRequestStatus, number>
> {
    const counts: Record<MusicRequestStatus, number> = {
        pending: 0,
        approved: 0,
        denied: 0,
        fulfilled: 0,
        failed: 0,
        cancelled: 0,
    };
    const grouped = await prisma.musicRequest.groupBy({
        by: ["status"],
        where: { status: { in: [...MUSIC_REQUEST_STATUSES] } },
        _count: { _all: true },
    });
    for (const row of grouped) {
        if (isMusicRequestStatus(row.status))
            counts[row.status] = row._count._all;
    }
    return counts;
}

function isMusicRequestStatus(status: string): status is MusicRequestStatus {
    return (MUSIC_REQUEST_STATUSES as readonly string[]).includes(status);
}

function approvalJobParams(
    request: MusicRequest,
    adminId: string,
    rootFolderPath: string,
): CreateAlbumDownloadJobParams {
    return {
        userId: adminId,
        mbid: request.rgMbid,
        subject: `${request.artistName} - ${request.albumTitle}`,
        artistName: request.artistName,
        artistMbid: request.artistMbid ?? undefined,
        albumTitle: request.albumTitle,
        downloadType: "library",
        rootFolderPath,
        metadata: {
            queuedVia: ALBUM_DOWNLOAD_QUEUE_OWNER,
            noFallback: true,
        },
    };
}

function approvalDispatch(
    request: MusicRequest,
    jobResult: AlbumDownloadJobResult,
): DownloadDispatch | null {
    if (jobResult.duplicate) return null;
    return {
        jobId: jobResult.job.id,
        type: "album",
        mbid: request.rgMbid,
        subject: `${request.artistName} - ${request.albumTitle}`,
        artistName: jobResult.verifiedArtistName,
        artistMbid: request.artistMbid ?? undefined,
        albumTitle: request.albumTitle,
    };
}

class ApprovalStatusConflict extends Error {}

async function transitionToApproved(
    transaction: Prisma.TransactionClient,
    adminId: string,
    requestId: string,
    observedStatus: ReviewableRequestStatus,
): Promise<boolean> {
    try {
        const changed = await transaction.musicRequest.updateMany({
            where: { id: requestId, status: observedStatus },
            data: {
                status: "approved",
                reviewedById: adminId,
                reviewedAt: new Date(),
            },
        });
        return changed.count > 0;
    } catch (error) {
        if (isP2002(error)) throw new ApprovalStatusConflict();
        throw error;
    }
}

async function approveWithJob(
    adminId: string,
    request: MusicRequest,
    rootFolderPath: string,
    observedStatus: ReviewableRequestStatus,
    verifiedArtistName?: string,
): Promise<ApprovalResult> {
    return prisma.$transaction(async (transaction) => {
        const changed = await transitionToApproved(
            transaction,
            adminId,
            request.id,
            observedStatus,
        );
        if (!changed)
            return { kind: "conflict", reason: "not_reviewable" } as const;
        const jobResult = await createAlbumDownloadJob(
            approvalJobParams(request, adminId, rootFolderPath),
            transaction,
            verifiedArtistName,
        );
        const updated = await transaction.musicRequest.update({
            where: { id: request.id },
            data: { downloadJobId: jobResult.job.id },
        });
        return {
            kind: "updated",
            request: updated,
            duplicate: jobResult.duplicate,
            dispatch: approvalDispatch(request, jobResult),
        } as const;
    });
}

async function approveWithExistingJob(
    adminId: string,
    request: MusicRequest,
    job: DownloadJob,
    observedStatus: ReviewableRequestStatus,
): Promise<ApprovalResult> {
    return prisma.$transaction(async (transaction) => {
        const changed = await transitionToApproved(
            transaction,
            adminId,
            request.id,
            observedStatus,
        );
        if (!changed)
            return { kind: "conflict", reason: "not_reviewable" } as const;
        const updated = await transaction.musicRequest.update({
            where: { id: request.id },
            data: { downloadJobId: job.id },
        });
        return {
            kind: "updated",
            request: updated,
            duplicate: true,
            dispatch: null,
        } as const;
    });
}

async function bestEffortApprovalNotification(
    request: MusicRequest,
): Promise<void> {
    try {
        await notificationService.notifyRequestApproved(
            request.userId,
            buildRequestNotificationMetadata(request),
        );
    } catch (error) {
        log.warn("Request approval notification failed", {
            requestId: request.id,
            error,
        });
    }
}

async function bestEffortFulfillmentNotification(
    request: MusicRequest,
    albumId: string,
): Promise<void> {
    try {
        await notificationService.notifyRequestFulfilled(
            request.userId,
            buildRequestNotificationMetadata(request, albumId),
        );
    } catch (error) {
        log.warn("Request fulfillment notification failed", {
            requestId: request.id,
            error,
        });
    }
}

async function fulfillOwnedRequest(
    adminId: string,
    request: MusicRequest,
    observedStatus: ReviewableRequestStatus,
    albumId: string,
): Promise<ApprovalResult> {
    const changed = await prisma.musicRequest.updateMany({
        where: { id: request.id, status: observedStatus },
        data: {
            status: "fulfilled",
            reviewedById: adminId,
            reviewedAt: new Date(),
        },
    });
    if (changed.count === 0) {
        return { kind: "conflict", reason: "not_reviewable" };
    }
    const updated = await prisma.musicRequest.findUnique({
        where: { id: request.id },
    });
    if (!updated) return { kind: "not_found" };
    recordMusicRequestAction("fulfilled");
    log.info("Owned music request fulfilled during approval", {
        requestId: request.id,
        adminId,
    });
    await bestEffortFulfillmentNotification(updated, albumId);
    return {
        kind: "updated",
        request: updated,
        duplicate: true,
        dispatch: null,
    };
}

function isReviewableStatus(status: string): status is ReviewableRequestStatus {
    return status === "pending" || status === "failed";
}

async function hasOtherOpenRequest(request: MusicRequest): Promise<boolean> {
    if (request.status !== "failed") return false;
    const open = await prisma.musicRequest.findFirst({
        where: {
            id: { not: request.id },
            userId: request.userId,
            rgMbid: request.rgMbid,
            status: { in: [...OPEN_REQUEST_STATUSES] },
        },
        select: { id: true },
    });
    return open !== null;
}

async function approveWithActiveJobFallback(
    adminId: string,
    request: MusicRequest,
    observedStatus: ReviewableRequestStatus,
    rootFolderPath: string,
    verifiedArtistName?: string,
): Promise<ApprovalResult> {
    try {
        return await approveWithJob(
            adminId,
            request,
            rootFolderPath,
            observedStatus,
            verifiedArtistName,
        );
    } catch (error) {
        if (error instanceof ApprovalStatusConflict)
            return { kind: "conflict", reason: "open_request_exists" };
        if (!isP2002(error)) throw error;
        return approveUsingExistingJob(adminId, request, observedStatus, error);
    }
}

async function approveUsingExistingJob(
    adminId: string,
    request: MusicRequest,
    observedStatus: ReviewableRequestStatus,
    originalError: unknown,
): Promise<ApprovalResult> {
    const job = await prisma.downloadJob.findFirst({
        where: {
            targetMbid: request.rgMbid,
            status: { in: ACTIVE_DOWNLOAD_JOB_STATUSES },
        },
        orderBy: { createdAt: "asc" },
    });
    if (!job) throw originalError;
    try {
        return await approveWithExistingJob(
            adminId,
            request,
            job,
            observedStatus,
        );
    } catch (error) {
        if (error instanceof ApprovalStatusConflict)
            return { kind: "conflict", reason: "open_request_exists" };
        throw error;
    }
}

/** Approve a pending or failed request and atomically link its shared job. */
export async function approveRequest(
    adminId: string,
    id: string,
    options?: ApproveRequestOptions,
): Promise<ApprovalResult> {
    const request = await prisma.musicRequest.findUnique({ where: { id } });
    if (!request) return { kind: "not_found" };
    if (!isReviewableStatus(request.status)) {
        return { kind: "conflict", reason: "not_reviewable" };
    }
    const observedStatus = request.status;
    const owned = await prisma.album.findFirst({
        where: { rgMbid: request.rgMbid, location: "LIBRARY" },
        select: { id: true },
    });
    if (owned) {
        return fulfillOwnedRequest(adminId, request, observedStatus, owned.id);
    }
    if (await hasOtherOpenRequest(request)) {
        return { kind: "conflict", reason: "open_request_exists" };
    }
    const settings = await getSystemSettings();
    const rootFolderPath = settings?.musicPath || config.music.musicPath;
    const verifiedArtistName =
        options?.verifiedArtistName ??
        (await resolveAlbumDownloadArtistName(request.artistName));
    const result = await approveWithActiveJobFallback(
        adminId,
        request,
        observedStatus,
        rootFolderPath,
        verifiedArtistName,
    );
    if (result.kind !== "updated") return result;
    recordMusicRequestAction("approved");
    log.info("Music request approved", { requestId: id, adminId });
    await bestEffortApprovalNotification(result.request);
    return result;
}

async function bestEffortDenialNotification(
    request: MusicRequest,
    reason?: string,
): Promise<void> {
    try {
        await notificationService.notifyRequestDenied(
            request.userId,
            buildRequestNotificationMetadata(request),
            reason,
        );
    } catch (error) {
        log.warn("Request denial notification failed", {
            requestId: request.id,
            error,
        });
    }
}

function denialCooldownUntil(reviewedAt: Date): Date | null {
    const days = config.requests.deniedCooldownDays;
    return days > 0 ? new Date(reviewedAt.getTime() + days * ONE_DAY_MS) : null;
}

/** Deny a pending or failed request through a conditional transition. */
export async function denyRequest(
    adminId: string,
    id: string,
    reason?: string,
): Promise<RequestTransitionResult> {
    const existing = await prisma.musicRequest.findUnique({ where: { id } });
    if (!existing) return { kind: "not_found" };
    if (!isReviewableStatus(existing.status)) {
        return { kind: "conflict", reason: "not_reviewable" };
    }
    const observedStatus = existing.status;
    const deniedReason = normalizeOptionalText(reason);
    const reviewedAt = new Date();
    const changed = await prisma.musicRequest.updateMany({
        where: { id, status: observedStatus },
        data: {
            status: "denied",
            deniedReason,
            reviewedById: adminId,
            reviewedAt,
            cooldownUntil: denialCooldownUntil(reviewedAt),
        },
    });
    if (changed.count === 0) {
        return { kind: "conflict", reason: "not_reviewable" };
    }
    const request = await prisma.musicRequest.findUnique({ where: { id } });
    if (!request) return { kind: "not_found" };
    recordMusicRequestAction("denied");
    log.info("Music request denied", { requestId: id, adminId });
    await bestEffortDenialNotification(request, deniedReason);
    return { kind: "updated", request };
}
