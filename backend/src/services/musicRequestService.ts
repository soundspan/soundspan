import type { Album, DownloadJob, MusicRequest } from "@prisma/client";
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
import {
    notificationService,
    type RequestNotificationMetadata,
} from "./notificationService";

const log = logger.child("MusicRequestService");
const MAX_ADMIN_NOTIFICATIONS = 200;
const MAX_REQUEST_LIST_SIZE = 200;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_REQUEST_STATUSES = ["pending", "approved"] as const;

type RequestLibraryLinks = {
    albumId: string | null;
    artistId: string | null;
};
type LinkableRequest = Pick<MusicRequest, "rgMbid" | "artistMbid">;
type AlbumLink = Pick<Album, "id" | "rgMbid" | "location" | "artistId">;

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
/** Create-time conflict and quota decisions exposed to the route boundary. */
export type MusicRequestErrorCode =
    | "already_in_library"
    | "already_requested"
    | "already_downloading"
    | "daily_cap";

/** Stable service failure used by the route's HTTP conflict mapping. */
export class MusicRequestServiceError extends Error {
    constructor(
        public readonly code: MusicRequestErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "MusicRequestServiceError";
    }
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
    | { kind: "conflict" }
    | { kind: "updated"; request: MusicRequest };

/** Positional download processor input returned only for a fresh approval job. */
export interface DownloadDispatch {
    jobId: string;
    type: "album";
    mbid: string;
    subject: string;
    rootFolderPath: string;
    artistName?: string;
    albumTitle?: string;
}

/** Approval result including optional background dispatch ownership. */
export type ApprovalResult =
    | { kind: "not_found" }
    | { kind: "conflict" }
    | {
          kind: "updated";
          request: MusicRequest;
          duplicate: boolean;
          dispatch: DownloadDispatch | null;
      };

function isP2002(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
    );
}

function normalizeOptionalText(value?: string): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}

function requestNotificationMetadata(
    request: Pick<MusicRequest, "id" | "rgMbid" | "artistName" | "albumTitle">,
): RequestNotificationMetadata {
    return {
        requestId: request.id,
        rgMbid: request.rgMbid,
        artistName: request.artistName,
        albumTitle: request.albumTitle,
    };
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
            status: { in: ["pending", "processing"] },
        },
        select: { id: true },
    });
    if (active)
        duplicateError("already_downloading", "Album is already downloading");
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
        const [requester, admins] = await Promise.all([
            prisma.user.findUnique({
                where: { id: request.userId },
                select: { username: true },
            }),
            prisma.user.findMany({
                where: { role: "admin" },
                select: { id: true },
                take: MAX_ADMIN_NOTIFICATIONS,
            }),
        ]);
        const metadata = requestNotificationMetadata(request);
        const outcomes = await Promise.allSettled(
            admins.map((admin) =>
                notificationService.notifyRequestSubmitted(
                    admin.id,
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

/** List the caller's request history newest first. */
export async function listRequestsForUser(
    userId: string,
): Promise<Array<MusicRequest & RequestLibraryLinks>> {
    const rows = await prisma.musicRequest.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: MAX_REQUEST_LIST_SIZE,
    });
    return attachLibraryLinks(rows);
}

/** Return current feature availability and the rolling 24-hour allowance. */
export async function getRequestAvailability(userId: string): Promise<{
    enabled: true;
    remainingToday: number;
    dailyCap: number;
}> {
    const dailyCap = config.requests.dailyCapPerUser;
    const used = await requestsInLastDay(userId);
    return {
        enabled: true,
        remainingToday: Math.max(0, dailyCap - used),
        dailyCap,
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
        return own ? { kind: "conflict" } : { kind: "not_found" };
    }
    const request = await prisma.musicRequest.findUnique({ where: { id } });
    if (!request) return { kind: "not_found" };
    recordMusicRequestAction("cancelled");
    log.info("Music request cancelled", { requestId: id, userId });
    return { kind: "updated", request };
}

/** List the bounded administrator queue with requester identity. */
export async function listAllRequests(
    status?: MusicRequestStatus,
): Promise<
    Array<
        MusicRequest &
            RequestLibraryLinks & { user: { id: string; username: string } }
    >
> {
    const rows = await prisma.musicRequest.findMany({
        where: status ? { status } : undefined,
        include: { user: { select: { id: true, username: true } } },
        orderBy: { createdAt: "desc" },
        take: MAX_REQUEST_LIST_SIZE,
    });
    return attachLibraryLinks(rows);
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
        albumTitle: request.albumTitle,
        downloadType: "library",
        rootFolderPath,
    };
}

