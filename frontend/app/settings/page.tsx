"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { createFrontendLogger } from "@/lib/logger";
import { useSettingsData } from "@/features/settings/hooks/useSettingsData";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { InlineStatus, useInlineStatus } from "@/components/ui/InlineStatus";
import {
    SettingsLayout,
    SidebarItem
} from "@/features/settings/components/ui";

// Section components
import { AccountSection } from "@/features/settings/components/sections/AccountSection";
import { SocialSection } from "@/features/settings/components/sections/SocialSection";
import { PlaybackSection } from "@/features/settings/components/sections/PlaybackSection";
import { IntegrationsSection } from "@/features/settings/components/sections/IntegrationsSection";

// Define sidebar items
const sidebarItems: SidebarItem[] = [
    { id: "account", label: "Account" },
    { id: "social", label: "Social" },
    { id: "history", label: "History & Personalization" },
    { id: "playback", label: "Playback" },
    { id: "integrations", label: "Integrations" },
    { id: "api-keys", label: "API Keys" },
];

function renderSectionFallback() {
    return (
        <div className="flex items-center justify-center py-8">
            <GradientSpinner size="sm" />
        </div>
    );
}

const PlaybackHistorySection = dynamic(
    () =>
        import(
            "@/features/settings/components/sections/PlaybackHistorySection"
        ).then((mod) => mod.PlaybackHistorySection),
    { loading: renderSectionFallback }
);

const APIKeysSection = dynamic(
    () =>
        import(
            "@/features/settings/components/sections/APIKeysSection"
        ).then((mod) => mod.APIKeysSection),
    { loading: renderSectionFallback }
);

const logger = createFrontendLogger("Settings.Page");

export default function SettingsPage() {
    const { isAuthenticated, isLoading: authLoading } = useAuth();
    useSearchParams();
    const [isSaving, setIsSaving] = useState(false);
    const saveStatus = useInlineStatus();

    // User settings hook
    const {
        settings: userSettings,
        isLoading: userSettingsLoading,
        updateSettings: updateUserSettings,
        saveSettings: saveUserSettings,
        loadSettings: reloadUserSettings,
    } = useSettingsData();

    // Handle initial hash for section scrolling
    useEffect(() => {
        if (typeof window !== "undefined") {
            const hash = window.location.hash.substring(1);
            if (hash) {
                setTimeout(() => {
                    const element = document.getElementById(hash);
                    if (element) {
                        element.scrollIntoView({ behavior: "smooth", block: "start" });
                    }
                }, 100);
            }
        }
    }, []);

    const handleSaveAll = useCallback(async () => {
        setIsSaving(true);
        saveStatus.setLoading();

        try {
            await saveUserSettings(userSettings);
            setIsSaving(false);
            saveStatus.setSuccess("Saved");
        } catch (error) {
            logger.error("Failed to save user settings from settings page", { error });
            setIsSaving(false);
            saveStatus.setError("Failed to save");
        }
    }, [userSettings, saveUserSettings, saveStatus]);

    if (authLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!isAuthenticated) {
        return null;
    }

    if (userSettingsLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    return (
        <SettingsLayout sidebarItems={sidebarItems} isAdmin={false}>
            {/* Account (includes Subsonic app password) */}
            <AccountSection
                settings={userSettings}
                onUpdate={updateUserSettings}
            />

            {/* Social */}
            <SocialSection
                settings={userSettings}
                onUpdate={updateUserSettings}
                onReloadSettings={() => reloadUserSettings({ background: true })}
            />

            {/* History & Personalization */}
            <PlaybackHistorySection />

            {/* Playback */}
            <PlaybackSection
                value={userSettings.playbackQuality}
                onChange={(quality) => updateUserSettings({ playbackQuality: quality })}
            />

            {/* Integrations (YouTube Music + TIDAL — visible to all users) */}
            <IntegrationsSection
                settings={userSettings}
                onUpdate={updateUserSettings}
            />

            {/* API Keys */}
            <APIKeysSection />

            {/* Save Button - Fixed at bottom */}
            <div className="sticky bottom-0 pt-8 pb-8">
                <div className="relative">
                    <button
                        onClick={handleSaveAll}
                        disabled={isSaving}
                        className="w-full bg-white text-black font-semibold py-3 px-4 rounded-full
                            hover:scale-[1.02] active:scale-[0.98] transition-transform
                            disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                    >
                        {isSaving ? "Saving..." : "Save"}
                    </button>
                    {/* Status appears below button, absolutely positioned */}
                    <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 bg-[#0a0a0a]/90 backdrop-blur-sm px-3 py-0.5 rounded-full">
                        <InlineStatus {...saveStatus.props} />
                    </div>
                </div>
            </div>
        </SettingsLayout>
    );
}
