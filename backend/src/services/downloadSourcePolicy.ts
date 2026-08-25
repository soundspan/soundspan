/** Supported sources for library album downloads. */
import { lidarrService } from "./lidarr";
import { soulseekService } from "./soulseek";
import { tidalService } from "./tidal";
import { youtubeDownloadService } from "./youtubeDownload";

export type DownloadSource = "tidal" | "lidarr" | "soulseek" | "youtube";

/** Health snapshot used by the pure source-resolution policy. */
export type DownloadSourceAvailability = Record<DownloadSource, boolean>;

/** Result of resolving a configured source and fallback preference. */
export type DownloadSourceResolution =
    | { kind: "dispatch"; source: DownloadSource }
    | { kind: "fail"; statusText: string; error: string };

interface DownloadSourcePolicyInput {
    configuredSource: DownloadSource;
    fallback: string | null | undefined;
    availability: DownloadSourceAvailability;
}

const LEGACY_FALLBACK_ORDER: Record<DownloadSource, DownloadSource[]> = {
    tidal: ["soulseek", "lidarr", "youtube"],
    soulseek: ["tidal", "lidarr", "youtube"],
    lidarr: ["tidal", "soulseek", "youtube"],
    youtube: ["tidal", "soulseek", "lidarr"],
};

/** Probe every supported album-download source concurrently. */
export async function probeDownloadSourceAvailability(): Promise<DownloadSourceAvailability> {
    const [tidal, lidarr, soulseek, youtube] = await Promise.all([
        tidalService.isAvailable(),
        lidarrService.isEnabled(),
        soulseekService.isAvailable(),
        youtubeDownloadService.isAvailable(),
    ]);
    return { tidal, lidarr, soulseek, youtube };
}

function isDownloadSource(value: unknown): value is DownloadSource {
    return (
        value === "tidal" ||
        value === "lidarr" ||
        value === "soulseek" ||
        value === "youtube"
    );
}

function unavailablePrimary(
    source: DownloadSource,
    selfFallback: boolean,
): DownloadSourceResolution {
    const error = selfFallback
        ? `${source} is unavailable and the configured fallback is also ${source}`
        : `${source} is unavailable and "When primary source fails" is set to Skip`;
    return {
        kind: "fail",
        error,
        statusText: `${source} unavailable — skipped`,
    };
}

function unavailableFallback(
    source: DownloadSource,
    fallback: DownloadSource,
): DownloadSourceResolution {
    return {
        kind: "fail",
        error: `${source} is unavailable and the configured fallback (${fallback}) is also unavailable`,
        statusText: `${source} and fallback ${fallback} unavailable`,
    };
}

function resolveLegacyFallback(
    source: DownloadSource,
    availability: DownloadSourceAvailability,
): DownloadSource {
    return (
        LEGACY_FALLBACK_ORDER[source].find(
            (candidate) => availability[candidate],
        ) ?? source
    );
}

/** Resolve the source without performing settings, health, or persistence I/O. */
export function resolveDownloadSource({
    configuredSource,
    fallback,
    availability,
}: DownloadSourcePolicyInput): DownloadSourceResolution {
    if (availability[configuredSource]) {
        return { kind: "dispatch", source: configuredSource };
    }
    if (fallback === "none" || fallback === configuredSource) {
        return unavailablePrimary(
            configuredSource,
            fallback === configuredSource,
        );
    }
    if (isDownloadSource(fallback)) {
        return availability[fallback]
            ? { kind: "dispatch", source: fallback }
            : unavailableFallback(configuredSource, fallback);
    }
    return {
        kind: "dispatch",
        source: resolveLegacyFallback(configuredSource, availability),
    };
}
