import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const service = {
    createHostFederationPeer: jest.fn(),
    listFederationPeers: jest.fn(),
    rotateFederationPeerCredential: jest.fn(),
    revokeFederationPeer: jest.fn(),
    deleteFederationPeer: jest.fn(),
    createFederationPairingCode: jest.fn(),
};

jest.mock("../../services/federationPeers", () => ({
    ...service,
    FEDERATION_SCOPE_VALUES: ["library:read", "stream:read", "embeddings:read"],
}));
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: Request, res: Response, next: NextFunction) => {
        if (req.headers.authorization !== "Bearer admin") {
            return res.status(401).json({ error: "Not authenticated" });
        }
        req.user = { id: "admin-1", username: "admin", role: "admin" };
        next();
    },
    requireAdmin: (req: Request, res: Response, next: NextFunction) => {
        if (req.user?.role !== "admin")
            return res.status(403).json({ error: "Admin access required" });
        next();
    },
}));

import router from "../federationAdmin";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/federation/admin", router);

describe("federation admin routes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        service.listFederationPeers.mockResolvedValue([]);
        service.createHostFederationPeer.mockResolvedValue({
            peer: { id: "peer-1" },
            token: "token-once",
        });
        service.rotateFederationPeerCredential.mockResolvedValue({
            peer: { id: "peer-1" },
            token: "rotated-once",
        });
        service.revokeFederationPeer.mockResolvedValue(true);
        service.deleteFederationPeer.mockResolvedValue(true);
        service.createFederationPairingCode.mockResolvedValue({
            code: "ABCDEFGH",
            expiresAt: new Date("2026-08-15T12:05:00.000Z"),
        });
    });

    it("requires administrator authentication for management", async () => {
        const response = await request(app).get("/api/federation/admin/peers");
        expect(response.status).toBe(401);
        expect(service.listFederationPeers).not.toHaveBeenCalled();
    });

    it("creates a host credential and returns the token once", async () => {
        const response = await request(app)
            .post("/api/federation/admin/peers")
            .set("Authorization", "Bearer admin")
            .send({
                name: "Peer One",
                scopes: ["library:read", "stream:read"],
            });

        expect(response.status).toBe(201);
        expect(response.body).toEqual({
            peer: { id: "peer-1" },
            token: "token-once",
        });
        expect(service.createHostFederationPeer).toHaveBeenCalledWith({
            name: "Peer One",
            scopes: ["library:read", "stream:read"],
            createdById: "admin-1",
            baseUrl: undefined,
        });
    });

    it("rejects unknown, duplicate, and dependency-invalid scopes", async () => {
        for (const scopes of [
            ["unknown"],
            ["library:read", "library:read"],
            ["embeddings:read"],
        ]) {
            const response = await request(app)
                .post("/api/federation/admin/peers")
                .set("Authorization", "Bearer admin")
                .send({ name: "Peer", scopes });
            expect(response.status).toBe(400);
        }
        expect(service.createHostFederationPeer).not.toHaveBeenCalled();
    });

    it("lists peers without credential material", async () => {
        service.listFederationPeers.mockResolvedValueOnce([
            { id: "peer-1", name: "Peer" },
        ]);
        const response = await request(app)
            .get("/api/federation/admin/peers")
            .set("Authorization", "Bearer admin");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            peers: [{ id: "peer-1", name: "Peer" }],
        });
        expect(JSON.stringify(response.body)).not.toContain("credentialHash");
    });

    it("rotates, revokes, and deletes peers with uniform missing responses", async () => {
        const rotate = await request(app)
            .post("/api/federation/admin/peers/peer-1/rotate")
            .set("Authorization", "Bearer admin");
        expect(rotate.body.token).toBe("rotated-once");

        const revoke = await request(app)
            .post("/api/federation/admin/peers/peer-1/revoke")
            .set("Authorization", "Bearer admin");
        expect(revoke.status).toBe(200);

        const remove = await request(app)
            .delete("/api/federation/admin/peers/peer-1")
            .set("Authorization", "Bearer admin");
        expect(remove.status).toBe(204);

        service.rotateFederationPeerCredential.mockResolvedValueOnce(null);
        const missing = await request(app)
            .post("/api/federation/admin/peers/missing/rotate")
            .set("Authorization", "Bearer admin");
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ error: "Federation peer not found" });
    });

    it("creates a pairing code with approved default scopes", async () => {
        const response = await request(app)
            .post("/api/federation/admin/pairing-codes")
            .set("Authorization", "Bearer admin")
            .send({});

        expect(response.status).toBe(201);
        expect(service.createFederationPairingCode).toHaveBeenCalledWith({
            createdById: "admin-1",
            scopes: ["library:read", "stream:read"],
        });
        expect(response.body.code).toBe("ABCDEFGH");
    });
});
