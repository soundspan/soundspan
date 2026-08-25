import type { Prisma } from "@prisma/client";
import { Request, Router } from "express";
import { logger } from "../utils/logger";
import { z } from "zod";
import { requireAdmin, requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { sessionLog } from "../utils/playlistLogger";
import { trackMappingService } from "../services/trackMappingService";
import {
    formatUnifiedTrackItem,
    type UnifiedPlaylistItemRecord,
} from "../services/unifiedTrackResponse";
import {
    resolvePlaylistItemsForUser,
    type ResolvedPlaylistItem,
} from "../services/playlistTrackResolution";
import {
    getUserProviderProfile,
    type UserProviderProfile,
} from "../services/listenTogetherResolution";
import { TRACK_VISIBLE_WHERE } from "../utils/librarySorting";
import { standardPlaylistListWhere } from "../services/radioPlaylistIdentity";
import {
    PLAYLIST_REORDER_MAX_ITEMS,
    removeLockedPlaylistItem,
    requirePlaylistMutationLock,
    reorderLockedPlaylistItems,
} from "../services/playlistMutationLock";
import { requestCoalescedLibraryScan } from "../services/coalescedLibraryScan";

const router = Router();

const PLAYLISTS_MAX_LIMIT = 1000;
const PLAYLISTS_DEFAULT_LIMIT = 500;
const PLAYLIST_PREVIEW_ITEMS = 12;
const PLAYLIST_DETAIL_MAX_ITEMS = 1000;
const PLAYLIST_DETAIL_QUERY_ITEMS = PLAYLIST_DETAIL_MAX_ITEMS + 1;
const pendingRetryPath = "/:id/pending/:trackId/retry";

type RetryRequest = Request<{ id: string; trackId: string }>;

type ReorderSelection =
    | { success: true; ids: string[]; byItemId: boolean }
    | { success: false; message: string };

type UnvalidatedReorderSelection =
    | { success: true; ids: unknown[]; byItemId: boolean }
    | { success: false; message: string };

type ReorderPlaylistItem = {
    id: string;
    trackId: string | null;
};

type MappingAvailabilityRow = {
    trackId: string | null;
    trackTidalId: string | null;
    trackYtMusicId: string | null;
};

type ResolutionPartition = {
    delegatedItems: UnifiedPlaylistItemRecord[];
    delegatedIndexes: number[];
};

type FallbackIds = {
    tidalIds: string[];
    ytIds: string[];
};

type PendingPlaylistItemRecord = {
    id: string;
    sort: number;
    spotifyArtist: string;
    spotifyTitle: string;
    spotifyAlbum: string;
    deezerPreviewUrl: string | null;
};

const reorderPayloadSchema = z.object({
    itemIds: z.unknown().optional(),
    trackIds: z.unknown().optional(),
});

const reorderIdsSchema = z.array(z.string().min(1));

function getReorderSelection(body: unknown): UnvalidatedReorderSelection {
    const parsedPayload = reorderPayloadSchema.safeParse(body);
    const payload = parsedPayload.success ? parsedPayload.data : {};
    const { itemIds, trackIds } = payload;
    if (itemIds !== undefined && !Array.isArray(itemIds)) {
        return { success: false, message: "itemIds must be an array" };
    }
    if (trackIds !== undefined && !Array.isArray(trackIds)) {
        return { success: false, message: "trackIds must be an array" };
    }

    const byItemId = Array.isArray(itemIds);
    const selected = byItemId ? itemIds : trackIds;
    if (!Array.isArray(selected)) {
        return {
            success: false,
            message: "itemIds or trackIds must be an array",
        };
    }
    return { success: true, ids: selected, byItemId };
}

function validateReorderIds(
    selection: Extract<UnvalidatedReorderSelection, { success: true }>,
): ReorderSelection {
    if (selection.ids.length > PLAYLIST_REORDER_MAX_ITEMS) {
        return {
            success: false,
            message: `A playlist reorder cannot exceed ${PLAYLIST_REORDER_MAX_ITEMS} items`,
        };
    }
    const parsedIds = reorderIdsSchema.safeParse(selection.ids);
    if (!parsedIds.success) {
        return {
            success: false,
            message: "Reorder identifiers must be non-empty strings",
        };
    }

    const ids = parsedIds.data;
    if (new Set(ids).size !== ids.length) {
        return {
            success: false,
            message: "Reorder identifiers must not contain duplicates",
        };
    }
    return { success: true, ids, byItemId: selection.byItemId };
}

function selectReorderIds(body: unknown): ReorderSelection {
    const selection = getReorderSelection(body);
    return selection.success ? validateReorderIds(selection) : selection;
}

function getExpectedReorderIds(
    byItemId: boolean,
    playlistItems: ReorderPlaylistItem[],
): string[] {
    if (byItemId) return playlistItems.map((item) => item.id);
    return playlistItems
        .map((item) => item.trackId)
        .filter((trackId): trackId is string => trackId !== null);
}

function validateExactReorder(
    selection: Extract<ReorderSelection, { success: true }>,
    playlistItems: ReorderPlaylistItem[],
): { status: 400 | 404; message: string } | null {
    if (playlistItems.length > PLAYLIST_REORDER_MAX_ITEMS) {
        return {
            status: 400,
            message: `Playlist exceeds the maximum reorder size of ${PLAYLIST_REORDER_MAX_ITEMS} items`,
        };
    }

    const expectedIds = getExpectedReorderIds(
        selection.byItemId,
        playlistItems,
    );
    const expectedIdSet = new Set(expectedIds);
    if (selection.ids.some((id) => !expectedIdSet.has(id))) {
        return {
            status: 404,
            message: selection.byItemId
                ? "One or more playlist items were not found in this playlist"
                : "One or more tracks were not found in this playlist",
        };
    }
    if (
        selection.ids.length !== playlistItems.length ||
        expectedIds.length !== playlistItems.length
    ) {
        return {
            status: 400,
            message:
                "Reorder identifiers must include every playlist item exactly once",
        };
    }
    return null;
}

function isPrismaRecordNotFound(value: unknown): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        "code" in value &&
        value.code === "P2025"
    );
}

router.use(requireAuthOrToken);

const createPlaylistSchema = z.object({
    name: z.string().min(1).max(200),
    isPublic: z.boolean().optional().default(false),
});

const updatePlaylistSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    isPublic: z.boolean().optional(),
});

