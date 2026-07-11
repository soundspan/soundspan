// Deliberately does NOT mock ../../middleware/auth: this suite exists to prove
// the router itself enforces requireAuth (roadmap 1.9.0 plan / #59 WS4 item 2,
// "Known auth bugs" #1 in the soundspan-security skill). Mocking requireAuth
// away would make the guard untestable. Only the service boundary (lidarr) and
// prisma.user (requireAuth's own dependency) are mocked.
//
// Because the REAL middleware/auth loads here, its module-scope guard
// (auth.ts:10-14 throws when neither JWT_SECRET nor SESSION_SECRET is set)
// runs at import time — CI's coverage job sets neither, so both must be set
// before any import (house convention: deviceLinkRuntime.test.ts:2-4).
// generateToken signs and requireAuth verifies with JWT_SECRET||SESSION_SECRET,
// making the suite env-independent. SETTINGS_ENCRYPTION_KEY covers the
// apiKeyHash pepper fallback chain should the X-API-Key branch ever be
// exercised here.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-session-secret";
process.env.SETTINGS_ENCRYPTION_KEY =
    process.env.SETTINGS_ENCRYPTION_KEY ||
    "releases-test-encryption-key-32-chars";

import request from "supertest";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const prisma = {
    user: {
        findUnique: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({ prisma }));

jest.mock("../../services/lidarr", () => ({
    lidarrService: {
        getCalendar: jest.fn(),
        getMonitoredArtists: jest.fn(),
    },
}));

import releasesRouter from "../releases";
import { generateToken } from "../../middleware/auth";
import { lidarrService } from "../../services/lidarr";

const mockFindUniqueUser = prisma.user.findUnique as jest.Mock;
const mockGetCalendar = lidarrService.getCalendar as jest.Mock;

describe("releases router auth mount", () => {
    const app = createRouteTestApp("/api/releases", releasesRouter);

    // Real, tokenVersion-matched user + a real JWT (generateToken is the real
    // middleware/auth export) so the authenticated case exercises requireAuth's
    // actual bearer-token branch, not a stand-in.
    const testUser = {
        id: "user-1",
        username: "tester",
        role: "user",
        tokenVersion: 1,
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetCalendar.mockResolvedValue([]);
    });

    it("rejects an anonymous GET /api/releases/upcoming with 401", async () => {
        const res = await request(app).get("/api/releases/upcoming");

        expect(res.status).toBe(401);
        expect(mockGetCalendar).not.toHaveBeenCalled();
    });

    it("lets an authenticated GET /api/releases/upcoming reach the handler", async () => {
        mockFindUniqueUser.mockResolvedValue(testUser);
        const token = generateToken(testUser);

        const res = await request(app)
            .get("/api/releases/upcoming")
            .set("Authorization", `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(mockGetCalendar).toHaveBeenCalledTimes(1);
    });
});
