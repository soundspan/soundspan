"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { RestartModal } from "@/components/ui/RestartModal";
import { useSettingsData } from "@/features/settings/hooks/useSettingsData";
import { useSystemSettings } from "@/features/settings/hooks/useSystemSettings";
import { shouldShowSettingsPageLoading } from "@/features/settings/hooks/settingsHydration";
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
    { id: "download-preferences", label: "Download Preferences", adminOnly: true },
    { id: "download-services", label: "Download Services", adminOnly: true },
    { id: "audiobookshelf", label: "Media Servers", adminOnly: true },
    { id: "youtube-music-admin", label: "YouTube Music (Admin)", adminOnly: true },
    { id: "ai-services", label: "Artwork", adminOnly: true },
    { id: "storage", label: "Storage", adminOnly: true },
    { id: "library-safety", label: "Library Safety", adminOnly: true },
    { id: "cache", label: "Cache & Automation", adminOnly: true },
    { id: "users", label: "Users", adminOnly: true },
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

const DownloadPreferencesSection = dynamic(
    () =>
        import(
            "@/features/settings/components/sections/DownloadPreferencesSection"
        ).then((mod) => mod.DownloadPreferencesSection),
    { loading: renderSectionFallback }
);

const DownloadServicesSection = dynamic(
    () =>
        import(
            "@/features/settings/components/sections/DownloadServicesSection"
        ).then((mod) => mod.DownloadServicesSection),
    { loading: renderSectionFallback }
);

const AudiobookshelfSection = dynamic(
    () =>
        import(
            "@/features/settings/components/sections/AudiobookshelfSection"
        ).then((mod) => mod.AudiobookshelfSection),
    { loading: renderSectionFallback }
);

const YouTubeMusicAdminSection = dynamic(
    () =>
        import("@/features/settings/components/sections/YouTubeMusicSection").then(
            (mod) => mod.YouTubeMusicAdminSection
        ),
    { loading: renderSectionFallback }
);

const AIServicesSection = dynamic(
    () =>
        import("@/features/settings/components/sections/AIServicesSection").then(
            (mod) => mod.AIServicesSection
        ),
    { loading: renderSectionFallback }
);

const StoragePathsSection = dynamic(
    () =>
        import("@/features/settings/components/sections/StoragePathsSection").then(
            (mod) => mod.StoragePathsSection
        ),
    { loading: renderSectionFallback }
);

const LibrarySafetySection = dynamic(
    () =>
        import("@/features/settings/components/sections/LibrarySafetySection").then(
            (mod) => mod.LibrarySafetySection
        ),
    { loading: renderSectionFallback }
);

const CacheSection = dynamic(
    () =>
        import("@/features/settings/components/sections/CacheSection").then(
            (mod) => mod.CacheSection
        ),
    { loading: renderSectionFallback }
);

const UserManagementSection = dynamic(
    () =>
        import(
            "@/features/settings/components/sections/UserManagementSection"
        ).then((mod) => mod.UserManagementSection),
    { loading: renderSectionFallback }
);

export default function SettingsPage() {
    const { isAuthenticated, isLoading: authLoading, user } = useAuth();
    useSearchParams();
    const [isSaving, setIsSaving] = useState(false);
    const [showRestartModal, setShowRestartModal] = useState(false);
    const [testingServices, setTestingServices] = useState<Record<string, boolean>>({});
    const saveStatus = useInlineStatus();

    const isAdmin = user?.role === "admin";

    // User settings hook
    const {
        settings: userSettings,
        isLoading: userSettingsLoading,
        updateSettings: updateUserSettings,
        saveSettings: saveUserSettings,
    } = useSettingsData();

    // System settings hook (only used if admin)
    const {
        systemSettings,
        isLoading: systemSettingsLoading,
        changedServices,
        updateSystemSettings,
        saveSystemSettings,
        testService,
    } = useSystemSettings();

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

    // Unified save function
    const handleSaveAll = useCallback(async () => {
        setIsSaving(true);
        saveStatus.setLoading();
        let hasError = false;
        let changedSystemServices: string[] = [];

        try {
            await saveUserSettings(userSettings);
        } catch (error) {
            console.error("Failed to save user settings:", error);
            hasError = true;
        }

        if (isAdmin) {
            try {
                changedSystemServices = await saveSystemSettings(systemSettings) || [];
            } catch (error) {
                console.error("Failed to save system settings:", error);
                hasError = true;
            }
        }

        setIsSaving(false);

        if (hasError) {
            saveStatus.setError("Failed to save");
        } else {
            saveStatus.setSuccess("Saved");
            if (changedSystemServices.length > 0) {
                setShowRestartModal(true);
            }
        }
    }, [userSettings, systemSettings, isAdmin, saveUserSettings, saveSystemSettings, saveStatus]);

    // Test service wrapper
    const handleTestService = useCallback(async (service: string) => {
        setTestingServices(prev => ({ ...prev, [service]: true }));
        try {
            return await testService(service);
        } finally {
            setTestingServices(prev => ({ ...prev, [service]: false }));
        }
    }, [testService]);

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

    if (
        shouldShowSettingsPageLoading({
            authLoading,
            isAuthenticated,
            isUserSettingsLoading: userSettingsLoading,
            isAdmin,
            isSystemSettingsLoading: systemSettingsLoading,
        })
    ) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    return (
        <>
            <SettingsLayout sidebarItems={sidebarItems} isAdmin={isAdmin}>
                {/* Account (includes Subsonic app password) */}
                <AccountSection
                    settings={userSettings}
                    onUpdate={updateUserSettings}
                />

                {/* Social */}
                <SocialSection
                    settings={userSettings}
                    onUpdate={updateUserSettings}
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

                {/* Admin-only sections */}
                {isAdmin && (
                    <>
                        {/* Download Preferences */}
                        <DownloadPreferencesSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                        />

                        {/* Download Services — Lidarr, Soulseek, TIDAL */}
                        <DownloadServicesSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            testingServices={testingServices}
                        />

                        {/* Media Servers - Audiobookshelf */}
                        <AudiobookshelfSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.audiobookshelf || false}
                        />

                        {/* YouTube Music Admin Toggle */}
                        <YouTubeMusicAdminSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                        />

                        {/* AI Services */}
                        <AIServicesSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.openai || testingServices.fanart || false}
                        />

                        {/* Storage */}
                        <StoragePathsSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={false}
                        />

                        {/* Library Safety */}
                        <LibrarySafetySection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                        />

                        {/* Cache & Automation */}
                        <CacheSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                        />

                        {/* User Management */}
                        <UserManagementSection />
                    </>
                )}

                {/* Save Button - Fixed at bottom */}
                <div className="sticky bottom-0 pt-8 pb-8 bg-[#0a0a0a]">
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
                        <div className="absolute -bottom-6 left-1/2 -translate-x-1/2">
                            <InlineStatus {...saveStatus.props} />
                        </div>
                    </div>
                </div>
            </SettingsLayout>

            {/* Restart Modal */}
            <RestartModal
                isOpen={showRestartModal}
                onClose={() => setShowRestartModal(false)}
                changedServices={changedServices}
            />
        </>
    );
}