const playlistItemInclude = {
    track: {
        // Full Track scalars include removedAt while preserving the existing
        // response shape for active playlist items.
        include: {
            federationPeer: {
                select: { id: true, name: true, outboundStatus: true },
            },
            album: {
                include: {
                    artist: {
                        select: {
                            id: true,
                            name: true,
                            mbid: true,
                        },
                    },
                },
            },
        },
    },
    trackTidal: true,
    trackYtMusic: true,
} as const;

function getFallbackToken(
    item: UnifiedPlaylistItemRecord,
    profile: UserProviderProfile,
): string | null {
    if (item.trackTidalId && (!profile.hasTidal || !item.trackTidal)) {
        return `t:${item.trackTidalId}`;
    }
    if (item.trackYtMusicId && (!profile.hasYtMusic || !item.trackYtMusic)) {
        return `y:${item.trackYtMusicId}`;
    }
    return null;
}

function mappingSupportsProfile(
    mapping: MappingAvailabilityRow,
    profile: UserProviderProfile,
): boolean {
    return Boolean(
        mapping.trackId ||
        (mapping.trackTidalId && profile.hasTidal) ||
        (mapping.trackYtMusicId && profile.hasYtMusic),
    );
}

function addMappingTokens(
    tokens: Set<string>,
    mapping: MappingAvailabilityRow,
): void {
    if (mapping.trackTidalId) tokens.add(`t:${mapping.trackTidalId}`);
    if (mapping.trackYtMusicId) tokens.add(`y:${mapping.trackYtMusicId}`);
}

function collectFallbackIds(
    items: UnifiedPlaylistItemRecord[],
    profile: UserProviderProfile,
): FallbackIds {
    const tidalIds = new Set<string>();
    const ytIds = new Set<string>();
    items.forEach((item) => {
        const token = getFallbackToken(item, profile);
        if (token?.startsWith("t:")) tidalIds.add(token.slice(2));
        if (token?.startsWith("y:")) ytIds.add(token.slice(2));
    });
    return { tidalIds: Array.from(tidalIds), ytIds: Array.from(ytIds) };
}

async function loadFallbackMappings(
    ids: FallbackIds,
): Promise<MappingAvailabilityRow[]> {
    if (ids.tidalIds.length === 0 && ids.ytIds.length === 0) return [];
    return prisma.trackMapping.findMany({
        where: {
            stale: false,
            OR: [
                ...(ids.tidalIds.length > 0
                    ? [{ trackTidalId: { in: ids.tidalIds } }]
                    : []),
                ...(ids.ytIds.length > 0
                    ? [{ trackYtMusicId: { in: ids.ytIds } }]
                    : []),
            ],
        },
        select: {
            trackId: true,
            trackTidalId: true,
            trackYtMusicId: true,
        },
    });
}

function collectUsableMappingTokens(
    mappings: MappingAvailabilityRow[],
    profile: UserProviderProfile,
): Set<string> {
    const usableTokens = new Set<string>();
    for (const mapping of mappings) {
        if (mappingSupportsProfile(mapping, profile)) {
            addMappingTokens(usableTokens, mapping);
        }
    }
    return usableTokens;
}

async function loadUsableFallbackTokens(
    items: UnifiedPlaylistItemRecord[],
    profile: UserProviderProfile,
): Promise<Set<string>> {
    const ids = collectFallbackIds(items, profile);
    const mappings = await loadFallbackMappings(ids);
    return collectUsableMappingTokens(mappings, profile);
}

function partitionResolutionItems(
    items: UnifiedPlaylistItemRecord[],
    profile: UserProviderProfile,
    usableFallbackTokens: Set<string>,
): ResolutionPartition {
    const delegatedItems: UnifiedPlaylistItemRecord[] = [];
    const delegatedIndexes: number[] = [];
    items.forEach((item, index) => {
        const fallbackToken = getFallbackToken(item, profile);
        if (!fallbackToken || usableFallbackTokens.has(fallbackToken)) {
            delegatedItems.push(item);
            delegatedIndexes.push(index);
        }
    });
    return { delegatedItems, delegatedIndexes };
}

async function resolvePlaylistDetailItems(
    items: UnifiedPlaylistItemRecord[],
    userId: string,
): Promise<ResolvedPlaylistItem[]> {
    if (items.length === 0) return [];
    const profile = await getUserProviderProfile(userId);
    const usableTokens = await loadUsableFallbackTokens(items, profile);
    const partition = partitionResolutionItems(items, profile, usableTokens);
    const delegated = await resolvePlaylistItemsForUser(
        partition.delegatedItems,
        userId,
    );
    const resolvedByIndex = new Map<number, ResolvedPlaylistItem>();
    partition.delegatedIndexes.forEach((itemIndex, delegatedIndex) => {
        resolvedByIndex.set(itemIndex, delegated[delegatedIndex]);
    });
    return items.map(
        (item, index) =>
            resolvedByIndex.get(index) ?? {
                original: item,
                effective: item,
                resolution: { available: false, reason: "no-provider" },
            },
    );
}

const addTrackSchema = z
    .object({
        trackId: z.string().trim().min(1).optional(),
        tidalTrackId: z.coerce.number().int().positive().optional(),
        youtubeVideoId: z.string().trim().min(1).optional(),
        title: z.string().trim().min(1).optional(),
        artist: z.string().trim().min(1).optional(),
        album: z.string().trim().min(1).optional(),
        duration: z.coerce.number().int().nonnegative().optional(),
        isrc: z.string().trim().min(1).max(64).optional(),
        quality: z.string().trim().min(1).max(64).optional(),
        explicit: z.boolean().optional(),
        thumbnailUrl: z.string().trim().min(1).optional(),
    })
    .superRefine((value, ctx) => {
        const identifierCount = [
            value.trackId,
            value.tidalTrackId,
            value.youtubeVideoId,
        ].filter((entry) => entry !== undefined).length;
        if (identifierCount !== 1) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    "Exactly one of trackId, tidalTrackId, or youtubeVideoId is required.",
                path: ["trackId"],
            });
            return;
        }

        const needsRemoteMetadata =
            value.tidalTrackId !== undefined ||
            value.youtubeVideoId !== undefined;
        if (!needsRemoteMetadata) return;

        if (!value.title) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "title is required for remote playlist items.",
                path: ["title"],
            });
        }
        if (!value.artist) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "artist is required for remote playlist items.",
                path: ["artist"],
            });
        }
        if (!value.album) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "album is required for remote playlist items.",
                path: ["album"],
            });
        }
        if (value.duration === undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "duration is required for remote playlist items.",
                path: ["duration"],
            });
        }
    });

