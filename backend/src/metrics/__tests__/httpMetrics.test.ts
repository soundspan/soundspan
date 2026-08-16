import express from "express";
import { Registry } from "prom-client";
import request from "supertest";
import { createHttpRequestMetrics } from "../httpMetrics";

describe("HTTP request metrics", () => {
    it("records the Express route pattern without the resource id", async () => {
        const registry = new Registry();
        const { middleware } = createHttpRequestMetrics(registry);
        const app = express();
        const apiRouter = express.Router();
        app.use(middleware);
        apiRouter.get("/tracks/:trackId", (_req, res) => {
            res.status(200).json({ ok: true });
        });
        app.use("/api", apiRouter);

        await request(app).get("/api/tracks/abc123").expect(200);

        const exposition = await registry.metrics();
        expect(exposition).toContain('route_class="/api/tracks/:trackId"');
        expect(exposition).not.toContain("abc123");
        expect(exposition).toContain('status_class="2xx"');
    });

    it("collapses route patterns beyond the configured cardinality cap", async () => {
        const registry = new Registry();
        const { middleware } = createHttpRequestMetrics(registry, {
            maxRouteClasses: 1,
        });
        const app = express();
        app.use(middleware);
        app.get("/first/:id", (_req, res) => res.sendStatus(204));
        app.get("/second/:id", (_req, res) => res.sendStatus(204));

        await request(app).get("/first/one").expect(204);
        await request(app).get("/second/two").expect(204);

        const exposition = await registry.metrics();
        expect(exposition).toContain('route_class="/first/:id"');
        expect(exposition).toContain('route_class="other"');
        expect(exposition).not.toContain("one");
        expect(exposition).not.toContain("two");
    });
});
