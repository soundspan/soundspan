import { logger } from "../../utils/logger";
import { patchDownloadJobMetadata } from "../downloadJobStatus";
import { notificationPolicyService } from "../notificationPolicyService";
import { notificationService } from "../notificationService";
import type {
    DownloadJobEventPayloads,
    DownloadJobEvents,
} from "./downloadJobEvents";

async function handleCompleted(
    payload: DownloadJobEventPayloads["download.completed"],
): Promise<void> {
    try {
        const decision = await notificationPolicyService.evaluateNotification(
            payload.jobId,
            "complete",
        );
        if (!decision.shouldNotify) {
            logger.debug(
                `   Suppressing completion notification: ${decision.reason}`,
            );
            return;
        }
        logger.debug(`   Sending completion notification: ${decision.reason}`);
        await notificationService.notifyDownloadComplete(
            payload.userId,
            payload.subject,
            undefined,
            payload.artistId,
        );
        await patchDownloadJobMetadata(payload.jobId, {
            notificationSent: true,
        });
    } catch (error) {
        logger.error("Failed to evaluate/send download notification:", error);
    }
}

async function handleExhausted(
    payload: DownloadJobEventPayloads["download.exhausted"],
): Promise<void> {
    try {
        const decision = await notificationPolicyService.evaluateNotification(
            payload.jobId,
            "failed",
        );
        if (!decision.shouldNotify) {
            logger.debug(
                `   Suppressing failure notification: ${decision.reason}`,
            );
            return;
        }
        logger.debug(`   Sending failure notification: ${decision.reason}`);
        await notificationService.notifyDownloadFailed(
            payload.userId,
            payload.subject,
            payload.reason,
        );
        await patchDownloadJobMetadata(payload.jobId, {
            notificationSent: true,
        });
    } catch (error) {
        logger.error("Failed to evaluate/send failure notification:", error);
    }
}

async function handleTimedOut(
    payload: DownloadJobEventPayloads["download.timedOut"],
): Promise<{ timeoutExtended: boolean }> {
    try {
        const decision = await notificationPolicyService.evaluateNotification(
            payload.jobId,
            "timeout",
        );
        const timeoutExtended =
            decision.reason.includes("retry window") ||
            decision.reason.includes("extending timeout");
        return { timeoutExtended };
    } catch (error) {
        logger.error(
            `   Failed to evaluate policy for ${payload.jobId}:`,
            error,
        );
        return { timeoutExtended: false };
    }
}

/** Wire notification policy and delivery to download-job events. */
export function registerDownloadJobNotificationSubscriber(
    events: DownloadJobEvents,
): void {
    events.on("download.completed", handleCompleted);
    events.on("download.exhausted", handleExhausted);
    events.on("download.timedOut", handleTimedOut);
}