type AddTrackData = z.infer<typeof addTrackSchema>;

type PlaylistItemReference = {
    trackId: string | null;
    trackTidalId: string | null;
    trackYtMusicId: string | null;
};

type AddItemResult = { duplicated: boolean; item: UnifiedPlaylistItemRecord };

async function resolvePlaylistItemReference(
    data: AddTrackData,
): Promise<PlaylistItemReference | null> {
    if (data.trackId) {
        const track = await prisma.track.findUnique({
            where: { id: data.trackId, removedAt: null },
        });
        if (!track) return null;
        return {
            trackId: data.trackId,
            trackTidalId: null,
            trackYtMusicId: null,
        };
    }

    const ensured = await trackMappingService.ensureRemoteTrack({
        provider: data.tidalTrackId !== undefined ? "tidal" : "youtube",
        tidalId: data.tidalTrackId,
        videoId: data.youtubeVideoId,
        title: data.title as string,
        artist: data.artist as string,
        album: data.album as string,
        duration: data.duration as number,
        isrc: data.isrc,
        quality: data.quality,
        explicit: data.explicit,
        thumbnailUrl: data.thumbnailUrl,
    });
    return ensured.provider === "tidal"
        ? {
              trackId: null,
              trackTidalId: ensured.id,
              trackYtMusicId: null,
          }
        : {
              trackId: null,
              trackTidalId: null,
              trackYtMusicId: ensured.id,
          };
}

function getPlaylistItemReferenceWhere(
    playlistId: string,
    reference: PlaylistItemReference,
): Prisma.PlaylistItemWhereInput {
    if (reference.trackId) {
        return { playlistId, trackId: reference.trackId };
    }
    if (reference.trackTidalId) {
        return { playlistId, trackTidalId: reference.trackTidalId };
    }
    if (!reference.trackYtMusicId) throw new Error("Missing track reference");
    return { playlistId, trackYtMusicId: reference.trackYtMusicId };
}

async function addLockedPlaylistItem(
    tx: Prisma.TransactionClient,
    playlistId: string,
    userId: string,
    reference: PlaylistItemReference,
): Promise<AddItemResult> {
    await requirePlaylistMutationLock(tx, playlistId, userId);
    const existing = (await tx.playlistItem.findFirst({
        where: getPlaylistItemReferenceWhere(playlistId, reference),
        include: playlistItemInclude,
    })) as UnifiedPlaylistItemRecord | null;
    if (existing) return { duplicated: true, item: existing };

    const maximum = await tx.playlistItem.aggregate({
        where: { playlistId },
        _max: { sort: true },
    });
    const item = await tx.playlistItem.create({
        data: {
            playlistId,
            ...reference,
            sort: (maximum._max.sort ?? 0) + 1,
        },
        include: playlistItemInclude,
    });
    await tx.playlist.update({
        where: { id: playlistId },
        data: { updatedAt: new Date() },
    });
    return {
        duplicated: false,
        item: item as UnifiedPlaylistItemRecord,
    };
}

function unavailablePlaybackForReason(reason: string): {
    isPlayable: boolean;
    reason: string;
    message: string;
} {
    if (reason === "no-provider") {
        return {
            isPlayable: false,
            reason: "provider_unavailable",
            message:
                "Playback is unavailable because this account is not connected to a compatible provider for this track.",
        };
    }

    if (reason === "duration-mismatch") {
        return {
            isPlayable: false,
            reason: "duration_mismatch",
            message:
                "Playback is unavailable because available provider matches failed duration validation.",
        };
    }

    if (reason === "low-confidence") {
        return {
            isPlayable: false,
            reason: "low_confidence_mapping",
            message:
                "Playback is unavailable because available provider mappings are too low confidence.",
        };
    }

    if (reason === "stale") {
        return {
            isPlayable: false,
            reason: "stale_mapping",
            message:
                "Playback is unavailable because this mapping has been marked stale and needs refresh.",
        };
    }

    return {
        isPlayable: false,
        reason: "missing_provider_track",
        message:
            "Playback is unavailable because this playlist item no longer has an attached track source.",
    };
}

async function loadPlaylistDetail(playlistId: string, userId: string) {
    return prisma.playlist.findUnique({
        where: { id: playlistId },
        include: {
            user: { select: { username: true } },
            hiddenByUsers: {
                where: { userId },
                select: { id: true },
            },
            _count: {
                select: { items: true, pendingTracks: true },
            },
            items: {
                include: playlistItemInclude,
                orderBy: { sort: "asc" },
                take: PLAYLIST_DETAIL_QUERY_ITEMS,
            },
            pendingTracks: {
                orderBy: { sort: "asc" },
                take: PLAYLIST_DETAIL_QUERY_ITEMS,
            },
        },
    });
}

function selectBoundedPlaylistEntries<
    TTrack extends { sort: number },
    TPending extends { sort: number },
>(items: TTrack[], pendingTracks: TPending[]) {
    const entries = [
        ...items.map((item) => ({ type: "track" as const, item })),
        ...pendingTracks.map((item) => ({ type: "pending" as const, item })),
    ]
        .sort((a, b) => a.item.sort - b.item.sort)
        .slice(0, PLAYLIST_DETAIL_MAX_ITEMS);
    const boundedItems: TTrack[] = [];
    const boundedPendingTracks: TPending[] = [];
    entries.forEach((entry) => {
        if (entry.type === "track") {
            boundedItems.push(entry.item);
        } else {
            boundedPendingTracks.push(entry.item);
        }
    });
    return {
        items: boundedItems,
        pendingTracks: boundedPendingTracks,
    };
}

function formatResolvedPlaylistItems(resolvedItems: ResolvedPlaylistItem[]) {
    return resolvedItems.map((resolvedItem) => {
        const formatted = formatUnifiedTrackItem(resolvedItem.effective);
        if (
            resolvedItem.original.track?.removedAt ||
            resolvedItem.effective.track?.removedAt
        ) {
            formatted.playback = {
                isPlayable: false,
                reason: "track_removed",
                message:
                    "Playback is unavailable because this track was removed from the library.",
            };
        } else if (!resolvedItem.resolution.available) {
            formatted.playback = unavailablePlaybackForReason(
                resolvedItem.resolution.reason,
            );
        }
        return formatted;
    });
}

