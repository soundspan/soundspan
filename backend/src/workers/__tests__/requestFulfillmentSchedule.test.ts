import {
    REQUEST_FULFILLMENT_INTERVAL_MS,
    requestFulfillmentRepeatSchedule,
} from "../requestFulfillmentSchedule";

describe("request fulfillment schedule", () => {
    it("registers one stable five-minute repeat tick", () => {
        expect(REQUEST_FULFILLMENT_INTERVAL_MS).toBe(5 * 60 * 1000);
        expect(requestFulfillmentRepeatSchedule).toEqual({
            type: "request-fulfillment-reconcile",
            data: { mode: "repeat" },
            opts: {
                jobId: "scheduler:request-fulfillment:repeat",
                repeat: { every: 5 * 60 * 1000 },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        });
    });
});
