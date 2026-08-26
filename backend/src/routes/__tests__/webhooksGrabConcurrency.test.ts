/**
 * F23: a duplicate/concurrent Lidarr Grab webhook races the partial unique
 * index (DownloadJob_targetMbid_active_unique) inside
 * simpleDownloadManager.onDownloadGrabbed. Unlike webhooksRuntime.test.ts,
 * this file does NOT mock simpleDownloadManager -- it exercises the real
 * service (with prisma mocked at the boundary, same shape as
 * simpleDownloadManager.test.ts) through the real POST /lidarr Grab handler,
 * so it can observe the HTTP status code the fix promises: an idempotent
 * 2xx, not the pre-fix uncaught-P2002 500.
 */
const mockScanQueueAdd = jest.fn();
const mockSchedulerQueueAdd = jest.fn();
jest.mock("../../workers/queues", () => ({
    scanQueue: {
        add: (...args: unknown[]) => mockScanQueueAdd(...args),
    },
    schedulerQueue: {
        add: (...args: unknown[]) => mockSchedulerQueueAdd(...args),
    },
}));

jest.mock("axios");

jest.mock("../../utils/logger", () => {
    const mockLogger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
    };
    mockLogger.child.mockReturnValue(mockLogger);
    return { logger: mockLogger };
});

jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/music-default",
        },
        webhooks: {
            lidarrAllowUnauthenticated: true,
        },
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        userDiscoverConfig: {
            findUnique: jest.fn(),
        },
        downloadJob: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            findMany: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
            create: jest.fn(),
            count: jest.fn(),
        },
        $transaction: jest.fn(),
    },
}));

jest.mock("../../services/lidarr", () => {
    class AcquisitionError extends Error {
        public readonly type: string;
        public readonly isRecoverable: boolean;
        constructor(message: string, type: string, isRecoverable = true) {
            super(message);
            this.name = "AcquisitionError";
            this.type = type;
            this.isRecoverable = isRecoverable;
        }
    }
    return {
        AcquisitionError,
        AcquisitionErrorType: {
            NO_RELEASES_AVAILABLE: "NO_RELEASES_AVAILABLE",
            ALBUM_NOT_FOUND: "ALBUM_NOT_FOUND",
            UNKNOWN: "UNKNOWN",
        },
        lidarrService: {
            addAlbum: jest.fn(),
            getArtistAlbums: jest.fn(),
            getReconciliationSnapshot: jest.fn(),
            isAlbumAvailableInSnapshot: jest.fn(),
            isDownloadActiveInSnapshot: jest.fn(),
        },
    };
});

jest.mock("../../utils/async", () => ({
    yieldToEventLoop: jest.fn(async () => undefined),
    chunkArray: jest.fn((items: any[], size: number) => {
        const out: any[][] = [];
        for (let i = 0; i < items.length; i += size) {
            out.push(items.slice(i, i + size));
        }
        return out;
    }),
}));

jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        getReleaseGroup: jest.fn(),
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../services/notificationService", () => ({
    notificationService: {
        notifyDownloadComplete: jest.fn(),
        notifyDownloadFailed: jest.fn(),
    },
}));

jest.mock("../../services/notificationPolicyService", () => ({
    notificationPolicyService: {
        evaluateNotification: jest.fn(),
    },
}));

jest.mock("../../utils/playlistLogger", () => ({
    sessionLog: jest.fn(),
}));

import router from "../webhooks";
import { prisma } from "../../utils/db";
import { getSystemSettings } from "../../utils/systemSettings";

const mockPrisma = prisma as any;
const mockGetSystemSettings = getSystemSettings as jest.Mock;

function getHandler(method: "get" | "post", path: string) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );

    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }

    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
    };
    return res;
}

function makeTx() {
    return {
        downloadJob: {
            findFirst: jest.fn(),
            findMany: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
            create: jest.fn(),
        },
    };
}

function grabRequest(overrides: Record<string, unknown> = {}) {
    return {
        body: {
            eventType: "Grab",
            downloadId: "dl-webhook-race-1",
            albums: [
                {
                    foreignAlbumId: "mbid-webhook-race-1",
                    title: "Album Race",
                    id: 88,
                },
            ],
            artist: { name: "Artist Race" },
            ...overrides,
        },
        headers: {},
    } as any;
}

describe("webhooks Grab route -- real simpleDownloadManager P2002 race (F23)", () => {
    const postLidarr = getHandler("post", "/lidarr");

    beforeEach(() => {
        jest.clearAllMocks();

        mockGetSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr.local",
            lidarrApiKey: "api-key",
            lidarrWebhookSecret: null,
        });

        mockPrisma.downloadJob.findFirst.mockResolvedValue(null);
        mockPrisma.downloadJob.findMany.mockResolvedValue([]);
    });

    it("returns an idempotent 2xx (not 500) for a duplicate Grab webhook that races the partial-unique index", async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");

        const winnerTx = makeTx();
        winnerTx.downloadJob.findFirst
            .mockResolvedValueOnce(null) // idempotency check
            .mockResolvedValueOnce(null) // duplicate check by targetMbid
            .mockResolvedValueOnce({
                id: "recent-artist-job",
                userId: "user-webhook-race-1",
            }); // recentJob (infer userId)
        winnerTx.downloadJob.findMany
            .mockResolvedValueOnce([]) // active unassigned jobs
            .mockResolvedValueOnce([]); // duplicate check by artist+album
        winnerTx.downloadJob.create.mockResolvedValueOnce({
            id: "webhook-winner-job-1",
        });

        const loserTx = makeTx();
        loserTx.downloadJob.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "recent-artist-job",
                userId: "user-webhook-race-1",
            });
        loserTx.downloadJob.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        loserTx.downloadJob.create.mockRejectedValueOnce(
            new Prisma.PrismaClientKnownRequestError(
                "Unique constraint failed on the fields: (`targetMbid`)",
                { code: "P2002", clientVersion: "test" },
            ),
        );

        mockPrisma.$transaction
            .mockImplementationOnce(
                async (operation: (tx: any) => Promise<any>) =>
                    operation(winnerTx),
            )
            .mockImplementationOnce(
                async (operation: (tx: any) => Promise<any>) =>
                    operation(loserTx),
            );
        // The loser's post-abort re-find runs against the plain `prisma`
        // singleton mocked above, not either `tx`.
        mockPrisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "webhook-winner-job-1",
        });

        const firstReq = grabRequest();
        const firstRes = createRes();
        await postLidarr(firstReq, firstRes);

        const secondReq = grabRequest();
        const secondRes = createRes();
        await postLidarr(secondReq, secondRes);

        expect(firstRes.statusCode).toBe(200);
        expect(firstRes.body).toEqual({ success: true });
        expect(secondRes.statusCode).toBe(200);
        expect(secondRes.body).toEqual({ success: true });
        expect(mockSchedulerQueueAdd).toHaveBeenCalledTimes(2);
        expect(mockSchedulerQueueAdd).toHaveBeenNthCalledWith(
            1,
            "download-reconciliation-cycle",
            {
                mode: "repeat",
                source: "lidarr-webhook",
            },
            {
                jobId: "scheduler:reconciliation:on-demand",
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
        expect(mockSchedulerQueueAdd).toHaveBeenNthCalledWith(
            2,
            "download-reconciliation-cycle",
            {
                mode: "repeat",
                source: "lidarr-webhook",
            },
            {
                jobId: "scheduler:reconciliation:on-demand",
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
    });
});
