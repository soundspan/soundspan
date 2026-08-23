import type Bull from "bull";

/** Named Bull scheduler job for request fulfillment reconciliation. */
export const REQUEST_FULFILLMENT_JOB_NAME = "request-fulfillment-reconcile";
/** Stable repeat-job identifier used for registration and removal. */
export const REQUEST_FULFILLMENT_JOB_ID =
    "scheduler:request-fulfillment:repeat";
/** Five-minute reconciliation cadence. */
export const REQUEST_FULFILLMENT_INTERVAL_MS = 5 * 60 * 1000;

/** Repeatable Bull registration for request fulfillment reconciliation. */
export const requestFulfillmentRepeatSchedule: {
    type: typeof REQUEST_FULFILLMENT_JOB_NAME;
    data: { mode: "repeat" };
    opts: Bull.JobOptions;
} = {
    type: REQUEST_FULFILLMENT_JOB_NAME,
    data: { mode: "repeat" },
    opts: {
        jobId: REQUEST_FULFILLMENT_JOB_ID,
        repeat: { every: REQUEST_FULFILLMENT_INTERVAL_MS },
        removeOnComplete: true,
        removeOnFail: 10,
    },
};
