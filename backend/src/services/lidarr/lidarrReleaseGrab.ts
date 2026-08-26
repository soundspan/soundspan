import { logger } from "../../utils/logger";
import type { LidarrHttpClient } from "./lidarrHttpClient";
import { selectBaseAlbumInCatalog } from "./lidarrAlbumSelection";
import type { LidarrAlbum, LidarrArtist } from "./lidarrTypes";

const EDITION_PATTERNS = [
    /\(remaster/i,
    /\(deluxe/i,
    /\(expanded/i,
    /\(anniversary/i,
    /\(bonus/i,
    /\(special/i,
    /\(limited/i,
    /\(collector/i,
    /\(super deluxe/i,
    /\(platinum/i,
    /\(japan/i,
    /\(uk/i,
    /\(us/i,
    /\(import/i,
    /\[remaster/i,
    /\[deluxe/i,
];

interface CommandResult {
    status: string;
    message: string;
}

interface GrabReleaseOptions {
    client: LidarrHttpClient;
    artist: LidarrArtist;
    album: LidarrAlbum;
    artistAlbums: LidarrAlbum[];
    requestedTitle: string;
    sleep: (delayMs: number) => Promise<void>;
    waitForCommand: (
        commandId: number,
        timeoutMs: number,
    ) => Promise<CommandResult>;
    createNoReleasesError: () => Error;
    indexerCountLogged: () => boolean;
    markIndexerCountLogged: () => void;
    extractBaseTitle: (title: string) => string;
}

async function monitorArtist(
    client: LidarrHttpClient,
    artist: LidarrArtist,
): Promise<void> {
    if (artist.monitored) return;
    await client.put(`/api/v1/artist/${artist.id}`, {
        ...artist,
        monitored: true,
    });
}

async function monitorAlbum(
    client: LidarrHttpClient,
    album: LidarrAlbum,
): Promise<LidarrAlbum> {
    const fullResponse = await client.get<LidarrAlbum>(
        `/api/v1/album/${album.id}`,
    );
    const fullAlbum = fullResponse.data;
    await client.put(`/api/v1/album/${fullAlbum.id}`, {
        ...fullAlbum,
        monitored: true,
    });
    const verifyResponse = await client.get<LidarrAlbum>(
        `/api/v1/album/${fullAlbum.id}`,
    );
    if (!verifyResponse.data.monitored) {
        logger.error(" CRITICAL: Album monitoring failed to persist!", {
            albumId: fullAlbum.id,
            title: fullAlbum.title,
            monitored: verifyResponse.data.monitored,
            status: verifyResponse.status,
        });
    }
    return verifyResponse.data;
}

async function enableEditionReleaseMatching(
    client: LidarrHttpClient,
    album: LidarrAlbum,
    requestedTitle: string,
): Promise<void> {
    const isEdition = EDITION_PATTERNS.some(
        (pattern) => pattern.test(requestedTitle) || pattern.test(album.title),
    );
    if (!isEdition || album.anyReleaseOk) return;
    await client.put(`/api/v1/album/${album.id}`, {
        ...album,
        anyReleaseOk: true,
    });
    album.anyReleaseOk = true;
}

async function refreshMissingReleases(
    options: GrabReleaseOptions,
    album: LidarrAlbum,
): Promise<void> {
    if ((album.releases?.length || 0) > 0) return;
    logger.warn(" Album has 0 releases - refreshing artist metadata...");
    await options.client.post("/api/v1/command", {
        name: "RefreshArtist",
        artistId: options.artist.id,
    });
    await options.sleep(5_000);
    const response = await options.client.get<LidarrAlbum>(
        `/api/v1/album/${album.id}`,
    );
    if ((response.data.releases?.length || 0) === 0) {
        logger.warn(" Still no releases after refresh!");
        logger.warn("   Download will be attempted but may fail.");
    }
}

async function prepareAlbum(options: GrabReleaseOptions): Promise<LidarrAlbum> {
    await monitorArtist(options.client, options.artist);
    const album = await monitorAlbum(options.client, options.album);
    await enableEditionReleaseMatching(
        options.client,
        album,
        options.requestedTitle,
    );
    await refreshMissingReleases(options, album);
    return album;
}

async function dispatchAlbumSearch(
    options: GrabReleaseOptions,
    albumId: number,
): Promise<number> {
    const response = await options.client.post<{ id: number }>(
        "/api/v1/command",
        { name: "AlbumSearch", albumIds: [albumId] },
    );
    return response.data.id;
}

async function waitForAlbumSearch(
    options: GrabReleaseOptions,
    commandId: number,
): Promise<CommandResult | null> {
    try {
        return await options.waitForCommand(commandId, 30_000);
    } catch (error: unknown) {
        if (error instanceof Error && error.message.includes("timed out")) {
            return null;
        }
        throw error;
    }
}

async function logIndexerDiagnostics(
    options: GrabReleaseOptions,
    album: LidarrAlbum,
): Promise<void> {
    try {
        const details = await options.client.get<LidarrAlbum>(
            `/api/v1/album/${album.id}`,
        );
        logger.debug(
            `   [DIAGNOSTIC] Album "${album.title}" has ${details.data.releases?.length || 0} releases defined in Lidarr`,
        );
        if (options.indexerCountLogged()) return;
        const indexers =
            await options.client.get<
                Array<{ enableRss?: boolean; enableAutomaticSearch?: boolean }>
            >("/api/v1/indexer");
        const enabled = indexers.data.filter(
            (indexer) => indexer.enableRss || indexer.enableAutomaticSearch,
        );
        logger.debug(
            `   [DIAGNOSTIC] ${enabled.length} enabled indexers configured in Lidarr`,
        );
        if (enabled.length === 0) {
            logger.error(
                "   [DIAGNOSTIC] No enabled indexers - Lidarr cannot search for releases",
            );
        }
        options.markIndexerCountLogged();
    } catch {
        // Diagnostics must not affect acquisition control flow.
    }
}

async function grabBaseAlbum(
    options: GrabReleaseOptions,
    updatedAlbum: LidarrAlbum,
): Promise<LidarrAlbum | null> {
    const base = selectBaseAlbumInCatalog(
        options.artistAlbums,
        options.requestedTitle,
        options.extractBaseTitle(options.requestedTitle),
    );
    if (!base || base.id === updatedAlbum.id) return null;
    await options.client.put(`/api/v1/album/${base.id}`, {
        ...base,
        monitored: true,
        anyReleaseOk: true,
    });
    const commandId = await dispatchAlbumSearch(options, base.id);
    const result = await waitForAlbumSearch(options, commandId);
    if (!result) return base;
    if (result.message?.includes("0 reports")) {
        logger.warn(`   Base album "${base.title}" also has no releases`);
        throw new Error(
            `No releases available for "${options.requestedTitle}" or base album "${base.title}" - check indexer configuration and album availability`,
        );
    }
    return base;
}

async function retryWithAnyRelease(
    options: GrabReleaseOptions,
    album: LidarrAlbum,
): Promise<LidarrAlbum> {
    await options.client.put(`/api/v1/album/${album.id}`, {
        ...album,
        anyReleaseOk: true,
    });
    const commandId = await dispatchAlbumSearch(options, album.id);
    const retry = await waitForAlbumSearch(options, commandId);
    if (!retry) return album;
    if (!retry.message?.includes("0 reports")) return album;
    const base = await grabBaseAlbum(options, album);
    if (base) return base;
    throw options.createNoReleasesError();
}

/** Prepares the selected catalog album and starts Lidarr release acquisition. */
export async function grabRelease(
    options: GrabReleaseOptions,
): Promise<LidarrAlbum> {
    const album = await prepareAlbum(options);
    const commandId = await dispatchAlbumSearch(options, album.id);
    const result = await waitForAlbumSearch(options, commandId);
    if (!result) return album;
    if (!result.message?.includes("0 reports")) return album;
    await logIndexerDiagnostics(options, album);
    if (album.anyReleaseOk) {
        throw new Error(
            "No releases available - indexers found no matching downloads",
        );
    }
    return retryWithAnyRelease(options, album);
}
