import type {
    Audiobook,
    AudiobookProgress,
    FederationPeer,
} from "@prisma/client";

/** Audiobook row shape consumed by the audiobook route serializers. */
export type AudiobookRow = Audiobook & {
    federationPeer?: Pick<
        FederationPeer,
        "id" | "name" | "outboundStatus" | "baseUrl" | "outboundToken"
    > | null;
};

/** Progress fields the audiobook list/detail responses consume. */
export type ProgressRow = Pick<
    AudiobookProgress,
    "currentTime" | "duration" | "isFinished" | "lastPlayedAt"
>;

/** Federated origin fields for a peer-mirrored audiobook row. */
export function federatedSource(book: AudiobookRow) {
    if (!book.peerId || !book.federationPeer) return {};
    return {
        source: "federated" as const,
        peer: {
            id: book.federationPeer.id,
            name: book.federationPeer.name,
            online: book.federationPeer.outboundStatus === "ACTIVE",
        },
    };
}

/** Serializes a progress row into the API progress payload. */
export function progressResponse(progress: ProgressRow | null | undefined) {
    if (!progress) return null;
    return {
        currentTime: progress.currentTime,
        progress:
            progress.duration > 0
                ? (progress.currentTime / progress.duration) * 100
                : 0,
        isFinished: progress.isFinished,
        lastPlayedAt: progress.lastPlayedAt,
    };
}

/** Serializes an audiobook row into the list response payload. */
export function audiobookListResponse(
    book: AudiobookRow,
    progress: ProgressRow | null | undefined,
) {
    return {
        id: book.id,
        title: book.title,
        author: book.author || "Unknown Author",
        narrator: book.narrator,
        description: book.description,
        coverUrl:
            book.localCoverPath || book.coverUrl
                ? `/audiobooks/${book.id}/cover`
                : null,
        duration: book.duration || 0,
        libraryId: book.libraryId,
        series: book.series
            ? { name: book.series, sequence: book.seriesSequence || "1" }
            : null,
        genres: book.genres || [],
        progress: progressResponse(progress),
        ...federatedSource(book),
    };
}
