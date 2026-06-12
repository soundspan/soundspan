import express from "express";
import request from "supertest";

import { createFeatureDisabledHandler, sendFeatureDisabled } from "../featureGate";

describe("createFeatureDisabledHandler", () => {
    const app = express();
    app.use("/api/mixes", createFeatureDisabledHandler());
    app.get("/api/other", (_req, res) => {
        res.json({ ok: true });
    });

    it("returns 404 with FEATURE_DISABLED body at the gated prefix root", async () => {
        const res = await request(app).get("/api/mixes");

        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            error: "feature disabled",
            code: "FEATURE_DISABLED",
        });
    });

    it("returns 404 with FEATURE_DISABLED body for any subpath and method", async () => {
        const getRes = await request(app).get("/api/mixes/mood/happy");
        const postRes = await request(app).post("/api/mixes/refresh");

        expect(getRes.status).toBe(404);
        expect(getRes.body.code).toBe("FEATURE_DISABLED");
        expect(postRes.status).toBe(404);
        expect(postRes.body.code).toBe("FEATURE_DISABLED");
    });

    it("does not affect routes outside the gated prefix", async () => {
        const res = await request(app).get("/api/other");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
    });
});

describe("sendFeatureDisabled", () => {
    it("sends the standard FEATURE_DISABLED 404 payload from an individual handler", async () => {
        const app = express();
        app.post("/api/enrichment/reset-audio-analysis", (_req, res) => {
            sendFeatureDisabled(res);
        });

        const res = await request(app).post(
            "/api/enrichment/reset-audio-analysis"
        );

        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            error: "feature disabled",
            code: "FEATURE_DISABLED",
        });
    });
});
