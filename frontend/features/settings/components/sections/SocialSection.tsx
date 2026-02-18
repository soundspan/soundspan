"use client";

import { SettingsSection, SettingsRow, SettingsToggle } from "../ui";
import { UserSettings } from "../../types";

interface SocialSectionProps {
    settings: UserSettings;
    onUpdate: (updates: Partial<UserSettings>) => void;
}

export function SocialSection({ settings, onUpdate }: SocialSectionProps) {
    return (
        <SettingsSection id="social" title="Social">
            <SettingsRow
                label="Share online presence"
                description="Allow your account to appear in the Activity Social tab while you are online."
            >
                <SettingsToggle
                    id="share-online-presence"
                    checked={settings.shareOnlinePresence}
                    onChange={(checked) =>
                        onUpdate({ shareOnlinePresence: checked })
                    }
                />
            </SettingsRow>

            <SettingsRow
                label="Share listening status"
                description="Allow your current track to be shown in the Activity Social tab while online."
            >
                <SettingsToggle
                    id="share-listening-status"
                    checked={settings.shareListeningStatus}
                    onChange={(checked) =>
                        onUpdate({ shareListeningStatus: checked })
                    }
                />
            </SettingsRow>
        </SettingsSection>
    );
}
