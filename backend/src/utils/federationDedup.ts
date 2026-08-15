/** Track identity fields used by local-wins federation deduplication. */
export interface FederationDedupIdentity {
    audioHash: string | null;
    recordingMbid: string | null;
    isrc: string | null;
    discNo: number;
    trackNo: number;
    albumRgMbid: string;
}

/** Restores a host release-group id from the collision-safe persisted form. */
export function decodeFederationIdentity(value: string): string {
    const parts = value.split(":");
    if (parts.length !== 3 || parts[0] !== "federation") return value;
    return Buffer.from(parts[2], "base64url").toString("utf8");
}

/** Returns the strongest matching federation identity tier, if any. */
export function federationDedupConfidence(
    local: FederationDedupIdentity,
    remote: FederationDedupIdentity,
): number | null {
    if (local.audioHash && local.audioHash === remote.audioHash) return 1;
    if (local.recordingMbid && local.recordingMbid === remote.recordingMbid) {
        return 0.95;
    }
    if (local.isrc && local.isrc === remote.isrc) return 0.9;
    if (
        local.albumRgMbid === decodeFederationIdentity(remote.albumRgMbid) &&
        local.discNo === remote.discNo &&
        local.trackNo === remote.trackNo
    ) {
        return 0.8;
    }
    return null;
}
