"use client";

import { SettingsSection } from "../ui";
import { SystemSettings } from "../../types";
import { LidarrCard } from "./LidarrSection";
import { SoulseekCard } from "./SoulseekSection";
import { TidalCard } from "./TidalSection";

interface DownloadServicesSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<{ success: boolean; version?: string; error?: string }>;
    testingServices: Record<string, boolean>;
}

export function DownloadServicesSection({
    settings,
    onUpdate,
    onTest,
    testingServices,
}: DownloadServicesSectionProps) {
    return (
        <SettingsSection
            id="download-services"
            title="Download Services"
            description="Configure services for downloading music"
        >
            <div className="space-y-3">
                <LidarrCard
                    settings={settings}
                    onUpdate={onUpdate}
                    onTest={onTest}
                    isTesting={testingServices.lidarr || false}
                />
                <SoulseekCard
                    settings={settings}
                    onUpdate={onUpdate}
                    onTest={onTest}
                    isTesting={testingServices.slskd || false}
                />
                <TidalCard
                    settings={settings}
                    onUpdate={onUpdate}
                    onTest={onTest}
                    isTesting={testingServices.tidal || false}
                />
            </div>
        </SettingsSection>
    );
}
