interface FederatedPayloadPeer {
    id: string;
    name: string;
    outboundStatus: string | null;
}

/** Adds playback-only peer provenance without changing federation envelopes. */
export function withFederatedTrackPlayback<Track extends { origin: string }>(
    track: Track,
    peer: FederatedPayloadPeer | null,
) {
    if (track.origin !== "FEDERATED" || !peer) return track;
    return {
        ...track,
        source: "federated" as const,
        streamSource: "peer" as const,
        peer: {
            id: peer.id,
            name: peer.name,
            online: peer.outboundStatus === "ACTIVE",
        },
    };
}
