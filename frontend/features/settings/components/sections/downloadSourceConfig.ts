import { DownloadSource, SystemSettings } from "../../types";

/** Per-source "is this service usable as a download source" flags. */
export interface ConfiguredSources {
    soulseek: boolean;
    lidarr: boolean;
    tidal: boolean;
    youtube: boolean;
}

export interface SourceOption {
    value: string;
    label: string;
}

/** Display order and labels for the primary-source dropdown. */
const SOURCE_LABELS: Array<{ value: DownloadSource; label: string }> = [
    { value: "soulseek", label: "Soulseek (Per-track)" },
    { value: "lidarr", label: "Lidarr (Full albums)" },
    { value: "tidal", label: "TIDAL (Per-track / album)" },
    { value: "youtube", label: "YouTube Music (Albums)" },
];

const FALLBACK_LABELS: Record<DownloadSource, string> = {
    soulseek: "Try Soulseek",
    lidarr: "Try Lidarr",
    tidal: "Try TIDAL",
    youtube: "Try YouTube Music",
};

type SourceSettings = Pick<
    SystemSettings,
    | "lidarrEnabled"
    | "lidarrUrl"
    | "lidarrApiKey"
    | "soulseekUsername"
    | "soulseekPassword"
    | "tidalEnabled"
    | "tidalConnected"
    | "ytMusicEnabled"
>;

/**
 * Derives which download services are configured from system settings.
 */
export function getConfiguredSources(
    settings: SourceSettings,
): ConfiguredSources {
    return {
        soulseek:
            settings.soulseekUsername.trim() !== "" &&
            settings.soulseekPassword.trim() !== "",
        lidarr:
            settings.lidarrEnabled === true &&
            settings.lidarrUrl.trim() !== "" &&
            settings.lidarrApiKey.trim() !== "",
        tidal:
            settings.tidalEnabled === true && settings.tidalConnected === true,
        youtube: settings.ytMusicEnabled === true,
    };
}

/**
 * Counts how many download services are configured.
 */
export function countConfiguredSources(configured: ConfiguredSources): number {
    return Object.values(configured).filter(Boolean).length;
}

/**
 * Returns the only configured source when exactly one is configured,
 * otherwise null (no auto-selection with zero or multiple choices).
 */
export function pickAutoSource(
    configured: ConfiguredSources,
): DownloadSource | null {
    const active = SOURCE_LABELS.filter((s) => configured[s.value]);
    if (active.length !== 1) {
        return null;
    }
    return active[0].value;
}

/**
 * Builds the primary-source dropdown options from configured services.
 * Falls back to a lone Soulseek entry when nothing is configured so the
 * disabled select still renders a stable value.
 */
export function getSourceOptions(
    configured: ConfiguredSources,
): SourceOption[] {
    const options = SOURCE_LABELS.filter((s) => configured[s.value]).map(
        ({ value, label }) => ({ value, label }),
    );
    if (options.length === 0) {
        return [{ value: "soulseek", label: "Soulseek (Per-track)" }];
    }
    return options;
}

/**
 * Builds the "when primary fails" dropdown options: Skip plus every
 * configured source other than the current primary.
 */
export function getFallbackOptions(
    configured: ConfiguredSources,
    downloadSource: DownloadSource | undefined,
): SourceOption[] {
    const options: SourceOption[] = [{ value: "none", label: "Skip" }];
    for (const { value } of SOURCE_LABELS) {
        if (downloadSource !== value && configured[value]) {
            options.push({ value, label: FALLBACK_LABELS[value] });
        }
    }
    return options;
}
