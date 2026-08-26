import type Bull from "bull";
import { recordScrobbleOutcome } from "../../metrics";
import {
    InvalidScrobbleAuthError,
    submitScrobbleJob,
} from "../../services/scrobbleSubmission";
import {
    SCROBBLE_SERVICES,
    scrobbleJobSchema,
    type ScrobbleJobData,
} from "../../services/scrobbleTypes";
import { prisma } from "../../utils/db";

export type ScrobbleProcessOutcome = "submitted" | "dropped" | "invalid_auth";

async function disableInvalidConnection(
    data: ScrobbleJobData,
    failedCredential: string | undefined,
): Promise<void> {
    // Compare-and-swap on the exact credential the failed submission used:
    // an in-flight job holding an old credential must never disable a
    // connection the user has since reauthenticated. No ciphertext means
    // the row was already missing or disabled - nothing to change.
    if (!failedCredential) return;
    await prisma.scrobbleConnection.updateMany({
        where: {
            userId: data.userId,
            service: data.service,
            enabled: true,
            encryptedCredential: failedCredential,
        },
        data: { enabled: false },
    });
}

/** Processes one provider job and lets Bull own bounded transient retries. */
export async function processScrobble(
    job: Bull.Job<ScrobbleJobData>,
): Promise<ScrobbleProcessOutcome> {
    const parsed = scrobbleJobSchema.safeParse(job.data);
    if (!parsed.success) {
        const service = SCROBBLE_SERVICES.find(
            (candidate) => candidate === job.data?.service,
        );
        if (service) recordScrobbleOutcome(service, "dropped");
        return "dropped";
    }
    const data = parsed.data;
    try {
        await submitScrobbleJob(data);
        recordScrobbleOutcome(data.service, "submitted");
        return "submitted";
    } catch (error: unknown) {
        if (error instanceof InvalidScrobbleAuthError) {
            await disableInvalidConnection(data, error.encryptedCredential);
            recordScrobbleOutcome(data.service, "invalid_auth");
            return "invalid_auth";
        }
        const maximumAttempts = job.opts.attempts ?? 1;
        if (job.attemptsMade + 1 < maximumAttempts) {
            recordScrobbleOutcome(data.service, "retried");
            throw error;
        }
        recordScrobbleOutcome(data.service, "dropped");
        return "dropped";
    }
}
