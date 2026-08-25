"use client";

import {
    SettingsRow,
    SettingsInput,
    SettingsToggle,
    IntegrationCard,
} from "../ui";
import { SystemSettings } from "../../types";
import { InlineStatus } from "@/components/ui/InlineStatus";
import { Download } from "lucide-react";
import { useConnectionTest } from "@/features/settings/hooks/useConnectionTest";

interface LidarrCardProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (
        service: string,
    ) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

/**
 * Renders the LidarrCard component.
 */
export function LidarrCard({
    settings,
    onUpdate,
    onTest,
    isTesting,
}: LidarrCardProps) {
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

    const handleTest = () => runTest(() => onTest("lidarr"));

    const isConfigured =
        settings.lidarrEnabled && settings.lidarrUrl && settings.lidarrApiKey;

    const statusText = settings.lidarrEnabled
        ? isConfigured
            ? "Enabled"
            : "Enabled — needs configuration"
        : "Disabled";

    const statusColor: "green" | "gray" = isConfigured ? "green" : "gray";

    return (
        <IntegrationCard
            icon={<Download className="w-5 h-5 text-blue-400" />}
            title="Lidarr"
            statusText={statusText}
            statusColor={statusColor}
            connected={false}
            expanded={settings.lidarrEnabled}
            headerAction={
                <SettingsToggle
                    id="lidarr-enabled"
                    checked={settings.lidarrEnabled}
                    onChange={(checked) => onUpdate({ lidarrEnabled: checked })}
                />
            }
        >
            <div className="space-y-1">
                <SettingsRow label="Lidarr URL">
                    <SettingsInput
                        value={settings.lidarrUrl}
                        onChange={(v) => onUpdate({ lidarrUrl: v })}
                        placeholder="http://localhost:8686"
                        className="w-64"
                    />
                </SettingsRow>

                <SettingsRow label="API Key">
                    <SettingsInput
                        type="password"
                        value={settings.lidarrApiKey}
                        onChange={(v) => onUpdate({ lidarrApiKey: v })}
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
                                !settings.lidarrUrl ||
                                !settings.lidarrApiKey
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
            </div>
        </IntegrationCard>
    );
}
