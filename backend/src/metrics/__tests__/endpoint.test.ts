import express from "express";
import { Gauge, Registry } from "prom-client";
import request from "supertest";
import { createMetricsRouter } from "../endpoint";

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

    it("fails closed when no token is configured", async () => {
        await request(createApp({})).get("/metrics").expect(401);
    });

    it("allows unauthenticated scrapes only when public access is explicit", async () => {
        const response = await request(createApp({ publicAccess: true }))
            .get("/metrics")
            .expect(200);

        expect(response.text).toContain("soundspan_test_known_value 1");
    });
});
