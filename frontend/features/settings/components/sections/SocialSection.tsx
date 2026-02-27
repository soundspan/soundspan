"use client";

import { SettingsSection, SettingsRow, SettingsToggle } from "../ui";
import { ProfilePictureUpload } from "../ui/ProfilePictureUpload";
import { UserSettings } from "../../types";

interface SocialSectionProps {
    settings: UserSettings;
    onUpdate: (updates: Partial<UserSettings>) => void;
    onReloadSettings?: () => void;
}

export function SocialSection({ settings, onUpdate, onReloadSettings }: SocialSectionProps) {
    return (
        <SettingsSection id="social" title="Social">
            <SettingsRow
                label="Profile picture"
                description="Upload a profile picture (max 512x512, JPEG/PNG/WebP)"
                align="start"
            >
                <ProfilePictureUpload
                    hasProfilePicture={settings.hasProfilePicture}
                    onChanged={onReloadSettings}
                />
            </SettingsRow>

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
