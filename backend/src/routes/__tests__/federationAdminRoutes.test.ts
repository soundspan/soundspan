import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const service = {
    createHostFederationPeer: jest.fn(),
    listFederationPeers: jest.fn(),
    rotateFederationPeerCredential: jest.fn(),
    revokeFederationPeer: jest.fn(),
    deleteFederationPeer: jest.fn(),
    linkConsumerFederationPeer: jest.fn(),
    updateFederationPeerSettings: jest.fn(),
};
const dedupService = {
    listFederationPeerDedup: jest.fn(),
    arbitrateFederationTrackDedup: jest.fn(),
};

const enqueueFederationSyncNow = jest.fn();
const listFederationPeerHealth = jest.fn();

jest.mock("../../services/federationPeers", () => ({
    ...service,
    FederationPeerConflictError: class FederationPeerConflictError extends Error {},
    FEDERATION_SCOPE_VALUES: [
        "library:read",
        "stream:read",
        "embeddings:read",
        "social:read",
    ],
}));
jest.mock("../../workers/federationJobs", () => ({
    enqueueFederationSyncNow,
}));
jest.mock("../../services/federationDedupArbitration", () => dedupService);
jest.mock("../../services/federationPeerHealth", () => ({
    listFederationPeerHealth,
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
        service.linkConsumerFederationPeer.mockResolvedValue({
            id: "consumer-peer-1",
            name: "Remote Library",
        });
        service.updateFederationPeerSettings.mockResolvedValue({
            id: "peer-1",
            showDedupedCopies: true,
            maxConcurrentStreams: 4,
            maxStreamKbps: 320,
        });
        dedupService.listFederationPeerDedup.mockResolvedValue({
            items: [],
            nextCursor: null,
        });
        dedupService.arbitrateFederationTrackDedup.mockResolvedValue({
            federatedTrack: { id: "fed-track-1" },
            localTrack: { id: "local-track-1" },
            tier: "audioHash",
            confidence: 1,
            pinned: true,
        });
        enqueueFederationSyncNow.mockResolvedValue(undefined);
        listFederationPeerHealth.mockResolvedValue([]);
    });

    it("requires administrator authentication for management", async () => {
        const response = await request(app).get("/api/federation/admin/peers");
        expect(response.status).toBe(401);
        expect(service.listFederationPeers).not.toHaveBeenCalled();
    });

    it.each([
        ["/pairing-codes", {}],
        [
            "/peers/link/pair",
            {
                baseUrl: "https://peer.example",
                code: "ABCDEFGH",
                name: "Peer",
            },
        ],
    ])(
        "returns 404 for removed admin pairing endpoint %s",
        async (path, body) => {
            const response = await request(app)
                .post(`/api/federation/admin${path}`)
                .set("Authorization", "Bearer admin")
                .send(body);

            expect(response.status).toBe(404);
        },
    );

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

    it("uses the approved default scopes when host scopes are omitted", async () => {
        const response = await request(app)
            .post("/api/federation/admin/peers")
            .set("Authorization", "Bearer admin")
            .send({ name: "Default Peer" });

        expect(response.status).toBe(201);
        expect(service.createHostFederationPeer).toHaveBeenCalledWith({
            name: "Default Peer",
            scopes: ["library:read", "stream:read", "social:read"],
            createdById: "admin-1",
            baseUrl: undefined,
        });
    });

    it("accepts social presence with its library dependency", async () => {
        const response = await request(app)
            .post("/api/federation/admin/peers")
            .set("Authorization", "Bearer admin")
            .send({
                name: "Social Peer",
                scopes: ["library:read", "social:read"],
            });

        expect(response.status).toBe(201);
        expect(service.createHostFederationPeer).toHaveBeenCalledWith({
            name: "Social Peer",
            scopes: ["library:read", "social:read"],
            createdById: "admin-1",
            baseUrl: undefined,
        });
    });

    it("rejects unknown, duplicate, and dependency-invalid scopes", async () => {
        for (const scopes of [
            ["unknown"],
            ["library:read", "library:read"],
            ["embeddings:read"],
            ["social:read"],
        ]) {
            const response = await request(app)
                .post("/api/federation/admin/peers")
                .set("Authorization", "Bearer admin")
                .send({ name: "Peer", scopes });
            expect(response.status).toBe(400);
        }
        expect(service.createHostFederationPeer).not.toHaveBeenCalled();
    });

    it.each([
        [
            "/peers",
            {
                direction: "BOTH",
                name: "Peer",
                scopes: ["library:read"],
                baseUrl: "https://peer.example",
                token: "peer-token",
            },
        ],
        [
            "/peers/link",
            {
                direction: "BOTH",
                baseUrl: "https://peer.example",
                token: "peer-token",
                scopes: ["library:read"],
            },
        ],
    ])("rejects removed BOTH input on %s", async (path, body) => {
        const response = await request(app)
            .post(`/api/federation/admin${path}`)
            .set("Authorization", "Bearer admin")
            .send(body);

        expect(response.status).toBe(400);
        expect(service.createHostFederationPeer).not.toHaveBeenCalled();
        expect(service.linkConsumerFederationPeer).not.toHaveBeenCalled();
    });

    it("lists peers without credential material", async () => {
        service.listFederationPeers.mockResolvedValueOnce([
            {
                id: "peer-1",
                name: "Peer",
                inboundStatus: "ACTIVE",
                outboundStatus: "OFFLINE",
            },
        ]);
        const response = await request(app)
            .get("/api/federation/admin/peers")
            .set("Authorization", "Bearer admin");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            peers: [
                {
                    id: "peer-1",
                    name: "Peer",
                    inboundStatus: "ACTIVE",
                    outboundStatus: "OFFLINE",
                },
            ],
        });
        expect(JSON.stringify(response.body)).not.toContain("credentialHash");
    });

    it("returns the administrator-only peer health read model", async () => {
        listFederationPeerHealth.mockResolvedValueOnce([
            {
                id: "peer-1",
                name: "Remote Library",
                health: "amber",
                syncLagSeconds: 7_200,
                catalog: { track: 42 },
                activeStreamLeases: 1,
                maxConcurrentStreams: 2,
            },
        ]);

        const unauthenticated = await request(app).get(
            "/api/federation/admin/peers/health",
        );
        const response = await request(app)
            .get("/api/federation/admin/peers/health")
            .set("Authorization", "Bearer admin");

        expect(unauthenticated.status).toBe(401);
        expect(response.status).toBe(200);
        expect(response.body.peers[0]).toEqual(
            expect.objectContaining({ id: "peer-1", health: "amber" }),
        );
        expect(listFederationPeerHealth).toHaveBeenCalledTimes(1);
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

    it("links a consumer peer only after its manifest validates", async () => {
        const response = await request(app)
            .post("/api/federation/admin/peers/link")
            .set("Authorization", "Bearer admin")
            .send({
                baseUrl: "https://peer.example/",
                token: "peer-token",
                name: "Remote Library",
            });

        expect(response.status).toBe(201);
        expect(response.body).toEqual({
            peer: { id: "consumer-peer-1", name: "Remote Library" },
        });
        expect(service.linkConsumerFederationPeer).toHaveBeenCalledWith({
            baseUrl: "https://peer.example/",
            token: "peer-token",
            name: "Remote Library",
            createdById: "admin-1",
        });
    });

    it("returns a typed 502 without persisting malformed peer data", async () => {
        service.linkConsumerFederationPeer.mockRejectedValueOnce(
            new Error("malformed response with secret peer-token"),
        );

        const response = await request(app)
            .post("/api/federation/admin/peers/link")
            .set("Authorization", "Bearer admin")
            .send({
                baseUrl: "https://peer.example",
                token: "peer-token",
            });

        expect(response.status).toBe(502);
        expect(response.body).toEqual({
            error: "Federation peer response is invalid",
            code: "FEDERATION_PEER_INVALID",
        });
        expect(JSON.stringify(response.body)).not.toContain("peer-token");
    });

    it("returns a typed 409 for a duplicate consumer peer URL", async () => {
        const { FederationPeerConflictError } = jest.requireMock(
            "../../services/federationPeers",
        );
        service.linkConsumerFederationPeer.mockRejectedValueOnce(
            new FederationPeerConflictError(),
        );

        const response = await request(app)
            .post("/api/federation/admin/peers/link")
            .set("Authorization", "Bearer admin")
            .send({ baseUrl: "https://peer.example", token: "peer-token" });

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            error: "Federation consumer peer already exists",
            code: "FEDERATION_PEER_CONFLICT",
        });
    });

    it.each([
        [
            "unreachable",
            { isAxiosError: true, code: "ECONNREFUSED" },
            502,
            "FEDERATION_PEER_UNREACHABLE",
        ],
        [
            "tls",
            { isAxiosError: true, code: "CERT_HAS_EXPIRED" },
            502,
            "FEDERATION_PEER_TLS",
        ],
        [
            "unauthorized",
            { isAxiosError: true, response: { status: 401 } },
            502,
            "FEDERATION_PEER_UNAUTHORIZED",
        ],
        [
            "peer invalid",
            {
                isAxiosError: true,
                response: { status: 400, data: { error: "Invalid" } },
            },
            502,
            "FEDERATION_PEER_INVALID",
        ],
    ])(
        "maps %s outbound failures on the credential link route",
        async (_label, shape, status, code) => {
            service.linkConsumerFederationPeer.mockRejectedValueOnce(
                Object.assign(new Error("outbound failure"), shape),
            );
            const response = await request(app)
                .post("/api/federation/admin/peers/link")
                .set("Authorization", "Bearer admin")
                .send({
                    baseUrl: "https://peer.example",
                    token: "peer-token",
                });

            expect(response.status).toBe(status);
            expect(response.body.code).toBe(code);
        },
    );

    it("enqueues a bounded per-peer sync now job", async () => {
        const response = await request(app)
            .post("/api/federation/admin/peers/peer-1/sync")
            .set("Authorization", "Bearer admin");

        expect(response.status).toBe(202);
        expect(response.body).toEqual({ queued: true });
        expect(enqueueFederationSyncNow).toHaveBeenCalledWith("peer-1");
    });

    it("patches bounded peer settings and accepts explicit null caps", async () => {
        const response = await request(app)
            .patch("/api/federation/admin/peers/peer-1/settings")
            .set("Authorization", "Bearer admin")
            .send({
                showDedupedCopies: true,
                maxConcurrentStreams: null,
                maxStreamKbps: 320,
            });

        expect(response.status).toBe(200);
        expect(service.updateFederationPeerSettings).toHaveBeenCalledWith(
            "peer-1",
            {
                showDedupedCopies: true,
                maxConcurrentStreams: null,
                maxStreamKbps: 320,
            },
        );
        expect(response.body).toEqual(
            expect.objectContaining({ id: "peer-1", showDedupedCopies: true }),
        );
    });

    it.each([
        { maxConcurrentStreams: 0 },
        { maxConcurrentStreams: 65 },
        { maxStreamKbps: 63 },
        { maxStreamKbps: 100_001 },
        { showDedupedCopies: "yes" },
        { maxConcurrentStreams: 2, unexpected: true },
    ])("rejects invalid peer settings %#", async (body) => {
        const response = await request(app)
            .patch("/api/federation/admin/peers/peer-1/settings")
            .set("Authorization", "Bearer admin")
            .send(body);

        expect(response.status).toBe(400);
    });

    it("keyset-pages dedup arbitration rows for one peer", async () => {
        dedupService.listFederationPeerDedup.mockResolvedValueOnce({
            items: [{ federatedTrack: { id: "fed-track-2" }, pinned: false }],
            nextCursor: "fed-track-2",
        });
        const response = await request(app)
            .get(
                "/api/federation/admin/peers/peer-1/dedup?cursor=fed-track-1&limit=25",
            )
            .set("Authorization", "Bearer admin");

        expect(response.status).toBe(200);
        expect(dedupService.listFederationPeerDedup).toHaveBeenCalledWith({
            peerId: "peer-1",
            cursor: "fed-track-1",
            limit: 25,
        });
        expect(response.body.nextCursor).toBe("fed-track-2");
    });

    it.each([
        [{ action: "link", localTrackId: "local-track-1" }],
        [{ action: "unlink" }],
        [{ action: "reset" }],
    ])("applies a validated dedup arbitration action %#", async (body) => {
        const response = await request(app)
            .post("/api/federation/admin/tracks/fed-track-1/dedup")
            .set("Authorization", "Bearer admin")
            .send(body);

        expect(response.status).toBe(200);
        expect(dedupService.arbitrateFederationTrackDedup).toHaveBeenCalledWith(
            "fed-track-1",
            body,
        );
    });

    it("uses uniform not-found responses for hidden dedup resources", async () => {
        service.updateFederationPeerSettings.mockResolvedValueOnce(null);
        dedupService.listFederationPeerDedup.mockResolvedValueOnce(null);
        dedupService.arbitrateFederationTrackDedup.mockResolvedValueOnce(null);

        const settings = await request(app)
            .patch("/api/federation/admin/peers/missing/settings")
            .set("Authorization", "Bearer admin")
            .send({ showDedupedCopies: true });
        const list = await request(app)
            .get("/api/federation/admin/peers/missing/dedup")
            .set("Authorization", "Bearer admin");
        const action = await request(app)
            .post("/api/federation/admin/tracks/missing/dedup")
            .set("Authorization", "Bearer admin")
            .send({ action: "link", localTrackId: "also-missing" });

        expect(settings.body).toEqual({ error: "Federation peer not found" });
        expect(list.body).toEqual({ error: "Federation peer not found" });
        expect(action.body).toEqual({
            error: "Federation dedup resource not found",
        });
    });
});
