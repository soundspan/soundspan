import { withFederatedTrackPlayback } from "../federatedTrackPayload";

describe("federated track playback payload", () => {
    it("adds peer stream source and persisted health provenance", () => {
        expect(
            withFederatedTrackPlayback(
                { id: "track-1", origin: "FEDERATED" },
                {
                    id: "peer-1",
                    name: "Peer One",
                    outboundStatus: "ACTIVE",
                },
            ),
        ).toEqual({
            id: "track-1",
            origin: "FEDERATED",
            source: "federated",
            streamSource: "peer",
            peer: { id: "peer-1", name: "Peer One", online: true },
        });
    });
});
