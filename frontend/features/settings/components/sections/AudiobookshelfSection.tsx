"use client";

import {
    SettingsSection,
    SettingsRow,
    SettingsInput,
    SettingsToggle,
} from "../ui";
import { SystemSettings } from "../../types";
import { InlineStatus } from "@/components/ui/InlineStatus";
import { useConnectionTest } from "@/features/settings/hooks/useConnectionTest";

interface AudiobookshelfSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (
        service: string,
    ) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

/**
 * Renders the AudiobookshelfSection component.
 */
export function AudiobookshelfSection({
    settings,
    onUpdate,
    onTest,
    isTesting,
}: AudiobookshelfSectionProps) {
    const {
        status: testStatus,
        message: testMessage,
        runTest,
        reset,
    } = useConnectionTest<{
        success: boolean;
        error?: string;
        version?: string;
    }>({
        loadingMessage: "Testing...",
        successMessage: (result) =>
            result.version ? `v${result.version}` : "Connected",
        failureMessage: "Failed",
    });

    const handleTest = () => runTest(() => onTest("audiobookshelf"));

    return (
        <SettingsSection
            id="audiobookshelf"
            title="Media Servers"
            description="Connect to external media servers for audiobooks and podcasts"
        >
            <SettingsRow
                label="Enable Audiobookshelf"
                description="Connect for audiobooks and podcasts"
                htmlFor="abs-enabled"
            >
                <SettingsToggle
                    id="abs-enabled"
                    checked={settings.audiobookshelfEnabled}
                    onChange={(checked) =>
                        onUpdate({ audiobookshelfEnabled: checked })
                    }
                />
            </SettingsRow>

            {settings.audiobookshelfEnabled && (
                <>
                    <SettingsRow label="Server URL">
                        <SettingsInput
                            value={settings.audiobookshelfUrl}
                            onChange={(v) => onUpdate({ audiobookshelfUrl: v })}
                            placeholder="http://localhost:13378"
                            className="w-64"
                        />
                    </SettingsRow>

                    <SettingsRow label="API Key">
                        <SettingsInput
                            type="password"
                            value={settings.audiobookshelfApiKey}
                            onChange={(v) =>
                                onUpdate({ audiobookshelfApiKey: v })
                            }
                            placeholder="Enter API key"
                            className="w-64"
                        />
                    </SettingsRow>

                    <div className="pt-2">
                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleTest}
                                disabled={
                                    isTesting ||
                                    !settings.audiobookshelfUrl ||
                                    !settings.audiobookshelfApiKey
                                }
                                className="px-4 py-1.5 text-sm bg-white text-black font-medium rounded-full
                                    hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                            >
                                {testStatus === "loading"
                                    ? "Testing..."
                                    : "Test Connection"}
                            </button>
                            <InlineStatus
                                status={testStatus}
                                message={testMessage}
                                onClear={reset}
                            />
                        </div>
                    </div>
                </>
            )}
        </SettingsSection>
    );
}
