import {
    buildRequestNotificationMetadata,
    listAdminRecipientIds,
    notificationService,
    type RequestFailureCause,
} from "../../services/notificationService";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";

const log = logger.child("RequestFulfillmentNotifications");

/** Request fields needed for terminal lifecycle notifications. */
export interface RequestNotificationCandidate {
    id: string;
    userId: string;
    rgMbid: string;
    artistName: string;
    albumTitle: string;
}

/** Lazy administrator-recipient lookup shared by one fulfillment tick. */
export type AdminRecipientIdsLoader = () => Promise<string[]>;

/** Create a lazy, memoized administrator-recipient lookup. */
export function createAdminRecipientIdsLoader(): AdminRecipientIdsLoader {
    let recipients: Promise<string[]> | undefined;
    return () => {
        recipients ??= listAdminRecipientIds().catch((error) => {
            recipients = undefined;
            throw error;
        });
        return recipients;
    };
}

async function notifyFulfilled(
    request: RequestNotificationCandidate,
    albumId?: string,
): Promise<void> {
    await notificationService.notifyRequestFulfilled(
        request.userId,
        buildRequestNotificationMetadata(request, albumId),
    );
}

async function loadFailureRecipients(
    userId: string,
    loadAdminRecipientIds: AdminRecipientIdsLoader,
): Promise<{
    requesterUsername: string;
    adminIds: string[];
}> {
    const [requester, admins] = await Promise.allSettled([
        prisma.user.findUnique({
            where: { id: userId },
            select: { username: true },
        }),
        loadAdminRecipientIds(),
    ]);
    if (requester.status === "rejected") {
        log.warn("Requester username lookup failed", {
            userId,
            error: requester.reason,
        });
    }
    if (admins.status === "rejected") {
        log.warn("Administrator recipient lookup failed", {
            userId,
            error: admins.reason,
        });
    }
    return {
        requesterUsername:
            requester.status === "fulfilled"
                ? requester.value?.username || "A user"
                : "A user",
        adminIds:
            admins.status === "fulfilled"
                ? admins.value.filter((adminId) => adminId !== userId)
                : [],
    };
}

function adminFailureNotifications(
    request: RequestNotificationCandidate,
    cause: RequestFailureCause,
    requesterUsername: string,
    adminIds: string[],
): Array<Promise<unknown>> {
    const details = buildRequestNotificationMetadata(request);
    return adminIds.map((adminId) =>
        notificationService.notifyAdminRequestFailed(
            adminId,
            requesterUsername,
            details,
            cause,
        ),
    );
}

async function notifyFailed(
    request: RequestNotificationCandidate,
    cause: RequestFailureCause,
    loadAdminRecipientIds: AdminRecipientIdsLoader,
): Promise<void> {
    const requesterOutcome = Promise.allSettled([
        notificationService.notifyRequestFailed(
            request.userId,
            buildRequestNotificationMetadata(request),
            cause,
        ),
    ]);
    const recipients = await loadFailureRecipients(
        request.userId,
        loadAdminRecipientIds,
    );
    const adminNotifications = adminFailureNotifications(
        request,
        cause,
        recipients.requesterUsername,
        recipients.adminIds,
    );
    const [requesterOutcomes, adminOutcomes] = await Promise.all([
        requesterOutcome,
        Promise.allSettled(adminNotifications),
    ]);
    const outcomes = [...requesterOutcomes, ...adminOutcomes];
    if (outcomes.some((outcome) => outcome.status === "rejected")) {
        log.warn("One or more request failure notifications failed", {
            requestId: request.id,
        });
    }
}

/** Send best-effort requester and administrator terminal notifications. */
export async function notifyRequestTransition(
    request: RequestNotificationCandidate,
    nextStatus: "fulfilled" | "failed",
    options: {
        albumId?: string;
        cause?: RequestFailureCause;
        loadAdminRecipientIds: AdminRecipientIdsLoader;
    },
): Promise<void> {
    try {
        if (nextStatus === "fulfilled") {
            await notifyFulfilled(request, options.albumId);
        } else if (options.cause) {
            await notifyFailed(
                request,
                options.cause,
                options.loadAdminRecipientIds,
            );
        }
    } catch (error) {
        log.warn("Request fulfillment notification failed", {
            requestId: request.id,
            nextStatus,
            error,
        });
    }
}
