import express from "express";
import { Gauge, Registry } from "prom-client";
import request from "supertest";
import { createMetricsRouter } from "../endpoint";
import { createVibeEmbedMetrics } from "../vibeEmbedMetrics";

jest.mock("../../middleware/rateLimitStore", () => ({
    createRedisRateLimitOptions: jest.fn(() => ({})),
}));

describe("metrics endpoint", () => {
    function createApp(options: { token?: string; publicAccess?: boolean }) {
        const registry = new Registry();
        const knownGauge = new Gauge({
            name: "soundspan_test_known_value",
            help: "Known test value.",
            registers: [registry],
        });
        knownGauge.set(1);

        const app = express();
        app.use(
            createMetricsRouter({
                registry,
                token: options.token,
                publicAccess: options.publicAccess ?? false,
            }),
        );
        return app;
    }

    it("returns 401 when a private endpoint has no credential", async () => {
        const response = await request(createApp({ token: "scrape-token" }))
            .get("/metrics")
            .expect(401);

        expect(response.headers["www-authenticate"]).toBe(
            'Bearer realm="metrics"',
        );
    });

    it("returns Prometheus text with a valid bearer credential", async () => {
        const response = await request(createApp({ token: "scrape-token" }))
            .get("/metrics")
            .set("Authorization", "Bearer scrape-token")
            .expect(200);

        expect(response.headers["content-type"]).toContain("text/plain");
        expect(response.text).toContain("soundspan_test_known_value 1");
    });

    it("rate-limits failed access attempts without blocking authorized scrapes", async () => {
        const app = createApp({ token: "scrape-token" });

        await request(app)
            .get("/metrics")
            .set("Authorization", "Bearer scrape-token")
            .expect(200);

        const failedAttempts = await Promise.all(
            Array.from({ length: 120 }, () =>
                request(app)
                    .get("/metrics")
                    .set("Authorization", "Bearer wrong-token"),
            ),
        );
        expect(failedAttempts).toHaveLength(120);
        expect(failedAttempts.every(({ status }) => status === 401)).toBe(true);

        await request(app)
            .get("/metrics")
            .set("Authorization", "Bearer wrong-token")
            .expect(429);
    });

    it("fails closed when no token is configured", async () => {
        await request(createApp({})).get("/metrics").expect(401);
    });

    it("allows unauthenticated scrapes only when public access is explicit", async () => {
        const response = await request(createApp({ publicAccess: true }))
            .get("/metrics")
            .expect(200);

        expect(response.text).toContain("soundspan_test_known_value 1");
    });

    it("returns 200 when the vibe queue collector cannot reach Redis", async () => {
        const registry = new Registry();
        createVibeEmbedMetrics(registry, {
            getProviderQueueDepth: async () => {
                throw new Error("redis unavailable");
            },
            getProviderStatusFresh: async () => false,
        });
        const router = createMetricsRouter({
            registry,
            publicAccess: true,
        });
        const route = (router as any).stack.find(
            (entry: any) => entry.route?.path === "/metrics",
        ).route;
        const response = {
            body: "",
            statusCode: 200,
            set: jest.fn(),
            send: jest.fn(function (body: string) {
                response.body = body;
            }),
        } as any;
        let authorized = false;
        route.stack[1].handle(
            { get: jest.fn() },
            response,
            () => (authorized = true),
        );
        expect(authorized).toBe(true);
        await route.stack[2].handle({}, response, jest.fn());

        expect(response.send).toHaveBeenCalledTimes(1);
        expect(response.statusCode).toBe(200);
        const nextResponse = {
            body: "",
            statusCode: 200,
            set: jest.fn(),
            send: jest.fn(function (body: string) {
                nextResponse.body = body;
            }),
        } as any;
        await route.stack[2].handle({}, nextResponse, jest.fn());

        expect(nextResponse.statusCode).toBe(200);
        expect(nextResponse.body).toMatch(
            /soundspan_metrics_collection_errors_total\{collector="vibe_queue_depth"\} [1-9][0-9]*/,
        );
    });
});
