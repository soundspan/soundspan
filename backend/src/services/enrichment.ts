import { prisma } from "../utils/db";
import {
    applyAlbumEnrichmentFields,
    enrichAlbumFields,
    type AlbumEnrichmentData,
} from "./metadata/albumEnrichmentFields";
import {
    applyArtistEnrichmentFields,
    enrichArtistFields,
    type ArtistEnrichmentData,
} from "./metadata/artistEnrichmentFields";

export type { AlbumEnrichmentData, ArtistEnrichmentData };

/** Persisted per-user controls for manual metadata enrichment. */
export interface EnrichmentSettings {
    enabled: boolean;
    autoEnrichOnScan: boolean;
    sources: {
        musicbrainz: boolean;
        lastfm: boolean;
        coverArtArchive: boolean;
    };
    rateLimit: {
        maxRequestsPerMinute: number;
        respectApiLimits: boolean;
    };
    overwriteExisting: boolean;
    matchingConfidence: "strict" | "moderate" | "loose";
}

const DEFAULT_SETTINGS: EnrichmentSettings = {
    enabled: false,
    autoEnrichOnScan: false,
    sources: {
        musicbrainz: true,
        lastfm: true,
        coverArtArchive: true,
    },
    rateLimit: {
        maxRequestsPerMinute: 30,
        respectApiLimits: true,
    },
    overwriteExisting: false,
    matchingConfidence: "moderate",
};

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
}

function parsedSettings(value: unknown): Record<string, unknown> {
    if (typeof value !== "string") return asRecord(value);
    return asRecord(JSON.parse(value) as unknown);
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function numberSetting(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : fallback;
}

function matchingConfidence(
    value: unknown,
): EnrichmentSettings["matchingConfidence"] {
    return value === "strict" || value === "loose" || value === "moderate"
        ? value
        : DEFAULT_SETTINGS.matchingConfidence;
}

function mergedSources(value: unknown): EnrichmentSettings["sources"] {
    const sources = asRecord(value);
    return {
        musicbrainz: booleanSetting(
            sources.musicbrainz,
            DEFAULT_SETTINGS.sources.musicbrainz,
        ),
        lastfm: booleanSetting(sources.lastfm, DEFAULT_SETTINGS.sources.lastfm),
        coverArtArchive: booleanSetting(
            sources.coverArtArchive,
            DEFAULT_SETTINGS.sources.coverArtArchive,
        ),
    };
}

function mergedRateLimit(value: unknown): EnrichmentSettings["rateLimit"] {
    const rateLimit = asRecord(value);
    return {
        maxRequestsPerMinute: numberSetting(
            rateLimit.maxRequestsPerMinute,
            DEFAULT_SETTINGS.rateLimit.maxRequestsPerMinute,
        ),
        respectApiLimits: booleanSetting(
            rateLimit.respectApiLimits,
            DEFAULT_SETTINGS.rateLimit.respectApiLimits,
        ),
    };
}

function mergeSettings(value: unknown): EnrichmentSettings {
    const settings = parsedSettings(value);
    return {
        enabled: booleanSetting(settings.enabled, DEFAULT_SETTINGS.enabled),
        autoEnrichOnScan: booleanSetting(
            settings.autoEnrichOnScan,
            DEFAULT_SETTINGS.autoEnrichOnScan,
        ),
        sources: mergedSources(settings.sources),
        rateLimit: mergedRateLimit(settings.rateLimit),
        overwriteExisting: booleanSetting(
            settings.overwriteExisting,
            DEFAULT_SETTINGS.overwriteExisting,
        ),
        matchingConfidence: matchingConfidence(settings.matchingConfidence),
    };
}

function applySettingsPatch(
    current: EnrichmentSettings,
    patch: Partial<EnrichmentSettings>,
): EnrichmentSettings {
    return mergeSettings({
        ...current,
        ...patch,
        sources: { ...current.sources, ...patch.sources },
        rateLimit: { ...current.rateLimit, ...patch.rateLimit },
    });
}

/** Compatibility facade for settings and shared metadata field modules. */
export class EnrichmentService {
    /** Return per-user enrichment settings merged with stable defaults. */
    async getSettings(userId: string): Promise<EnrichmentSettings> {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { enrichmentSettings: true },
        });
        return user?.enrichmentSettings
            ? mergeSettings(user.enrichmentSettings)
            : { ...DEFAULT_SETTINGS };
    }

    /** Persist a partial settings update after merging current values. */
    async updateSettings(
        userId: string,
        settings: Partial<EnrichmentSettings>,
    ): Promise<EnrichmentSettings> {
        const current = await this.getSettings(userId);
        const updated = applySettingsPatch(current, settings);
        await prisma.user.update({
            where: { id: userId },
            data: { enrichmentSettings: JSON.stringify(updated) },
        });
        return updated;
    }

    /** Delegate artist resolution to the shared worker-owned field rules. */
    async enrichArtist(
        artistId: string,
        settings: EnrichmentSettings = DEFAULT_SETTINGS,
    ): Promise<ArtistEnrichmentData | null> {
        return settings.enabled ? enrichArtistFields(artistId) : null;
    }

    /** Delegate artist persistence to the shared worker-owned field rules. */
    async applyArtistEnrichment(
        artistId: string,
        data: ArtistEnrichmentData,
    ): Promise<void> {
        await applyArtistEnrichmentFields(artistId, data);
    }

    /** Delegate album resolution to the scheduled-worker field rules. */
    async enrichAlbum(
        albumId: string,
        settings: EnrichmentSettings = DEFAULT_SETTINGS,
    ): Promise<AlbumEnrichmentData | null> {
        return settings.enabled ? enrichAlbumFields(albumId) : null;
    }

    /** Delegate album persistence to the scheduled-worker field rules. */
    async applyAlbumEnrichment(
        albumId: string,
        data: AlbumEnrichmentData,
    ): Promise<void> {
        await applyAlbumEnrichmentFields(albumId, data);
    }
}

export const enrichmentService = new EnrichmentService();
