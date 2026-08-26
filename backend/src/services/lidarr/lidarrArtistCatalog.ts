import { logger } from "../../utils/logger";
import type { LidarrAlbum, LidarrArtist } from "./lidarrTypes";

const CATALOG_POLL_ATTEMPTS = 20;
const CATALOG_POLL_DELAY_MS = 3_000;
const REFRESH_DELAY_MS = 5_000;

interface CatalogClient {
    get(path: string): Promise<{ data: LidarrAlbum[] }>;
    post(path: string, data: unknown): Promise<unknown>;
}

/** Injectable delay boundary for Lidarr catalog polling. */
export interface LidarrCatalogClock {
    sleep(delayMs: number): Promise<void>;
}

interface AwaitArtistCatalogOptions {
    client: CatalogClient;
    artist: LidarrArtist;
    justAddedArtist: boolean;
    clock: LidarrCatalogClock;
}

interface EnsureArtistPresentOptions {
    artists: LidarrArtist[];
    artistMbid?: string;
    artistName: string;
    rootFolderPath: string;
    isDiscovery: boolean;
    addArtist: (
        mbid: string,
        artistName: string,
        rootFolderPath: string,
        searchForMissingAlbums: boolean,
        monitorAllAlbums: boolean,
        isDiscovery: boolean,
    ) => Promise<LidarrArtist | null>;
    ensureDiscoveryTag: (artist: LidarrArtist) => Promise<void>;
}

/** Finds an existing artist or creates it through Lidarr's race-safe add path. */
export async function ensureArtistPresent(
    options: EnsureArtistPresentOptions,
): Promise<{ artist: LidarrArtist | null; justAddedArtist: boolean }> {
    const existing = options.artists.find(
        (artist) =>
            options.artistMbid && artist.foreignArtistId === options.artistMbid,
    );
    if (existing) {
        if (options.isDiscovery) await options.ensureDiscoveryTag(existing);
        return { artist: existing, justAddedArtist: false };
    }
    if (!options.artistMbid) {
        return { artist: null, justAddedArtist: false };
    }
    const artist = await options.addArtist(
        options.artistMbid,
        options.artistName,
        options.rootFolderPath,
        false,
        false,
        options.isDiscovery,
    );
    return { artist, justAddedArtist: artist !== null };
}

async function pollNewArtistCatalog(
    options: AwaitArtistCatalogOptions,
): Promise<LidarrAlbum[]> {
    for (let attempt = 1; attempt <= CATALOG_POLL_ATTEMPTS; attempt += 1) {
        await options.clock.sleep(CATALOG_POLL_DELAY_MS);
        const response = await options.client.get(
            `/api/v1/album?artistId=${options.artist.id}`,
        );
        if (response.data.length > 0) {
            logger.debug(`   Albums loaded after ${attempt * 3}s`);
            return response.data;
        }
        if (attempt < CATALOG_POLL_ATTEMPTS) {
            logger.debug(
                `   Attempt ${attempt}/${CATALOG_POLL_ATTEMPTS}: Still waiting...`,
            );
        }
    }
    logger.warn(
        ` Timeout reached after 60s - artist catalog may still be populating`,
    );
    return [];
}

async function refreshExistingArtistCatalog(
    options: AwaitArtistCatalogOptions,
): Promise<LidarrAlbum[]> {
    try {
        await options.client.post("/api/v1/command", {
            name: "RefreshArtist",
            artistId: options.artist.id,
        });
        await options.clock.sleep(REFRESH_DELAY_MS);
        const response = await options.client.get(
            `/api/v1/album?artistId=${options.artist.id}`,
        );
        return response.data;
    } catch {
        logger.warn("   Metadata refresh failed");
        return [];
    }
}

/** Loads an artist catalog with bounded, injectable polling. */
export async function awaitArtistCatalog(
    options: AwaitArtistCatalogOptions,
): Promise<LidarrAlbum[]> {
    const response = await options.client.get(
        `/api/v1/album?artistId=${options.artist.id}`,
    );
    if (response.data.length > 0) return response.data;
    if (options.justAddedArtist) return pollNewArtistCatalog(options);
    return refreshExistingArtistCatalog(options);
}
