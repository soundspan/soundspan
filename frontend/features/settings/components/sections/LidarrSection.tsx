"use client";

import { useState } from "react";
import { SettingsRow, SettingsInput, SettingsToggle, IntegrationCard } from "../ui";
import { SystemSettings } from "../../types";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { Download } from "lucide-react";

interface LidarrCardProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

export function LidarrCard({ settings, onUpdate, onTest, isTesting }: LidarrCardProps) {
    const [testStatus, setTestStatus] = useState<StatusType>("idle");
    const [testMessage, setTestMessage] = useState("");

    const handleTest = async () => {
        setTestStatus("loading");
        setTestMessage("Testing...");
        const result = await onTest("lidarr");
        if (result.success) {
            setTestStatus("success");
            setTestMessage(result.version ? `v${result.version}` : "Connected");
        } else {
            setTestStatus("error");
            setTestMessage(result.error || "Failed");
        }
    };

    const isConfigured = settings.lidarrEnabled && settings.lidarrUrl && settings.lidarrApiKey;

    const statusText = settings.lidarrEnabled
        ? isConfigured ? "Enabled" : "Enabled — needs configuration"
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
                            disabled={isTesting || !settings.lidarrUrl || !settings.lidarrApiKey}
                            className="px-4 py-1.5 text-sm bg-[#333] text-white rounded-full
                                hover:bg-[#404040] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {testStatus === "loading" ? "Testing..." : "Test Connection"}
                        </button>
                        <InlineStatus
                            status={testStatus}
                            message={testMessage}
                            onClear={() => setTestStatus("idle")}
                        />
                    </div>
                </div>
            </div>
        </IntegrationCard>
    );
}
