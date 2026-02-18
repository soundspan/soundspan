"use client";

import { SettingsSection, SettingsRow, SettingsSelect, InfoTooltip } from "../ui";
import { UserSettings } from "../../types";

interface PlaybackSectionProps {
    value: UserSettings["playbackQuality"];
    onChange: (quality: UserSettings["playbackQuality"]) => void;
}

const qualityOptions = [
    { value: "original", label: "Original (Lossless)" },
    { value: "high", label: "High (320 kbps)" },
    { value: "medium", label: "Medium (192 kbps)" },
    { value: "low", label: "Low (128 kbps)" },
];

export function PlaybackSection({ value, onChange }: PlaybackSectionProps) {
    return (
        <SettingsSection
            id="playback"
            title="Playback"
            titleExtra={
                <InfoTooltip text="Controls quality for local files streamed from your library. Integration streaming quality (YouTube Music, TIDAL) is configured per-service in the Integrations section." />
            }
        >
            <SettingsRow
                label="Streaming quality"
                description="Higher quality uses more bandwidth"
            >
                <SettingsSelect
                    value={value}
                    onChange={(v) => onChange(v as UserSettings["playbackQuality"])}
                    options={qualityOptions}
                />
            </SettingsRow>
        </SettingsSection>
    );
}

