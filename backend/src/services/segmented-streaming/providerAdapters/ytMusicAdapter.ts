import { prisma } from "../../../utils/db";
import { decrypt } from "../../../utils/encryption";
import { getSystemSettings } from "../../../utils/systemSettings";
import { ytMusicService } from "../../youtubeMusic";
import {
    segmentedManifestService,
    type LocalDashAsset,
    type SegmentedManifestQuality,
} from "../manifestService";
import { SegmentedProviderAdapterError } from "./adapterError";

export interface CreateYtMusicSegmentedAssetInput {
    userId: string;
    videoId: string;
    quality: SegmentedManifestQuality;
}

export interface CreateYtMusicSegmentedAssetResult {
    providerTrackId: string;
    asset: LocalDashAsset;
}

class YtMusicSegmentedProviderAdapter {
    private readonly sidecarBaseUrl =
        process.env.YTMUSIC_STREAMER_URL || "http://127.0.0.1:8586";

    async getOrCreateDashAsset(
        input: CreateYtMusicSegmentedAssetInput,
    ): Promise<CreateYtMusicSegmentedAssetResult> {
        const normalizedVideoId = normalizeVideoId(input.videoId);

        await this.ensureUserOAuth(input.userId);

        try {
            await ytMusicService.getStreamInfo(input.userId, normalizedVideoId);
        } catch (error) {
            const status = getResponseStatus(error);
            if (status === 401) {
                throw new SegmentedProviderAdapterError(
                    "YouTube Music authentication is required",
                    401,
                    "YTMUSIC_AUTH_REQUIRED",
                );
            }

            if (status === 404) {
                throw new SegmentedProviderAdapterError(
                    "YouTube Music track was not found",
                    404,
                    "YTMUSIC_TRACK_NOT_FOUND",
                );
            }

            if (status === 451) {
                throw new SegmentedProviderAdapterError(
                    "YouTube Music track is age-restricted",
                    451,
                    "YTMUSIC_TRACK_AGE_RESTRICTED",
                );
            }

            throw new SegmentedProviderAdapterError(
                "YouTube Music stream metadata is unavailable",
                502,
                "YTMUSIC_STREAM_INFO_UNAVAILABLE",
            );
        }

        const sourceUrl = this.buildSidecarStreamUrl({
            userId: input.userId,
            videoId: normalizedVideoId,
        });

        const asset = await segmentedManifestService.getOrCreateLocalDashAsset({
            trackId: `ytmusic:${normalizedVideoId}`,
            sourcePath: sourceUrl,
            sourceModified: new Date(0),
            quality: input.quality,
            cacheIdentity: `ytmusic:${normalizedVideoId}`,
        });

        return {
            providerTrackId: normalizedVideoId,
            asset,
        };
    }

    private async ensureUserOAuth(userId: string): Promise<void> {
        try {
            const authStatus = await ytMusicService.getAuthStatus(userId);
            if (authStatus.authenticated) {
                return;
            }
        } catch {
            // Ignore status check failure and try restoring from persisted credentials.
        }

        const userSettings = await prisma.userSettings.findUnique({
            where: { userId },
            select: { ytMusicOAuthJson: true },
        });
        if (!userSettings?.ytMusicOAuthJson) {
            throw new SegmentedProviderAdapterError(
                "YouTube Music authentication is required",
                401,
                "YTMUSIC_AUTH_REQUIRED",
            );
        }

        const oauthJson = decodeStoredOAuth(userSettings.ytMusicOAuthJson);
        const systemSettings = await getSystemSettings();

        try {
            await ytMusicService.restoreOAuthWithCredentials(
                userId,
                oauthJson,
                systemSettings?.ytMusicClientId || undefined,
                systemSettings?.ytMusicClientSecret || undefined,
            );
        } catch {
            throw new SegmentedProviderAdapterError(
                "YouTube Music authentication could not be restored",
                401,
                "YTMUSIC_AUTH_RESTORE_FAILED",
            );
        }
    }

    private buildSidecarStreamUrl(params: {
        userId: string;
        videoId: string;
    }): string {
        const streamUrl = new URL(
            `/proxy/${encodeURIComponent(params.videoId)}`,
            this.sidecarBaseUrl,
        );
        streamUrl.searchParams.set("user_id", params.userId);
        return streamUrl.toString();
    }
}

const decodeStoredOAuth = (storedValue: string): string => {
    try {
        return decrypt(storedValue);
    } catch {
        return storedValue;
    }
};

const normalizeVideoId = (videoId: string): string => {
    const normalized = videoId?.trim();
    if (!normalized) {
        throw new SegmentedProviderAdapterError(
            "Invalid YouTube Music video id",
            400,
            "INVALID_YTMUSIC_VIDEO_ID",
        );
    }
    return normalized;
};

const getResponseStatus = (error: unknown): number | undefined => {
    if (!error || typeof error !== "object") {
        return undefined;
    }

    const maybeError = error as { response?: { status?: unknown } };
    return typeof maybeError.response?.status === "number"
        ? maybeError.response.status
        : undefined;
};

export const ytMusicSegmentedProviderAdapter =
    new YtMusicSegmentedProviderAdapter();
