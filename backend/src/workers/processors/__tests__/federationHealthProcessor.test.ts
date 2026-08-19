const getManifest = jest.fn();
const createFederationClient = jest.fn(() => ({ getManifest }));
const prisma = {
    federationPeer: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
    },
};
const log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
log.child.mockReturnValue(log);

jest.mock("../../../utils/db", () => ({ prisma }));
jest.mock("../../../utils/logger", () => ({ logger: log }));
jest.mock("../../../services/federationClient", () => ({
    createFederationClient,
}));
jest.mock("../../../config", () => ({
    config: { federation: { allowPrivatePeers: false } },
}));

import { processFederationHealth } from "../federationHealthProcessor";

const peer = {
    id: "peer-1",
    baseUrl: "https://peer.example",
    outboundToken: "v2:encrypted-token",
    direction: "CONSUMER",
    inboundStatus: null,
    outboundStatus: "ACTIVE",
};

describe("federation peer health processor", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.federationPeer.findMany.mockResolvedValue([{ ...peer }]);
        prisma.federationPeer.updateMany.mockResolvedValue({ count: 1 });
        getManifest.mockResolvedValue({
            catalogEpoch: "epoch-1",
            capabilities: ["track-attrs-loudness"],
        });
    });

    it("marks successful peers active and refreshes lastSeenAt", async () => {
        await expect(processFederationHealth()).resolves.toEqual({
            checked: 1,
            online: 1,
            offline: 0,
        });
        expect(prisma.federationPeer.updateMany).toHaveBeenCalledWith({
            where: { id: "peer-1", outboundStatus: { not: "REVOKED" } },
            data: {
                outboundStatus: "ACTIVE",
                lastSeenAt: expect.any(Date),
                capabilities: ["track-attrs-loudness"],
            },
        });
        expect(log.info).not.toHaveBeenCalled();
    });

    it("marks a failed peer offline and logs only the transition", async () => {
        getManifest.mockRejectedValue(new Error("timeout"));

        await processFederationHealth();
        expect(prisma.federationPeer.updateMany).toHaveBeenCalledWith({
            where: { id: "peer-1", outboundStatus: { not: "REVOKED" } },
            data: {
                outboundStatus: "OFFLINE",
                lastError: "timeout",
                lastErrorAt: expect.any(Date),
            },
        });
        expect(log.info).toHaveBeenCalledTimes(1);

        jest.clearAllMocks();
        prisma.federationPeer.findMany.mockResolvedValue([
            { ...peer, outboundStatus: "OFFLINE" },
        ]);
        prisma.federationPeer.updateMany.mockResolvedValue({ count: 1 });
        getManifest.mockRejectedValue(new Error("timeout"));
        await processFederationHealth();
        expect(log.info).not.toHaveBeenCalled();
    });

    it("recovers an offline peer with one transition log", async () => {
        prisma.federationPeer.findMany.mockResolvedValue([
            {
                ...peer,
                direction: "BOTH",
                inboundStatus: "ACTIVE",
                outboundStatus: "OFFLINE",
            },
        ]);

        await processFederationHealth();

        expect(log.info).toHaveBeenCalledWith(
            "peerId=peer-1 status=ACTIVE previous=OFFLINE",
        );
        expect(prisma.federationPeer.updateMany).toHaveBeenCalledWith({
            where: { id: "peer-1", outboundStatus: { not: "REVOKED" } },
            data: {
                outboundStatus: "ACTIVE",
                lastSeenAt: expect.any(Date),
                capabilities: ["track-attrs-loudness"],
            },
        });
        expect(prisma.federationPeer.updateMany).not.toHaveBeenCalledWith(
            expect.objectContaining({
                data: { inboundStatus: expect.anything() },
            }),
        );
    });
});
