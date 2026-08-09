/**
 * Authorization contract for the Lidarr webhook (POST /api/webhooks/lidarr).
 *
 * The webhook must FAIL CLOSED: when no webhook secret is configured in
 * system settings, requests are rejected with 401 unless the operator has
 * explicitly opted back into the legacy unauthenticated behavior via
 * LIDARR_WEBHOOK_ALLOW_UNAUTHENTICATED=true (read through config.ts as
 * `config.webhooks.lidarrAllowUnauthenticated`).
 */

export {};

const mockScanQueueAdd = jest.fn(async () => undefined);
const mockOnDownloadGrabbed = jest.fn(async () => ({ matched: false }));
const mockOnDownloadComplete = jest.fn(async () => ({ jobId: null }));
const mockOnImportFailed = jest.fn(async () => undefined);
const mockGetSystemSettings = jest.fn();

const mockConfig = {
    webhooks: {
        lidarrAllowUnauthenticated: false,
    },
};

jest.mock("../workers/queues", () => ({
    scanQueue: { add: mockScanQueueAdd },
}));

jest.mock("../services/simpleDownloadManager", () => ({
    simpleDownloadManager: {
        onDownloadGrabbed: mockOnDownloadGrabbed,
        onDownloadComplete: mockOnDownloadComplete,
        onImportFailed: mockOnImportFailed,
    },
}));

jest.mock("../jobs/queueCleaner", () => ({
    queueCleaner: { start: jest.fn() },
}));

jest.mock("../utils/systemSettings", () => ({
    getSystemSettings: mockGetSystemSettings,
}));

jest.mock("../middleware/rateLimiter", () => ({
    webhookLimiter: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../utils/db", () => ({
    prisma: {
        downloadJob: {
            findUnique: jest.fn(async () => null),
        },
    },
}));

jest.mock("../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../config", () => ({
    config: mockConfig,
}));

import express from "express";
import request from "supertest";
import webhooksRouter from "../routes/webhooks";

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/webhooks", webhooksRouter);
    return app;
}

const lidarrEnabledSettings = {
    lidarrEnabled: true,
    lidarrUrl: "http://lidarr:8686",
    lidarrApiKey: "lidarr-api-key",
    lidarrWebhookSecret: null as string | null,
};

describe("POST /api/webhooks/lidarr authorization", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockConfig.webhooks.lidarrAllowUnauthenticated = false;
    });

    it("rejects with 401 when no webhook secret is configured (fail closed)", async () => {
        mockGetSystemSettings.mockResolvedValue({ ...lidarrEnabledSettings });

        const response = await request(buildApp())
            .post("/api/webhooks/lidarr")
            .send({ eventType: "Test" });

        expect(response.status).toBe(401);
        expect(mockOnDownloadGrabbed).not.toHaveBeenCalled();
        expect(mockOnDownloadComplete).not.toHaveBeenCalled();
        expect(mockScanQueueAdd).not.toHaveBeenCalled();
    });

    it("accepts unauthenticated webhooks when the operator opts out via config", async () => {
        mockConfig.webhooks.lidarrAllowUnauthenticated = true;
        mockGetSystemSettings.mockResolvedValue({ ...lidarrEnabledSettings });

        const response = await request(buildApp())
            .post("/api/webhooks/lidarr")
            .send({ eventType: "Test" });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true });
    });

    it("rejects with 401 when a configured secret is missing or wrong", async () => {
        mockGetSystemSettings.mockResolvedValue({
            ...lidarrEnabledSettings,
            lidarrWebhookSecret: "expected-secret",
        });

        const missing = await request(buildApp())
            .post("/api/webhooks/lidarr")
            .send({ eventType: "Test" });
        expect(missing.status).toBe(401);

        const wrong = await request(buildApp())
            .post("/api/webhooks/lidarr")
            .set("x-webhook-secret", "wrong-secret")
            .send({ eventType: "Test" });
        expect(wrong.status).toBe(401);
    });

    it("accepts webhooks carrying the configured secret", async () => {
        mockGetSystemSettings.mockResolvedValue({
            ...lidarrEnabledSettings,
            lidarrWebhookSecret: "expected-secret",
        });

        const response = await request(buildApp())
            .post("/api/webhooks/lidarr")
            .set("x-webhook-secret", "expected-secret")
            .send({ eventType: "Test" });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true });
    });

    it("still short-circuits with 202 when Lidarr is disabled", async () => {
        mockGetSystemSettings.mockResolvedValue({
            lidarrEnabled: false,
        });

        const response = await request(buildApp())
            .post("/api/webhooks/lidarr")
            .send({ eventType: "Test" });

        expect(response.status).toBe(202);
        expect(response.body).toMatchObject({ ignored: true });
    });
});
