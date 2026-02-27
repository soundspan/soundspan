import { SettingsSection, SettingsRow, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";

interface LibrarySafetySectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

export function LibrarySafetySection({
    settings,
    onUpdate,
}: LibrarySafetySectionProps) {
    return (
        <SettingsSection
            id="library-safety"
            title="Library Safety"
            description="Guardrails for destructive library actions."
        >
            <SettingsRow
                label="Allow library deletion"
                description="When disabled, deleting tracks/albums/artists is blocked server-side and delete buttons are hidden in Library."
                htmlFor="library-deletion-enabled"
            >
                <SettingsToggle
                    id="library-deletion-enabled"
                    checked={settings.libraryDeletionEnabled}
                    onChange={(checked) =>
                        onUpdate({ libraryDeletionEnabled: checked })
                    }
                />
            </SettingsRow>
            <SettingsRow
                label="Show version"
                description="Display the app version in the bottom-right corner of the player bar."
                htmlFor="show-version"
            >
                <SettingsToggle
                    id="show-version"
                    checked={settings.showVersion}
                    onChange={(checked) =>
                        onUpdate({ showVersion: checked })
                    }
                />
            </SettingsRow>
        </SettingsSection>
    );
}
