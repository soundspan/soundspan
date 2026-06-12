/**
 * Shared types and pure helpers for the unified mixed-media play queue.
 *
 * The play queue can contain music tracks and podcast episodes side by side.
 * Tracks keep their full `Track` shape; legacy persisted queues (written
 * before mixed queues existed) have no `itemType` and are normalized to
 * `itemType: "track"`.
 */

import type { Track } from "./audio-state-context";

/** Queue entry representing a podcast episode in the unified play queue. */
export interface EpisodeQueueItem {
    itemType: "episode";
    /** Composite identifier in the form "podcastId:episodeId". */
    id: string;
    title: string;
    podcastTitle: string;
    podcastId: string;
    episodeId: string;
    coverUrl: string | null;
    duration: number;
}

/**
 * Music track entry in the unified play queue. `itemType` is optional so
 * existing `Track[]` values (and legacy persisted queues) remain assignable;
 * a missing `itemType` always means "track".
 */
export type TrackQueueItem = Track & { itemType?: "track" };

/** A single entry of the unified mixed-media play queue. */
export type QueueItem = TrackQueueItem | EpisodeQueueItem;

/** Narrows a queue item (or nullable) to a podcast episode entry. */
export function isEpisodeQueueItem(
    item: QueueItem | null | undefined
): item is EpisodeQueueItem {
    return Boolean(item) && (item as EpisodeQueueItem).itemType === "episode";
}

/** Input fields for building an episode queue entry. */
export interface BuildEpisodeQueueItemInput {
    podcastId: string;
    episodeId: string;
    title: string;
    podcastTitle: string;
    coverUrl: string | null;
    duration: number;
}

/** Builds an episode queue entry with the composite "podcastId:episodeId" id. */
export function buildEpisodeQueueItem(
    input: BuildEpisodeQueueItemInput
): EpisodeQueueItem {
    return {
        itemType: "episode",
        id: `${input.podcastId}:${input.episodeId}`,
        title: input.title,
        podcastTitle: input.podcastTitle,
        podcastId: input.podcastId,
        episodeId: input.episodeId,
        coverUrl: input.coverUrl ?? null,
        duration: Number(input.duration) || 0,
    };
}

/**
 * Builds an episode queue entry from the player's podcast shape (the
 * `Podcast` interface in audio-state-context), whose `id` is already the
 * composite "podcastId:episodeId" identifier.
 */
export function episodeQueueItemFromPodcast(podcast: {
    id: string;
    title: string;
    podcastTitle: string;
    coverUrl: string | null;
    duration: number;
}): EpisodeQueueItem {
    const [podcastId = "", episodeId = ""] = podcast.id.split(":");
    return buildEpisodeQueueItem({
        podcastId,
        episodeId,
        title: podcast.title,
        podcastTitle: podcast.podcastTitle,
        coverUrl: podcast.coverUrl ?? null,
        duration: podcast.duration,
    });
}

function normalizeEpisodeQueueItem(
    raw: Record<string, unknown>
): EpisodeQueueItem | null {
    const id = typeof raw.id === "string" ? raw.id : "";
    if (!id) return null;

    const [idPodcastId, idEpisodeId] = id.split(":");
    const podcastId =
        typeof raw.podcastId === "string" && raw.podcastId
            ? raw.podcastId
            : idPodcastId || "";
    const episodeId =
        typeof raw.episodeId === "string" && raw.episodeId
            ? raw.episodeId
            : idEpisodeId || "";
    if (!podcastId || !episodeId) return null;

    return {
        itemType: "episode",
        id: `${podcastId}:${episodeId}`,
        title: typeof raw.title === "string" ? raw.title : "Unknown",
        podcastTitle:
            typeof raw.podcastTitle === "string" ? raw.podcastTitle : "",
        podcastId,
        episodeId,
        coverUrl: typeof raw.coverUrl === "string" ? raw.coverUrl : null,
        duration: Number(raw.duration) || 0,
    };
}

/**
 * Normalizes a persisted/serialized queue (localStorage or server snapshot)
 * into `QueueItem[]`. Items without an `itemType` default to tracks for
 * backward compatibility with pre-mixed-queue clients; entries without a
 * usable identity are dropped.
 */
export function normalizeQueueItems(raw: unknown): QueueItem[] {
    if (!Array.isArray(raw)) return [];

    const items: QueueItem[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== "object") continue;
        const candidate = entry as Record<string, unknown>;
        if (typeof candidate.id !== "string" || !candidate.id) continue;

        if (candidate.itemType === "episode") {
            const episode = normalizeEpisodeQueueItem(candidate);
            if (episode) items.push(episode);
            continue;
        }

        items.push({
            ...(candidate as unknown as Track),
            itemType: "track",
        });
    }
    return items;
}
