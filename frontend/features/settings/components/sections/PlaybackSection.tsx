"use client";

import {
    SettingsSection,
    SettingsRow,
    SettingsSelect,
    InfoTooltip,
} from "../ui";
import { UserSettings } from "../../types";

interface PlaybackSectionProps {
    value: UserSettings["playbackQuality"];
    onChange: (quality: UserSettings["playbackQuality"]) => void;
    loudnessMode: UserSettings["loudnessMode"];
    onLoudnessModeChange: (mode: UserSettings["loudnessMode"]) => void;
}

const qualityOptions = [
    { value: "original", label: "Original (Lossless)" },
    { value: "high", label: "High (320 kbps)" },
    { value: "medium", label: "Medium (192 kbps)" },
    { value: "low", label: "Low (128 kbps)" },
];

const loudnessOptions = [
    { value: "auto", label: "Automatic (recommended)" },
    { value: "track", label: "By track" },
    { value: "album", label: "By album" },
    { value: "off", label: "Off" },
];

/**
 * Renders the PlaybackSection component.
 */
export function PlaybackSection({
    value,
    onChange,
    loudnessMode,
    onLoudnessModeChange,
}: PlaybackSectionProps) {
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
                    onChange={(v) =>
                        onChange(v as UserSettings["playbackQuality"])
                    }
                    options={qualityOptions}
                />
            </SettingsRow>
            <SettingsRow
                label="Volume leveling"
                description="Evens out volume differences between songs. Automatic keeps albums sounding the way they were mastered and levels everything else per song."
            >
                <SettingsSelect
                    value={loudnessMode}
                    onChange={(v) =>
                        onLoudnessModeChange(v as UserSettings["loudnessMode"])
                    }
                    options={loudnessOptions}
                />
            </SettingsRow>
        </SettingsSection>
    );
}
