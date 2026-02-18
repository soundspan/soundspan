"use client";

import { useEffect } from "react";
import { SettingsSection, SettingsRow, SettingsSelect } from "../ui";
import { SystemSettings } from "../../types";

interface DownloadPreferencesSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

export function DownloadPreferencesSection({
    settings,
    onUpdate,
}: DownloadPreferencesSectionProps) {
    // Service configuration detection
    const isLidarrConfigured =
        settings.lidarrEnabled === true &&
        settings.lidarrUrl.trim() !== "" &&
        settings.lidarrApiKey.trim() !== "";

    const isSoulseekConfigured =
        settings.soulseekUsername.trim() !== "" &&
        settings.soulseekPassword.trim() !== "";

    const isTidalConfigured =
        settings.tidalEnabled === true &&
        !!settings.tidalUserId;

    const configuredCount = [isLidarrConfigured, isSoulseekConfigured, isTidalConfigured].filter(Boolean).length;
    const isDisabled = configuredCount === 0;

    // Auto-select the only configured service as the download source
    useEffect(() => {
        if (configuredCount === 1) {
            const autoSource = isTidalConfigured
                ? "tidal"
                : isLidarrConfigured
                    ? "lidarr"
                    : "soulseek";
            if (settings.downloadSource !== autoSource) {
                onUpdate({ downloadSource: autoSource as "soulseek" | "lidarr" | "tidal" });
            }
        }
    }, [configuredCount, isTidalConfigured, isLidarrConfigured, isSoulseekConfigured, settings.downloadSource, onUpdate]);

    // Build primary source options based on what's configured
    const getSourceOptions = () => {
        const options = [];
        if (isSoulseekConfigured) options.push({ value: "soulseek", label: "Soulseek (Per-track)" });
        if (isLidarrConfigured) options.push({ value: "lidarr", label: "Lidarr (Full albums)" });
        if (isTidalConfigured) options.push({ value: "tidal", label: "TIDAL (Per-track / album)" });
        if (options.length === 0) {
            options.push({ value: "soulseek", label: "Soulseek (Per-track)" });
        }
        return options;
    };

    // Dynamic fallback options based on primary source
    const getFallbackOptions = () => {
        const options = [{ value: "none", label: "Skip" }];
        if (settings.downloadSource !== "soulseek" && isSoulseekConfigured) {
            options.push({ value: "soulseek", label: "Try Soulseek" });
        }
        if (settings.downloadSource !== "lidarr" && isLidarrConfigured) {
            options.push({ value: "lidarr", label: "Try Lidarr" });
        }
        if (settings.downloadSource !== "tidal" && isTidalConfigured) {
            options.push({ value: "tidal", label: "Try TIDAL" });
        }
        return options;
    };

    return (
        <SettingsSection
            id="download-preferences"
            title="Download Preferences"
            description="Configure how music is downloaded for playlists and discovery"
        >
            <SettingsRow
                label="Primary Download Source"
                description={
                    isDisabled
                        ? "Requires at least one download service to be configured"
                        : "Choose how to download music for imported playlists"
                }
            >
                <SettingsSelect
                    value={settings.downloadSource || "soulseek"}
                    onChange={(v) =>
                        onUpdate({
                            downloadSource: v as "soulseek" | "lidarr" | "tidal",
                            primaryFailureFallback: "none"
                        })
                    }
                    options={getSourceOptions()}
                    disabled={isDisabled}
                />
            </SettingsRow>

            <SettingsRow
                label="When Primary Source Fails"
                description={
                    isDisabled
                        ? "Requires at least one download service to be configured"
                        : "What to do if a download fails with the primary source"
                }
            >
                <SettingsSelect
                    value={settings.primaryFailureFallback || "none"}
                    onChange={(v) =>
                        onUpdate({
                            primaryFailureFallback: v as "none" | "lidarr" | "soulseek" | "tidal",
                        })
                    }
                    options={getFallbackOptions()}
                    disabled={isDisabled}
                />
            </SettingsRow>

            <SettingsRow
                label="Soulseek Concurrent Downloads"
                description="Number of simultaneous downloads when using Soulseek (1-10)"
            >
                <SettingsSelect
                    value={settings.soulseekConcurrentDownloads?.toString() || "4"}
                    onChange={(v) =>
                        onUpdate({
                            soulseekConcurrentDownloads: parseInt(v),
                        })
                    }
                    options={[
                        { value: "1", label: "1" },
                        { value: "2", label: "2" },
                        { value: "3", label: "3" },
                        { value: "4", label: "4 (Default)" },
                        { value: "5", label: "5" },
                        { value: "6", label: "6" },
                        { value: "7", label: "7" },
                        { value: "8", label: "8" },
                        { value: "9", label: "9" },
                        { value: "10", label: "10" },
                    ]}
                    disabled={!isSoulseekConfigured}
                />
            </SettingsRow>
        </SettingsSection>
    );
}
