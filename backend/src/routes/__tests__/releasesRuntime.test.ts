// Deliberately does NOT mock ../../middleware/auth: this suite exists to prove
// the router itself enforces requireAuth (roadmap 1.9.0 plan / #59 WS4 item 2,
// "Known auth bugs" #1 in the soundspan-security skill). Mocking requireAuth
// away would make the guard untestable. Only the service boundary (lidarr) and
// prisma.user (requireAuth's own dependency) are mocked.
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
