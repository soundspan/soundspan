const federationQueue = {
    add: jest.fn(),
    process: jest.fn(),
    isReady: jest.fn(),
};
const prisma = {
    federationPeer: { findMany: jest.fn() },
};
const processFederationSync = jest.fn();
const processFederationHealth = jest.fn();

jest.mock("../queues", () => ({ federationQueue }));
jest.mock("../../utils/db", () => ({ prisma }));
jest.mock("../../config", () => ({
    config: { workers: { federationSyncIntervalMinutes: 7 } },
}));
jest.mock("../processors/federationSyncProcessor", () => ({
    processFederationSync,
}));
jest.mock("../processors/federationHealthProcessor", () => ({
    processFederationHealth,
}));

import {
    enqueueFederationSyncNow,
    FEDERATION_HEALTH_JOB_NAME,
    FEDERATION_SYNC_JOB_NAME,
    FEDERATION_SYNC_TICK_JOB_NAME,
    registerFederationProcessors,
    registerFederationSchedules,
} from "../federationJobs";

describe("federation queue registration", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        federationQueue.isReady.mockResolvedValue(undefined);
        federationQueue.add.mockResolvedValue({ id: "job-1" });
        prisma.federationPeer.findMany.mockResolvedValue([
            { id: "peer-1" },
            { id: "peer-2" },
        ]);
    });

    it("registers bounded sync, health, and tick processors", () => {
        registerFederationProcessors();

        expect(federationQueue.process).toHaveBeenCalledWith(
            FEDERATION_SYNC_JOB_NAME,
            2,
            processFederationSync,
        );
        expect(federationQueue.process).toHaveBeenCalledWith(
            FEDERATION_HEALTH_JOB_NAME,
            1,
            expect.any(Function),
        );
        expect(federationQueue.process).toHaveBeenCalledWith(
            FEDERATION_SYNC_TICK_JOB_NAME,
            1,
            expect.any(Function),
        );
    });

    it("registers startup plus hourly health and configured sync repeats", async () => {
        await registerFederationSchedules();

        expect(federationQueue.add).toHaveBeenCalledWith(
            FEDERATION_HEALTH_JOB_NAME,
            {},
            expect.objectContaining({ repeat: { every: 3_600_000 } }),
        );
        expect(federationQueue.add).toHaveBeenCalledWith(
            FEDERATION_SYNC_TICK_JOB_NAME,
            {},
            expect.objectContaining({ repeat: { every: 420_000 } }),
        );
    });

    it("coalesces immediate and scheduled work by deterministic peer id", async () => {
        await enqueueFederationSyncNow("peer-1");
        registerFederationProcessors();
        const tick = federationQueue.process.mock.calls.find(
            (call) => call[0] === FEDERATION_SYNC_TICK_JOB_NAME,
        )?.[2];
        await tick({});

        expect(federationQueue.add).toHaveBeenCalledWith(
            FEDERATION_SYNC_JOB_NAME,
            { peerId: "peer-1" },
            expect.objectContaining({ jobId: "federation-sync:peer-1" }),
        );
        expect(federationQueue.add).toHaveBeenCalledWith(
            FEDERATION_SYNC_JOB_NAME,
            { peerId: "peer-2" },
            expect.objectContaining({ jobId: "federation-sync:peer-2" }),
        );
    });
});
