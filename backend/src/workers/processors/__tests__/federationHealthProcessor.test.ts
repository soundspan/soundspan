const getManifest = jest.fn();
const createFederationClient = jest.fn(() => ({ getManifest }));
class MockFederationHttpError extends Error {
    constructor(
        public readonly status: number | null,
        public readonly transient: boolean,
    ) {
        super(`Federation peer returned ${status}`);
    }
}
class MockFederationResponseError extends Error {}
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
    FederationHttpError: MockFederationHttpError,
    FederationResponseError: MockFederationResponseError,
}));
jest.mock("../../../config", () => ({
    config: { federation: { allowPrivatePeers: false, allowProxy: false } },
}));

import { processFederationHealth } from "../federationHealthProcessor";
import {
    FederationHttpError,
    FederationResponseError,
} from "../../../services/federationClient";

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
                lastError: null,
                lastErrorAt: null,
                lastErrorClass: null,
            },
        });
        expect(log.info).not.toHaveBeenCalled();
    });

    it.each([
        [
            "unreachable",
            Object.assign(new Error("connection refused"), {
                isAxiosError: true,
                code: "ECONNREFUSED",
            }),
        ],
        [
            "tls",
            Object.assign(new Error("certificate rejected"), {
                isAxiosError: true,
                code: "ERR_TLS_CERT_ALTNAME_INVALID",
            }),
        ],
        ["unauthorized", new FederationHttpError(401, false)],
        ["peer_invalid", new FederationResponseError()],
    ] as const)(
        "persists %s failures and marks the peer offline",
        async (lastErrorClass, error) => {
            getManifest.mockRejectedValue(error);

            await processFederationHealth();

            expect(prisma.federationPeer.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "peer-1",
                    outboundStatus: { not: "REVOKED" },
                },
                data: {
                    outboundStatus: "OFFLINE",
                    lastError: error.message || "Federation operation failed",
                    lastErrorAt: expect.any(Date),
                    lastErrorClass,
                },
            });
        },
    );

    it("logs only the first offline transition", async () => {
        getManifest.mockRejectedValue(new Error("timeout"));
        await processFederationHealth();
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
                lastError: null,
                lastErrorAt: null,
                lastErrorClass: null,
            },
        });
        expect(prisma.federationPeer.updateMany).not.toHaveBeenCalledWith(
            expect.objectContaining({
                data: { inboundStatus: expect.anything() },
            }),
        );
    });
});
