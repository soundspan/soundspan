import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const getCover = jest.fn();
jest.mock("../federationClient", () => ({
    createFederationClient: jest.fn(() => ({ getCover })),
}));
jest.mock("../../config", () => ({
    config: { federation: { allowPrivatePeers: false, allowProxy: false } },
}));

import { proxyFederatedCover } from "../federationCoverProxy";

it("destroys a 404 upstream cover body", async () => {
    const upstream = new PassThrough();
    const destroy = jest.spyOn(upstream, "destroy");
    getCover.mockResolvedValueOnce({
        status: 404,
        headers: {},
        data: upstream,
    });
    const req = new EventEmitter();
    const res = new PassThrough() as PassThrough & {
        writableEnded: boolean;
    };

    await expect(
        proxyFederatedCover({
            req: req as never,
            res: res as never,
            peer: {
                id: "peer-1",
                baseUrl: "https://peer.example",
                outboundToken: "v2:encrypted-token",
                outboundStatus: "ACTIVE",
            },
            remoteId: "album-1",
        }),
    ).resolves.toBe(false);
    expect(destroy).toHaveBeenCalledTimes(1);
});
