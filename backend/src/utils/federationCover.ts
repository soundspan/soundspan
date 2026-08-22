/** Builds the local route that resolves and streams a peer-owned album cover. */
export function buildFederatedCoverProxyPath(albumId: string): string {
    return `/api/library/cover-art/${encodeURIComponent(albumId)}`;
}
