import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const AUTH_HEADER = "x-test-auth";
const AUTH_VALUE = "ok";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: Request, res: Response, next: NextFunction) => {
        if (req.header(AUTH_HEADER) !== AUTH_VALUE) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        req.user = {
            id: "user-1",
            username: "tester",
            role: "user",
        };
        next();
    },
}));

const mockLoggerError = jest.fn();

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

jest.mock("../../services/featureDetection", () => ({
    featureDetection: {
        getFeatures: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        systemSettings: {
            findUnique: jest.fn(),
        },
    },
}));

import { featureDetection } from "../../services/featureDetection";
import { prisma } from "../../utils/db";
import router from "../system";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/system", router);

describe("system routes integration", () => {
    const mockGetFeatures = featureDetection.getFeatures as jest.Mock;
    const mockSystemSettingsFindUnique =
        prisma.systemSettings.findUnique as unknown as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it.each(["/api/system/features", "/api/system/ui-settings"])(
        "requires auth for GET %s",
        async (path) => {
            const res = await request(app).get(path);

            expect(res.status).toBe(401);
            expect(res.body).toEqual({ error: "Not authenticated" });
        }
    );

    it("GET /api/system/features calls featureDetection.getFeatures and returns result", async () => {
        const features = {
            clapAvailable: true,
            tidalAvailable: false,
            allAvailable: false,
        };
        mockGetFeatures.mockResolvedValueOnce(features);

        const res = await request(app)
            .get("/api/system/features")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual(features);
        expect(mockGetFeatures).toHaveBeenCalledTimes(1);
    });

    it("GET /api/system/features handles errors gracefully", async () => {
        const error = new Error("probe failed");
        mockGetFeatures.mockRejectedValueOnce(error);

        const res = await request(app)
            .get("/api/system/features")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: "Failed to detect features" });
        expect(mockLoggerError).toHaveBeenCalledWith("Feature detection error:", error);
    });

    it("GET /api/system/ui-settings returns showVersion from system settings", async () => {
        mockSystemSettingsFindUnique.mockResolvedValueOnce({ showVersion: true });

        const res = await request(app)
            .get("/api/system/ui-settings")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ showVersion: true });
        expect(mockSystemSettingsFindUnique).toHaveBeenCalledWith({
            where: { id: "default" },
            select: { showVersion: true },
        });
    });

    it("GET /api/system/ui-settings returns false as default when no settings exist", async () => {
        mockSystemSettingsFindUnique.mockResolvedValueOnce(null);

        const res = await request(app)
            .get("/api/system/ui-settings")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ showVersion: false });
    });

    it("GET /api/system/ui-settings handles database errors gracefully", async () => {
        const error = new Error("database unavailable");
        mockSystemSettingsFindUnique.mockRejectedValueOnce(error);

        const res = await request(app)
            .get("/api/system/ui-settings")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get UI settings" });
        expect(mockLoggerError).toHaveBeenCalledWith("UI settings error:", error);
    });
});
