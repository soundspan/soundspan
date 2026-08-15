const createMapping = jest.fn();
const prisma = {
    federationPeer: { findUnique: jest.fn() },
    track: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
};

jest.mock("../../utils/db", () => ({ prisma }));
jest.mock("../trackMappingService", () => ({
    trackMappingService: { createMapping },
}));

import {
    arbitrateFederationTrackDedup,
    listFederationPeerDedup,
} from "../federationDedupArbitration";

const localTrack = {
    id: "local-1",
    title: "Local Track",
    album: { title: "Local Album", artist: { name: "Local Artist" } },
    mappings: [{ confidence: 0.95 }],
};
const federatedTrack = {
    id: "fed-1",
    title: "Peer Track",
    dedupPinned: true,
    dedupOfTrackId: "local-1",
    audioHash: "sha256:abc",
    recordingMbid: null,
    isrc: null,
    discNo: 1,
    trackNo: 2,
    album: {
        title: "Peer Album",
        rgMbid: "release-group-1",
        artist: { name: "Peer Artist" },
    },
    dedupOfTrack: localTrack,
};

describe("federation dedup arbitration", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.federationPeer.findUnique.mockResolvedValue({ id: "peer-1" });
        prisma.track.findMany.mockResolvedValue([]);
        prisma.track.updateMany.mockResolvedValue({ count: 1 });
        prisma.$transaction.mockImplementation(
            async (
                operation: (transaction: typeof prisma) => Promise<unknown>,
            ) => operation(prisma),
        );
        createMapping.mockResolvedValue({ id: "mapping-1" });
    });

    it("returns a stable keyset page with mapping tier and confidence", async () => {
        prisma.track.findMany.mockResolvedValueOnce([
            federatedTrack,
            { ...federatedTrack, id: "fed-2", dedupPinned: false },
            { ...federatedTrack, id: "fed-3" },
        ]);

        const result = await listFederationPeerDedup({
            peerId: "peer-1",
            cursor: "fed-0",
            limit: 2,
        });

        expect(prisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    peerId: "peer-1",
                    id: { gt: "fed-0" },
                    OR: [
                        { dedupOfTrackId: { not: null } },
                        { dedupPinned: true },
                    ],
                }),
                orderBy: { id: "asc" },
                take: 3,
            }),
        );
        expect(result).toEqual({
            items: [
                expect.objectContaining({
                    federatedTrack: expect.objectContaining({ id: "fed-1" }),
                    localTrack: expect.objectContaining({ id: "local-1" }),
                    tier: "recordingMbid",
                    confidence: 0.95,
                    pinned: true,
                }),
                expect.objectContaining({
                    federatedTrack: expect.objectContaining({ id: "fed-2" }),
                }),
            ],
            nextCursor: "fed-2",
        });
    });

    it.each([
        ["link", { action: "link", localTrackId: "local-1" }, "local-1", true],
        ["unlink", { action: "unlink" }, null, true],
    ] as const)(
        "pins a manual %s decision",
        async (_name, action, target, pinned) => {
            prisma.track.findFirst.mockImplementation(async ({ where }) => {
                if (where.id === "fed-1") return federatedTrack;
                if (where.id === "local-1") return localTrack;
                return null;
            });

            await arbitrateFederationTrackDedup("fed-1", action);

            expect(prisma.track.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "fed-1",
                    origin: "FEDERATED",
                    peerId: { not: null },
                },
                data: { dedupOfTrackId: target, dedupPinned: pinned },
            });
        },
    );

    it("clears the pin and immediately reapplies the strongest standard match", async () => {
        prisma.track.findFirst.mockImplementation(async ({ where }) => {
            if (where.id === "fed-1") return federatedTrack;
            if (where.origin === "LOCAL" && where.audioHash === "sha256:abc") {
                return { id: "local-audio" };
            }
            return null;
        });

        await arbitrateFederationTrackDedup("fed-1", { action: "reset" });

        expect(prisma.track.updateMany).toHaveBeenCalledWith({
            where: { id: "fed-1", origin: "FEDERATED", peerId: { not: null } },
            data: { dedupOfTrackId: "local-audio", dedupPinned: false },
        });
        expect(createMapping).toHaveBeenCalledWith({
            trackId: "local-audio",
            confidence: 1,
            source: "federation",
        });
    });

    it("hides missing, removed, and non-local link targets behind one result", async () => {
        prisma.track.findFirst.mockImplementation(async ({ where }) =>
            where.id === "fed-1" ? federatedTrack : null,
        );

        await expect(
            arbitrateFederationTrackDedup("fed-1", {
                action: "link",
                localTrackId: "hidden-local",
            }),
        ).resolves.toBeNull();
        expect(prisma.track.updateMany).not.toHaveBeenCalled();
    });
});