async function getRemovedTrackCounts(
    playlistIds: string[],
): Promise<Map<string, number>> {
    if (playlistIds.length === 0) return new Map();
    const rows = await prisma.playlistItem.groupBy({
        by: ["playlistId"],
        where: {
            playlistId: { in: playlistIds },
            track: { removedAt: { not: null } },
        },
        _count: { _all: true },
    });
    return new Map(
        rows.map((row) => [row.playlistId, row._count._all] as const),
    );
}

function formatPendingPlaylistItems(
    pendingTracks: PendingPlaylistItemRecord[],
) {
    return pendingTracks.map((pending) => ({
        id: pending.id,
        type: "pending" as const,
        sort: pending.sort,
        provider: { source: "pending" as const, label: "PENDING" },
        playback: {
            isPlayable: false,
            reason: "pending_import",
            message:
                "Playback is unavailable until this track is matched and imported.",
        },
        pending: {
            id: pending.id,
            artist: pending.spotifyArtist,
            title: pending.spotifyTitle,
            album: pending.spotifyAlbum,
            previewUrl: pending.deezerPreviewUrl,
        },
    }));
}

/**
 * @openapi
 * /api/playlists:
 *   get:
 *     summary: Get all playlists for the current user (owned and public)
 *     tags: [Playlists]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 500
 *           maximum: 1000
 *         description: Maximum number of playlists to return (clamped to 1000)
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of playlists to skip
 *     responses:
 *       200:
 *         description: List of playlists with authoritative track counts, ownership info, and bounded cover-art item previews
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   trackCount:
 *                     type: integer
 *                     description: Authoritative count of all items in the playlist
 *                   unplayableCount:
 *                     type: integer
 *                     description: Count of removed local tracks; omitted when zero
 *                   items:
 *                     type: array
 *                     maxItems: 12
 *                     description: Bounded cover-art preview; use the playlist detail endpoint for the full item list
 *       401:
 *         description: Not authenticated
 */
// GET /playlists
router.get("/", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;
        const { limit: limitParam = "500", offset: offsetParam = "0" } =
            req.query;
        const parsedLimit = parseInt(limitParam as string, 10);
        const limit = Math.min(
            parsedLimit > 0 ? parsedLimit : PLAYLISTS_DEFAULT_LIMIT,
            PLAYLISTS_MAX_LIMIT,
        );
        const offset = parseInt(offsetParam as string, 10) || 0;

        // Get user's hidden playlists
        const hiddenPlaylists = await prisma.hiddenPlaylist.findMany({
            where: { userId },
            select: { playlistId: true },
        });
        const hiddenPlaylistIds = new Set(
            hiddenPlaylists.map((h) => h.playlistId),
        );

        const playlists = await prisma.playlist.findMany({
            where: standardPlaylistListWhere(userId),
            orderBy: { createdAt: "desc" },
            take: limit,
            skip: offset,
            include: {
                user: {
                    select: {
                        username: true,
                    },
                },
                _count: {
                    select: {
                        items: true,
                    },
                },
                items: {
                    where: {
                        OR: [{ trackId: null }, { track: TRACK_VISIBLE_WHERE }],
                    },
                    select: {
                        id: true,
                        sort: true,
                        track: {
                            select: {
                                album: {
                                    select: {
                                        coverUrl: true,
                                    },
                                },
                            },
                        },
                    },
                    orderBy: { sort: "asc" },
                    take: PLAYLIST_PREVIEW_ITEMS,
                },
            },
        });
        const removedTrackCounts = await getRemovedTrackCounts(
            playlists.map((playlist) => playlist.id),
        );

        const playlistsWithCounts = playlists.map((playlist) => {
            const { _count, ...playlistFields } = playlist;
            const unplayableCount = removedTrackCounts.get(playlist.id) ?? 0;
            return {
                ...playlistFields,
                trackCount: _count.items,
                ...(unplayableCount > 0 ? { unplayableCount } : {}),
                isOwner: playlist.userId === userId,
                isHidden: hiddenPlaylistIds.has(playlist.id),
                items: playlist.items.map((item) => ({
                    id: item.id,
                    track: item.track
                        ? {
                              album: {
                                  coverArt: item.track.album.coverUrl,
                              },
                          }
                        : null,
                })),
            };
        });

        // Debug: log shared playlists with user info
        const sharedPlaylists = playlistsWithCounts.filter((p) => !p.isOwner);
        if (sharedPlaylists.length > 0) {
            logger.debug(
                `[Playlists] Found ${sharedPlaylists.length} shared playlists for user ${userId}:`,
            );
            sharedPlaylists.forEach((p) => {
                logger.debug(
                    `  - "${p.name}" by ${
                        p.user?.username || "UNKNOWN"
                    } (owner: ${p.userId})`,
                );
            });
        }

        res.json(playlistsWithCounts);
    } catch (error) {
        logger.error("Get playlists error:", error);
        res.status(500).json({ error: "Failed to get playlists" });
    }
});

/**
 * @openapi
 * /api/playlists:
 *   post:
 *     summary: Create a new playlist
 *     tags: [Playlists]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 200
 *               isPublic:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       200:
 *         description: Created playlist
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Not authenticated
 */