function approvalDispatch(
    request: MusicRequest,
    rootFolderPath: string,
    jobResult: AlbumDownloadJobResult,
): DownloadDispatch | null {
    if (jobResult.duplicate) return null;
    return {
        jobId: jobResult.job.id,
        type: "album",
        mbid: request.rgMbid,
        subject: `${request.artistName} - ${request.albumTitle}`,
        rootFolderPath,
        artistName: jobResult.verifiedArtistName,
        albumTitle: request.albumTitle,
    };
}

async function approveWithJob(
    adminId: string,
    request: MusicRequest,
    rootFolderPath: string,
    verifiedArtistName?: string,
): Promise<ApprovalResult> {
    return prisma.$transaction(async (transaction) => {
        const reviewedAt = new Date();
        const changed = await transaction.musicRequest.updateMany({
            where: { id: request.id, status: "pending" },
            data: { status: "approved", reviewedById: adminId, reviewedAt },
        });
        if (changed.count === 0) return { kind: "conflict" } as const;
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
            dispatch: approvalDispatch(request, rootFolderPath, jobResult),
        } as const;
    });
}

async function approveWithExistingJob(
    adminId: string,
    request: MusicRequest,
    job: DownloadJob,
): Promise<ApprovalResult> {
    return prisma.$transaction(async (transaction) => {
        const changed = await transaction.musicRequest.updateMany({
            where: { id: request.id, status: "pending" },
            data: {
                status: "approved",
                reviewedById: adminId,
                reviewedAt: new Date(),
            },
        });
        if (changed.count === 0) return { kind: "conflict" } as const;
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
            requestNotificationMetadata(request),
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
): Promise<void> {
    try {
        await notificationService.notifyRequestFulfilled(
            request.userId,
            requestNotificationMetadata(request),
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
): Promise<ApprovalResult> {
    const changed = await prisma.musicRequest.updateMany({
        where: { id: request.id, status: "pending" },
        data: {
            status: "fulfilled",
            reviewedById: adminId,
            reviewedAt: new Date(),
        },
    });
    if (changed.count === 0) return { kind: "conflict" };
    const updated = await prisma.musicRequest.findUnique({
        where: { id: request.id },
    });
    if (!updated) return { kind: "not_found" };
    recordMusicRequestAction("fulfilled");
    log.info("Owned music request fulfilled during approval", {
        requestId: request.id,
        adminId,
    });
    await bestEffortFulfillmentNotification(updated);
    return {
        kind: "updated",
        request: updated,
        duplicate: true,
        dispatch: null,
    };
}

/** Approve a pending request and atomically link its shared download job. */
export async function approveRequest(
    adminId: string,
    id: string,
): Promise<ApprovalResult> {
    const request = await prisma.musicRequest.findUnique({ where: { id } });
    if (!request) return { kind: "not_found" };
    if (request.status !== "pending") return { kind: "conflict" };
    const owned = await prisma.album.findFirst({
        where: { rgMbid: request.rgMbid, location: "LIBRARY" },
        select: { id: true },
    });
    if (owned) return fulfillOwnedRequest(adminId, request);
    const settings = await getSystemSettings();
    const rootFolderPath = settings?.musicPath || config.music.musicPath;
    const verifiedArtistName = await resolveAlbumDownloadArtistName(
        request.artistName,
    );
    let result: ApprovalResult;
    try {
        result = await approveWithJob(
            adminId,
            request,
            rootFolderPath,
            verifiedArtistName,
        );
    } catch (error) {
        if (!isP2002(error)) throw error;
        const job = await prisma.downloadJob.findFirst({
            where: {
                targetMbid: request.rgMbid,
                status: { in: ["pending", "processing"] },
            },
            orderBy: { createdAt: "asc" },
        });
        if (!job) throw error;
        result = await approveWithExistingJob(adminId, request, job);
    }
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
            requestNotificationMetadata(request),
            reason,
        );
    } catch (error) {
        log.warn("Request denial notification failed", {
            requestId: request.id,
            error,
        });
    }
}

/** Deny a pending request through an atomic conditional transition. */
export async function denyRequest(
    adminId: string,
    id: string,
    reason?: string,
): Promise<RequestTransitionResult> {
    const existing = await prisma.musicRequest.findUnique({ where: { id } });
    if (!existing) return { kind: "not_found" };
    if (existing.status !== "pending") return { kind: "conflict" };
    const deniedReason = normalizeOptionalText(reason);
    const changed = await prisma.musicRequest.updateMany({
        where: { id, status: "pending" },
        data: {
            status: "denied",
            deniedReason,
            reviewedById: adminId,
            reviewedAt: new Date(),
        },
    });
    if (changed.count === 0) return { kind: "conflict" };
    const request = await prisma.musicRequest.findUnique({ where: { id } });
    if (!request) return { kind: "not_found" };
    recordMusicRequestAction("denied");
    log.info("Music request denied", { requestId: id, adminId });
    await bestEffortDenialNotification(request, deniedReason);
    return { kind: "updated", request };
}
