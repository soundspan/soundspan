"use client";

import { useEffect } from "react";
import { SettingsSection, SettingsRow, SettingsSelect } from "../ui";
import { DownloadFallback, DownloadSource, SystemSettings } from "../../types";
import {
    countConfiguredSources,
    getConfiguredSources,
    getFallbackOptions,
    getSourceOptions,
    pickAutoSource,
} from "./downloadSourceConfig";

interface DownloadPreferencesSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

/**
 * Renders the DownloadPreferencesSection component.
 */
export function DownloadPreferencesSection({
    settings,
    onUpdate,
}: DownloadPreferencesSectionProps) {
    const configured = getConfiguredSources(settings);
    const configuredCount = countConfiguredSources(configured);
    const isDisabled = configuredCount === 0;
    const autoSource = pickAutoSource(configured);

    // Auto-select the only configured service as the download source
    useEffect(() => {
        if (autoSource !== null && settings.downloadSource !== autoSource) {
            onUpdate({ downloadSource: autoSource });
        }
    }, [autoSource, settings.downloadSource, onUpdate]);

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
                            downloadSource: v as DownloadSource,
                            primaryFailureFallback: "none",
                        })
                    }
                    options={getSourceOptions(configured)}
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
                            primaryFailureFallback: v as DownloadFallback,
                        })
                    }
                    options={getFallbackOptions(
                        configured,
                        settings.downloadSource,
                    )}
                    disabled={isDisabled}
                />
            </SettingsRow>

            <SettingsRow
                label="Soulseek Concurrent Downloads"
                description="Number of simultaneous downloads when using Soulseek (1-10)"
            >
                <SettingsSelect
                    value={
                        settings.soulseekConcurrentDownloads?.toString() || "4"
                    }
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
                    disabled={!configured.soulseek}
                />
            </SettingsRow>
        </SettingsSection>
    );
}