// POST /playlists
router.post("/", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;
        const data = createPlaylistSchema.parse(req.body);

        const playlist = await prisma.playlist.create({
            data: {
                userId,
                name: data.name,
                isPublic: data.isPublic,
            },
        });

        res.json(playlist);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.issues });
        }
        logger.error("Create playlist error:", error);
        res.status(500).json({ error: "Failed to create playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}:
 *   get:
 *     summary: Get a single playlist with tracks and pending tracks
 *     tags: [Playlists]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     responses:
 *       200:
 *         description: Playlist details with merged items capped at 1000 combined track and pending items
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalItemCount:
 *                   type: integer
 *                   description: Total number of track and pending items in the playlist before response truncation
 *                 unplayableCount:
 *                   type: integer
 *                   description: Count of removed local tracks; omitted when zero
 *                 truncated:
 *                   type: boolean
 *                   description: True when the playlist contains more than 1000 combined items and this response was capped
 *                 items:
 *                   type: array
 *                   maxItems: 1000
 *                   description: Resolved track items included in the bounded detail response
 *                 pendingTracks:
 *                   type: array
 *                   maxItems: 1000
 *                   description: Pending items included in the bounded detail response
 *                 mergedItems:
 *                   type: array
 *                   maxItems: 1000
 *                   description: The first 1000 combined track and pending items in playlist sort order
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
// GET /playlists/:id
router.get("/:id", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;

        const playlist = await loadPlaylistDetail(req.params.id, userId);

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        // Check access permissions
        if (!playlist.isPublic && playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        const removedTrackCounts = await getRemovedTrackCounts([playlist.id]);

        const totalItemCount =
            playlist._count.items + playlist._count.pendingTracks;
        const bounded = selectBoundedPlaylistEntries(
            playlist.items,
            playlist.pendingTracks,
        );

        const resolvedItems = await resolvePlaylistDetailItems(
            bounded.items,
            userId,
        );
        const formattedItems = formatResolvedPlaylistItems(resolvedItems);
        const formattedPending = formatPendingPlaylistItems(
            bounded.pendingTracks,
        );

        // Merge and sort by position
        const mergedItems = [
            ...formattedItems.map((item) => ({ ...item, sort: item.sort })),
            ...formattedPending,
        ].sort((a, b) => a.sort - b.sort);

        const { _count, ...playlistFields } = playlist;
        const unplayableCount = removedTrackCounts.get(playlist.id) ?? 0;
        res.json({
            ...playlistFields,
            isOwner: playlist.userId === userId,
            isHidden: playlist.hiddenByUsers.length > 0,
            trackCount: _count.items,
            ...(unplayableCount > 0 ? { unplayableCount } : {}),
            pendingCount: _count.pendingTracks,
            totalItemCount,
            truncated: totalItemCount > PLAYLIST_DETAIL_MAX_ITEMS,
            items: formattedItems,
            pendingTracks: formattedPending,
            mergedItems,
        });
    } catch (error) {
        logger.error("Get playlist error:", error);
        res.status(500).json({ error: "Failed to get playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}:
 *   put:
 *     summary: Update a playlist name and visibility
 *     tags: [Playlists]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 200
 *               isPublic:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Updated playlist
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
// PUT /playlists/:id
router.put("/:id", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;
        const data = updatePlaylistSchema.parse(req.body);

        // Check ownership
        const existing = await prisma.playlist.findUnique({
            where: { id: req.params.id },
        });

        if (!existing) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (existing.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        const playlist = await prisma.playlist.update({
            where: { id: req.params.id },
            data: {
                ...(data.name !== undefined && { name: data.name }),
                ...(data.isPublic !== undefined && { isPublic: data.isPublic }),
            },
        });

        res.json(playlist);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.issues });
        }
        logger.error("Update playlist error:", error);
        res.status(500).json({ error: "Failed to update playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/hide:
 *   post:
 *     summary: Hide a playlist from your view
 *     tags: [Playlists]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     responses:
 *       200:
 *         description: Playlist hidden
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 isHidden:
 *                   type: boolean
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
// POST /playlists/:id/hide - Hide any playlist from your view
router.post("/:id/hide", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;
        const playlistId = req.params.id;

        // Check playlist exists
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        // User must own the playlist OR it must be public (shared)
        if (playlist.userId !== userId && !playlist.isPublic) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Create hidden record (upsert to handle re-hiding)
        await prisma.hiddenPlaylist.upsert({
            where: {
                userId_playlistId: { userId, playlistId },
            },
            create: { userId, playlistId },
            update: {},
        });

        res.json({ message: "Playlist hidden", isHidden: true });
    } catch (error) {
        logger.error("Hide playlist error:", error);
        res.status(500).json({ error: "Failed to hide playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/hide:
 *   delete:
 *     summary: Unhide a previously hidden playlist
 *     tags: [Playlists]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     responses:
 *       200:
 *         description: Playlist unhidden
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 isHidden:
 *                   type: boolean
 *       401:
 *         description: Not authenticated
 */
// DELETE /playlists/:id/hide - Unhide a shared playlist
router.delete("/:id/hide", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;
        const playlistId = req.params.id;

        // Delete hidden record if exists
        await prisma.hiddenPlaylist.deleteMany({
            where: { userId, playlistId },
        });

        res.json({ message: "Playlist unhidden", isHidden: false });
    } catch (error) {
        logger.error("Unhide playlist error:", error);
        res.status(500).json({ error: "Failed to unhide playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}:
 *   delete:
 *     summary: Delete a playlist
 *     tags: [Playlists]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     responses:
 *       200:
 *         description: Playlist deleted
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
// DELETE /playlists/:id
router.delete("/:id", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;

        // Check ownership
        const existing = await prisma.playlist.findUnique({
            where: { id: req.params.id },
        });

        if (!existing) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (existing.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        await prisma.playlist.delete({
            where: { id: req.params.id },
        });

        res.json({ message: "Playlist deleted" });
    } catch (error) {
        logger.error("Delete playlist error:", error);
        res.status(500).json({ error: "Failed to delete playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/items:
 *   post:
 *     summary: Add a track to a playlist
 *     tags: [Playlists]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - type: object
 *                 required: [trackId]
 *                 not:
 *                   anyOf:
 *                     - required: [tidalTrackId]
 *                     - required: [youtubeVideoId]
 *                 properties:
 *                   trackId:
 *                     type: string
 *                     minLength: 1
 *                     description: Local library track ID
 *               - type: object
 *                 required: [tidalTrackId, title, artist, album, duration]
 *                 not:
 *                   anyOf:
 *                     - required: [trackId]
 *                     - required: [youtubeVideoId]
 *                 properties:
 *                   tidalTrackId:
 *                     type: integer
 *                     minimum: 1
 *                   title:
 *                     type: string
 *                     minLength: 1
 *                   artist:
 *                     type: string
 *                     minLength: 1
 *                   album:
 *                     type: string
 *                     minLength: 1
 *                   duration:
 *                     type: integer
 *                     minimum: 0
 *                     description: Track duration in seconds
 *                   isrc:
 *                     type: string
 *                     minLength: 1
 *                     maxLength: 64
 *                   quality:
 *                     type: string
 *                     minLength: 1
 *                     maxLength: 64
 *                   explicit:
 *                     type: boolean
 *                   thumbnailUrl:
 *                     type: string
 *                     minLength: 1
 *               - type: object
 *                 required: [youtubeVideoId, title, artist, album, duration]
 *                 not:
 *                   anyOf:
 *                     - required: [trackId]
 *                     - required: [tidalTrackId]
 *                 properties:
 *                   youtubeVideoId:
 *                     type: string
 *                     minLength: 1
 *                   title:
 *                     type: string
 *                     minLength: 1
 *                   artist:
 *                     type: string
 *                     minLength: 1
 *                   album:
 *                     type: string
 *                     minLength: 1
 *                   duration:
 *                     type: integer
 *                     minimum: 0
 *                     description: Track duration in seconds
 *                   isrc:
 *                     type: string
 *                     minLength: 1
 *                     maxLength: 64
 *                   quality:
 *                     type: string
 *                     minLength: 1
 *                     maxLength: 64
 *                   explicit:
 *                     type: boolean
 *                   thumbnailUrl:
 *                     type: string
 *                     minLength: 1
 *     responses:
 *       200:
 *         description: Track added to playlist (or already exists)
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist or track not found
 *       401:
 *         description: Not authenticated
 */
// POST /playlists/:id/items
router.post("/:id/items", async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });
        const userId = req.user.id;
        const parsedBody = addTrackSchema.safeParse(req.body);
        if (!parsedBody.success) {
            return res.status(400).json({
                error: "Invalid request",
                details: parsedBody.error.issues,
            });
        }
        const addTrackData = parsedBody.data;

        const playlist = await prisma.playlist.findUnique({
            where: { id: req.params.id },
        });
        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }
        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        const reference = await resolvePlaylistItemReference(addTrackData);
        if (!reference) {
            return res.status(404).json({ error: "Track not found" });
        }
        const result = await prisma.$transaction((tx) =>
            addLockedPlaylistItem(tx, req.params.id, userId, reference),
        );
        if (result.duplicated) {
            return res.status(200).json({
                message: "Track already in playlist",
                duplicated: true,
                item: formatUnifiedTrackItem(result.item),
            });
        }
        res.json(formatUnifiedTrackItem(result.item));
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.issues });
        }
        if (
            error instanceof Error &&
            error.message.startsWith("ensureRemoteTrack requires")
        ) {
            return res.status(400).json({
                error: "Invalid request",
                details: [{ message: error.message }],
            });
        }
        logger.error("Add track to playlist error:", error);
        res.status(500).json({ error: "Failed to add track to playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/items/{trackId}:
 *   delete:
 *     summary: Remove a playlist item
 *     tags: [Playlists]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *       - in: path
 *         name: trackId
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist item ID (preferred) or local track ID (legacy fallback)
 *     responses:
 *       200:
 *         description: Track removed from playlist
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
// DELETE /playlists/:id/items/:trackId
router.delete("/:id/items/:trackId", async (req, res) => {
    try {
        const userId = req.user!.id;

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: req.params.id },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        const playlistItemIdOrTrackId = req.params.trackId;
        const matchedByItemId = await prisma.playlistItem.findFirst({
            where: {
                playlistId: req.params.id,
                id: playlistItemIdOrTrackId,
            },
            select: { id: true },
        });

        let targetItemId = matchedByItemId?.id ?? null;
        if (!targetItemId) {
            const matchedByTrackId = await prisma.playlistItem.findFirst({
                where: {
                    playlistId: req.params.id,
                    trackId: playlistItemIdOrTrackId,
                },
                select: { id: true },
            });
            targetItemId = matchedByTrackId?.id ?? null;
        }

        if (!targetItemId) {
            return res.status(404).json({ error: "Playlist item not found" });
        }

        await prisma.$transaction((tx) =>
            removeLockedPlaylistItem(tx, req.params.id, userId, targetItemId),
        );

        res.json({ message: "Track removed from playlist" });
    } catch (error) {
        logger.error("Remove track from playlist error:", error);
        res.status(500).json({ error: "Failed to remove track from playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/items/reorder:
 *   put:
 *     summary: Reorder tracks in a playlist
 *     tags: [Playlists]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               itemIds:
 *                 type: array
 *                 maxItems: 1000
 *                 items:
 *                   type: string
 *                 description: Playlist item IDs in the desired order. Use for remote or mixed-source playlists; preferred when both arrays are present.
 *               trackIds:
 *                 type: array
 *                 maxItems: 1000
 *                 items:
 *                   type: string
 *                 description: Legacy local-library track IDs in the desired order
 *             anyOf:
 *               - required: [itemIds]
 *               - required: [trackIds]
 *     responses:
 *       200:
 *         description: Playlist reordered
 *       400:
 *         description: itemIds or trackIds must be an array
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
// PUT /playlists/:id/items/reorder
router.put("/:id/items/reorder", async (req, res) => {
    try {
        const userId = req.user!.id;
        const selection = selectReorderIds(req.body);
        if (!selection.success) {
            return res.status(400).json({ error: selection.message });
        }

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: req.params.id },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        const playlistItems = await prisma.playlistItem.findMany({
            where: { playlistId: req.params.id },
            select: { id: true, trackId: true },
            take: PLAYLIST_REORDER_MAX_ITEMS + 1,
        });
        const invalidReorder = validateExactReorder(selection, playlistItems);
        if (invalidReorder) {
            return res
                .status(invalidReorder.status)
                .json({ error: invalidReorder.message });
        }

        await prisma.$transaction((tx) =>
            reorderLockedPlaylistItems(
                tx,
                req.params.id,
                userId,
                selection.ids,
                selection.byItemId,
            ),
        );

        res.json({ message: "Playlist reordered" });
    } catch (error) {
        logger.error("Reorder playlist error:", error);
        res.status(500).json({ error: "Failed to reorder playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/pending:
 *   get:
 *     summary: Get pending tracks for a playlist (unmatched Spotify imports)
 *     tags: [Playlists]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     responses:
 *       200:
 *         description: Pending tracks list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count:
 *                   type: integer
 *                 tracks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 spotifyPlaylistId:
 *                   type: string
 *                   nullable: true
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
router.get("/:id/pending", async (req, res) => {
    try {
        const userId = req.user!.id;
        const playlistId = req.params.id;

        // Check ownership or public access
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId && !playlist.isPublic) {
            return res.status(403).json({ error: "Access denied" });
        }

        const pendingTracks = await prisma.playlistPendingTrack.findMany({
            where: { playlistId },
            orderBy: { sort: "asc" },
        });

        res.json({
            count: pendingTracks.length,
            tracks: pendingTracks.map((t) => ({
                id: t.id,
                artist: t.spotifyArtist,
                title: t.spotifyTitle,
                album: t.spotifyAlbum,
                position: t.sort,
                previewUrl: t.deezerPreviewUrl,
            })),
            spotifyPlaylistId: playlist.spotifyPlaylistId,
        });
    } catch (error) {
        logger.error("Get pending tracks error:", error);
        res.status(500).json({ error: "Failed to get pending tracks" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/pending/{trackId}:
 *   delete:
 *     summary: Remove a pending track from a playlist
 *     tags: [Playlists]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *       - in: path
 *         name: trackId
 *         required: true
 *         schema:
 *           type: string
 *         description: Pending track ID
 *     responses:
 *       200:
 *         description: Pending track removed
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist or pending track not found
 *       401:
 *         description: Not authenticated
 */
router.delete("/:id/pending/:trackId", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { id: playlistId, trackId: pendingTrackId } = req.params;

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        await prisma.playlistPendingTrack.delete({
            where: { id: pendingTrackId, playlistId },
        });

        res.json({ message: "Pending track removed" });
    } catch (error: unknown) {
        if (isPrismaRecordNotFound(error)) {
            return res.status(404).json({ error: "Pending track not found" });
        }
        logger.error("Delete pending track error:", error);
        res.status(500).json({ error: "Failed to delete pending track" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/pending/{trackId}/preview:
 *   get:
 *     summary: Get a fresh Deezer preview URL for a pending track
 *     tags: [Playlists]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *       - in: path
 *         name: trackId
 *         required: true
 *         schema:
 *           type: string
 *         description: Pending track ID
 *     responses:
 *       200:
 *         description: Fresh preview URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 previewUrl:
 *                   type: string
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist or pending track not found, or no preview available
 *       401:
 *         description: Not authenticated
 */
router.get("/:id/pending/:trackId/preview", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { id: playlistId, trackId: pendingTrackId } = req.params;

        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });
        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }
        if (playlist.userId !== userId && !playlist.isPublic) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Get the pending track
        const pendingTrack = await prisma.playlistPendingTrack.findUnique({
            where: { id: pendingTrackId, playlistId },
        });

        if (!pendingTrack) {
            return res.status(404).json({ error: "Pending track not found" });
        }

        // Fetch fresh Deezer preview URL
        const { deezerService } = await import("../services/deezer");
        const previewUrl = await deezerService.getTrackPreview(
            pendingTrack.spotifyArtist,
            pendingTrack.spotifyTitle,
        );

        if (!previewUrl) {
            return res
                .status(404)
                .json({ error: "No preview available on Deezer" });
        }

        // Update the stored preview URL for future use
        await prisma.playlistPendingTrack.update({
            where: { id: pendingTrackId, playlistId },
            data: { deezerPreviewUrl: previewUrl },
        });

        res.json({ previewUrl });
    } catch (error: unknown) {
        if (isPrismaRecordNotFound(error)) {
            return res.status(404).json({ error: "Pending track not found" });
        }
        logger.error("Get preview URL error:", error);
        res.status(500).json({ error: "Failed to get preview URL" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/pending/{trackId}/retry:
 *   post:
 *     summary: Retry downloading a pending track from Soulseek (admin only)
 *     description: Returns immediately and downloads in background. Triggers a library scan after download.
 *     tags: [Playlists]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *       - in: path
 *         name: trackId
 *         required: true
 *         schema:
 *           type: string
 *         description: Pending track ID
 *     responses:
 *       200:
 *         description: Download started or track not found on Soulseek
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 downloadJobId:
 *                   type: string
 *       400:
 *         description: Music path or Soulseek credentials not configured
 *       403:
 *         description: Authenticated but not an admin, or access denied
 *       404:
 *         description: Playlist or pending track not found
 *       401:
 *         description: Not authenticated
 */
router.post(pendingRetryPath, requireAdmin, async (req: RetryRequest, res) => {
    try {
        const userId = req.user!.id;
        const { id: playlistId, trackId: pendingTrackId } = req.params;

        sessionLog(
            "PENDING-RETRY",
            `Request: userId=${userId} playlistId=${playlistId} pendingTrackId=${pendingTrackId}`,
        );

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist) {
            sessionLog(
                "PENDING-RETRY",
                `Playlist not found: ${playlistId}`,
                "WARN",
            );
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            sessionLog(
                "PENDING-RETRY",
                `Access denied: playlistId=${playlistId} userId=${userId}`,
                "WARN",
            );
            return res.status(403).json({ error: "Access denied" });
        }

        // Get the pending track
        const pendingTrack = await prisma.playlistPendingTrack.findUnique({
            where: { id: pendingTrackId, playlistId },
        });

        if (!pendingTrack) {
            sessionLog(
                "PENDING-RETRY",
                `Pending track not found: ${pendingTrackId}`,
                "WARN",
            );
            return res.status(404).json({ error: "Pending track not found" });
        }

        sessionLog(
            "PENDING-RETRY",
            `Pending track: artist="${pendingTrack.spotifyArtist}" title="${pendingTrack.spotifyTitle}" album="${pendingTrack.spotifyAlbum}"`,
        );

        // Create a DownloadJob so this retry appears in Activity (active/history)
        const retryTargetId =
            pendingTrack.albumMbid ||
            pendingTrack.artistMbid ||
            `pendingTrack:${pendingTrack.id}`;

        const downloadJob = await prisma.downloadJob.create({
            data: {
                userId,
                subject: `${pendingTrack.spotifyArtist} - ${pendingTrack.spotifyTitle}`,
                type: "track",
                targetMbid: retryTargetId,
                artistMbid: pendingTrack.artistMbid,
                status: "processing",
                attempts: 1,
                startedAt: new Date(),
                metadata: {
                    downloadType: "pending-track-retry",
                    source: "soulseek",
                    playlistId,
                    pendingTrackId,
                    spotifyArtist: pendingTrack.spotifyArtist,
                    spotifyTitle: pendingTrack.spotifyTitle,
                    spotifyAlbum: pendingTrack.spotifyAlbum,
                    albumMbid: pendingTrack.albumMbid,
                },
            },
        });

        sessionLog(
            "PENDING-RETRY",
            `Created download job: downloadJobId=${downloadJob.id} target=${retryTargetId}`,
        );

        // Import soulseek service and try to download
        const { soulseekService } = await import("../services/soulseek");
        const { getSystemSettings } = await import("../utils/systemSettings");

        const settings = await getSystemSettings();
        if (!settings?.musicPath) {
            sessionLog("PENDING-RETRY", `Music path not configured`, "WARN");
            await failDownloadJob(downloadJob.id, "Music path not configured");
            return res.status(400).json({ error: "Music path not configured" });
        }

        if (!settings?.soulseekUsername || !settings?.soulseekPassword) {
            sessionLog(
                "PENDING-RETRY",
                `Soulseek credentials not configured`,
                "WARN",
            );
            await failDownloadJob(
                downloadJob.id,
                "Soulseek credentials not configured",
            );
            return res
                .status(400)
                .json({ error: "Soulseek credentials not configured" });
        }

        // Use a better album name if possible - extract from stored title or use artist name
        const albumName =
            pendingTrack.spotifyAlbum !== "Unknown Album"
                ? pendingTrack.spotifyAlbum
                : pendingTrack.spotifyArtist; // Use artist as fallback folder name

        logger.debug(
            `[Retry] Starting download for: ${pendingTrack.spotifyArtist} - ${pendingTrack.spotifyTitle}`,
        );
        sessionLog(
            "PENDING-RETRY",
            `Search: ${pendingTrack.spotifyArtist} - ${pendingTrack.spotifyTitle}`,
        );

        // First do a quick search to see if track is available (15s timeout)
        // This way we can tell the user immediately if it's not found
        const searchResult = await soulseekService.searchTrack(
            pendingTrack.spotifyArtist,
            pendingTrack.spotifyTitle,
        );

        if (!searchResult.found || searchResult.allMatches.length === 0) {
            logger.debug(`[Retry] No results found on Soulseek`);
            sessionLog("PENDING-RETRY", `No results found on Soulseek`, "INFO");

            await failDownloadJob(downloadJob.id, "No matching files found");

            return res.status(200).json({
                success: false,
                message: "Track not found on Soulseek",
                error: "No matching files found",
            });
        }

        logger.debug(
            `[Retry] ✓ Found ${searchResult.allMatches.length} results, starting download in background`,
        );
        sessionLog(
            "PENDING-RETRY",
            `Found ${searchResult.allMatches.length} candidate(s); starting background download`,
        );

        // Return immediately - download happens in background
        res.json({
            success: true,
            message: "Download started",
            note: `Found ${searchResult.allMatches.length} sources. Downloading... Track will appear after scan.`,
            downloadJobId: downloadJob.id,
        });

        // Start download in background (don't await)
        soulseekService
            .downloadBestMatch(
                pendingTrack.spotifyArtist,
                pendingTrack.spotifyTitle,
                albumName,
                searchResult.allMatches,
                settings.musicPath,
            )
            .then(async (result) => {
                if (result.success) {
                    logger.debug(
                        `[Retry] ✓ Download complete: ${result.filePath}`,
                    );
                    sessionLog(
                        "PENDING-RETRY",
                        `Download complete: filePath=${result.filePath}`,
                    );

                    await prisma.downloadJob.update({
                        where: { id: downloadJob.id },
                        data: {
                            status: "completed",
                            completedAt: new Date(),
                            metadata: {
                                ...(downloadJob.metadata as any),
                                filePath: result.filePath,
                            },
                        },
                    });

                    // Trigger a library scan to add the track and reconcile pending
                    try {
                        await requestCoalescedLibraryScan(
                            userId,
                            "retry-pending-track",
                        );
                        logger.debug(
                            `[Retry] Queued library scan to reconcile pending tracks`,
                        );
                        sessionLog(
                            "PENDING-RETRY",
                            "Queued coalesced library scan",
                        );
                    } catch (scanError) {
                        logger.error(
                            `[Retry] Failed to queue scan:`,
                            scanError,
                        );
                        // Keep raw exception detail out of the persistent session log.
                        sessionLog(
                            "PENDING-RETRY",
                            "Failed to queue scan (raw detail in server log)",
                            "ERROR",
                        );
                    }
                } else {
                    logger.debug(`[Retry] Download failed: ${result.error}`);
                    // Keep raw exception detail out of the persistent session log.
                    sessionLog(
                        "PENDING-RETRY",
                        "Download failed (raw detail in server log)",
                        "WARN",
                    );

                    await failDownloadJob(
                        downloadJob.id,
                        result.error || "Download failed",
                    );
                }
            })
            .catch((error) => {
                logger.error(`[Retry] Download error:`, error);
                // Keep raw exception detail out of the persistent session log.
                sessionLog(
                    "PENDING-RETRY",
                    "Download exception (raw detail in server log)",
                    "ERROR",
                );

                // downloadJob rows (including error) are returned to the owning user via GET /api/downloads.
                failDownloadJob(downloadJob.id, "Download exception").catch(
                    () => undefined,
                );
            });
    } catch (error: any) {
        logger.error("Retry pending track error:", error);
        sessionLog(
            "PENDING-RETRY",
            "Handler error (raw detail in server log)",
            "ERROR",
        );
        res.status(500).json({
            error: "Failed to retry download",
        });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/pending/reconcile:
 *   post:
 *     summary: Manually trigger reconciliation of pending tracks for a playlist
 *     tags: [Playlists]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     responses:
 *       200:
 *         description: Reconciliation complete
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 tracksAdded:
 *                   type: integer
 *                 playlistsUpdated:
 *                   type: integer
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
router.post("/:id/pending/reconcile", async (req, res) => {
    try {
        const userId = req.user!.id;
        const playlistId = req.params.id;

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Import and run reconciliation
        const { spotifyImportService } =
            await import("../services/spotifyImport");
        const result = await spotifyImportService.reconcilePendingTracks();

        res.json({
            message: "Reconciliation complete",
            tracksAdded: result.tracksAdded,
            playlistsUpdated: result.playlistsUpdated,
        });
    } catch (error) {
        logger.error("Reconcile pending tracks error:", error);
        res.status(500).json({ error: "Failed to reconcile pending tracks" });
    }
});

export default router;
import { failDownloadJob } from "../services/downloadJobStatus";
