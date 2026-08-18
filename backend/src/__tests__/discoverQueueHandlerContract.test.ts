const discoverQueue = {
    getJob: jest.fn(),
    add: jest.fn(),
};

const prisma = {
    userDiscoverConfig: {
        findMany: jest.fn(),
    },
};

jest.mock("../workers/queues", () => ({ discoverQueue }));
jest.mock("../utils/db", () => ({ prisma }));
jest.mock("../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));
jest.mock("../config", () => ({
    config: { discover: { mode: "recommendation" } },
}));

import { handleModernGenerate } from "../routes/discover/generation";
import { processDiscoverCronTick } from "../workers/discoverCron";

function createResponse() {
    const response: any = {
        body: undefined as unknown,
        status: jest.fn(() => response),
        json: jest.fn((body: unknown) => {
            response.body = body;
            return response;
        }),
    };
    return response;
}

describe("discover queue handler contract", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("enqueues recommendation-mode manual jobs with a deterministic id", async () => {
        discoverQueue.getJob.mockResolvedValueOnce(null);
        discoverQueue.add.mockResolvedValueOnce({ id: "job-1" });
        const response = createResponse();

        await handleModernGenerate({ user: { id: "user-1" } } as any, response);

        expect(discoverQueue.add).toHaveBeenCalledWith(
            "discover-recommendation",
            { userId: "user-1" },
            { jobId: "discover:manual:user-1" },
        );
        expect(response.body).toEqual({
            message: "Discover Weekly recommendation generation started",
            jobId: "job-1",
        });
    });

    it("enqueues cron jobs through the recommendation processor name", async () => {
        jest.useFakeTimers().setSystemTime(
            new Date("2026-08-17T12:00:00.000Z"),
        );
        prisma.userDiscoverConfig.findMany.mockResolvedValueOnce([
            { userId: "user-1", playlistSize: 25 },
        ]);
        discoverQueue.add.mockResolvedValueOnce(undefined);

        await processDiscoverCronTick();

        expect(discoverQueue.add).toHaveBeenCalledWith(
            "discover-recommendation",
            { userId: "user-1" },
            { jobId: "discover:cron:2026-08-17:user-1" },
        );
    });
});
