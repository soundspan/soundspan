"use client";

import { SettingsSection, SettingsRow, SettingsSelect } from "../ui";
import { SystemSettings } from "../../types";

const DEFAULT_ORDER = "library,peers,tidal,ytmusic";

const orderOptions = [
    {
        value: DEFAULT_ORDER,
        label: "Library → Peers → TIDAL → YT Music (Default)",
    },
    {
        value: "library,peers,ytmusic,tidal",
        label: "Library → Peers → YT Music → TIDAL",
    },
    {
        value: "library,tidal,ytmusic,peers",
        label: "Library → TIDAL → YT Music → Peers",
    },
    {
        value: "library,ytmusic,tidal,peers",
        label: "Library → YT Music → TIDAL → Peers",
    },
];

/** Returns the preset list, appending the stored value when it is custom. */
function resolveOrderOptions(stored: string) {
    if (orderOptions.some((option) => option.value === stored)) {
        return orderOptions;
    }
    return [...orderOptions, { value: stored, label: "Custom (current)" }];
}

interface PlaybackSourcesSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

/**
 * Renders the PlaybackSourcesSection component.
 */
export function PlaybackSourcesSection({
    settings,
    onUpdate,
}: PlaybackSourcesSectionProps) {
    const stored = settings.playbackSourceOrder || DEFAULT_ORDER;

    return (
        <SettingsSection
            id="playback-sources"
            title="Playback Sources"
            description="Where tracks play from when more than one source can provide them"
        >
            <SettingsRow
                label="Source priority"
                description="Your own library always wins when it has the track. This order decides what is tried next: connected peer libraries, TIDAL, or YT Music."
            >
                <SettingsSelect
                    value={stored}
                    onChange={(v) => onUpdate({ playbackSourceOrder: v })}
                    options={resolveOrderOptions(stored)}
                />
            </SettingsRow>
        </SettingsSection>
    );
}
