import { BRAND_SLUG } from "../../config/brand";
import { logger } from "../../utils/logger";
import {
    lidarrErrorLogFields,
    type LidarrHttpClient,
} from "./lidarrHttpClient";
import type { LidarrArtist, LidarrTag } from "./lidarrTypes";

const DISCOVERY_TAG_LABEL = `${BRAND_SLUG}-discovery`;

interface LidarrTagServiceDependencies {
    getClient: () => LidarrHttpClient | null;
    isEnabled: () => boolean;
    getTags: () => Promise<LidarrTag[]>;
    createTag: (label: string) => Promise<LidarrTag | null>;
    getArtists: () => Promise<LidarrArtist[]>;
    getArtistsByTag: (tagId: number) => Promise<LidarrArtist[]>;
    getDiscoveryTagId: () => Promise<number | null>;
    removeTagsFromArtist: (
        artistId: number,
        tagIds: number[],
    ) => Promise<boolean>;
}

/** Owns Lidarr discovery-tag CRUD and artist-tag association behavior. */
export class LidarrTagService {
    private discoveryTagId: number | null = null;

    constructor(private readonly dependencies: LidarrTagServiceDependencies) {}

    get cachedDiscoveryTagId(): number | null {
        return this.discoveryTagId;
    }

    set cachedDiscoveryTagId(value: number | null) {
        this.discoveryTagId = value;
    }

    async getTags(): Promise<LidarrTag[]> {
        const client = this.availableClient();
        if (!client) return [];
        try {
            const response = await client.get<LidarrTag[]>("/api/v1/tag");
            return response.data || [];
        } catch (error: unknown) {
            logger.error(
                "[LIDARR] Failed to get tags:",
                lidarrErrorLogFields(error),
            );
            return [];
        }
    }

    async createTag(label: string): Promise<LidarrTag | null> {
        const client = this.availableClient();
        if (!client) return null;
        try {
            const response = await client.post<LidarrTag>("/api/v1/tag", {
                label,
            });
            logger.debug(
                `[LIDARR] Created tag: ${label} (ID: ${response.data.id})`,
            );
            return response.data;
        } catch (error: unknown) {
            logger.error(
                "[LIDARR] Failed to create tag:",
                lidarrErrorLogFields(error),
            );
            return null;
        }
    }

    async getOrCreateDiscoveryTag(): Promise<number | null> {
        if (!this.availableClient()) return null;
        if (this.discoveryTagId !== null) return this.discoveryTagId;
        try {
            const tags = await this.dependencies.getTags();
            const existing = tags.find(
                (tag) => tag.label === DISCOVERY_TAG_LABEL,
            );
            if (existing) {
                this.discoveryTagId = existing.id;
                return existing.id;
            }
            const created =
                await this.dependencies.createTag(DISCOVERY_TAG_LABEL);
            this.discoveryTagId = created?.id ?? null;
            return this.discoveryTagId;
        } catch (error: unknown) {
            logger.error(
                "[LIDARR] Failed to get/create discovery tag:",
                lidarrErrorLogFields(error),
            );
            return null;
        }
    }

    async addTagsToArtist(
        artistId: number,
        tagIds: number[],
    ): Promise<boolean> {
        return this.updateArtistTags(artistId, (existing) => [
            ...new Set([...existing, ...tagIds]),
        ]);
    }

    async removeTagsFromArtist(
        artistId: number,
        tagIds: number[],
    ): Promise<boolean> {
        return this.updateArtistTags(artistId, (existing) =>
            existing.filter((tagId) => !tagIds.includes(tagId)),
        );
    }

    async getArtistsByTag(tagId: number): Promise<LidarrArtist[]> {
        const client = this.availableClient();
        if (!client) return [];
        try {
            const response = await client.get<LidarrArtist[]>("/api/v1/artist");
            return response.data.filter((artist) =>
                artist.tags?.includes(tagId),
            );
        } catch (error: unknown) {
            logger.error(
                "[LIDARR] Failed to get artists by tag:",
                lidarrErrorLogFields(error),
            );
            return [];
        }
    }

    async getDiscoveryArtists(): Promise<LidarrArtist[]> {
        const tagId = await this.dependencies.getDiscoveryTagId();
        return tagId ? this.dependencies.getArtistsByTag(tagId) : [];
    }

    async removeDiscoveryTagByMbid(artistMbid: string): Promise<boolean> {
        if (!this.availableClient()) return false;
        try {
            const tagId = await this.dependencies.getDiscoveryTagId();
            if (!tagId) return false;
            const artist = (await this.dependencies.getArtists()).find(
                (candidate) => candidate.foreignArtistId === artistMbid,
            );
            if (!artist || !artist.tags?.includes(tagId)) return true;
            return this.dependencies.removeTagsFromArtist(artist.id, [tagId]);
        } catch (error: unknown) {
            logger.error(
                "[LIDARR] Failed to remove discovery tag:",
                lidarrErrorLogFields(error),
            );
            return false;
        }
    }

    private availableClient(): LidarrHttpClient | null {
        return this.dependencies.isEnabled()
            ? this.dependencies.getClient()
            : null;
    }

    private async updateArtistTags(
        artistId: number,
        update: (existing: number[]) => number[],
    ): Promise<boolean> {
        const client = this.availableClient();
        if (!client) return false;
        try {
            const response = await client.get<LidarrArtist>(
                `/api/v1/artist/${artistId}`,
            );
            await client.put(`/api/v1/artist/${artistId}`, {
                ...response.data,
                tags: update(response.data.tags || []),
            });
            return true;
        } catch (error: unknown) {
            logger.error(
                "[LIDARR] Failed to update artist tags:",
                lidarrErrorLogFields(error),
            );
            return false;
        }
    }
}
