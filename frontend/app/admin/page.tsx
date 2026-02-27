"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useAuth } from "@/lib/auth-context";
import { createFrontendLogger } from "@/lib/logger";
import { RestartModal } from "@/components/ui/RestartModal";
import { useSystemSettings } from "@/features/settings/hooks/useSystemSettings";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { InlineStatus, useInlineStatus } from "@/components/ui/InlineStatus";
import {
    SettingsLayout,
    SidebarItem
} from "@/features/settings/components/ui";

const sidebarItems: SidebarItem[] = [
    { id: "download-preferences", label: "Download Preferences" },
    { id: "download-services", label: "Download Services" },
    { id: "audiobookshelf", label: "Media Servers" },
    { id: "youtube-music-admin", label: "YouTube Music" },
    { id: "ai-services", label: "Artwork" },
    { id: "storage", label: "Storage" },
    { id: "library-safety", label: "Library Safety" },
    { id: "cache", label: "Cache & Automation" },
    { id: "users", label: "Users" },
];

function renderSectionFallback() {
    return (
        <div className="flex items-center justify-center py-8">
            <GradientSpinner size="sm" />
        </div>
    );
}

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

const logger = createFrontendLogger("Admin.Page");

export default function AdminPage() {
    const { isAuthenticated, isLoading: authLoading, user } = useAuth();
    const router = useRouter();
    const [isSaving, setIsSaving] = useState(false);
    const [showRestartModal, setShowRestartModal] = useState(false);
    const [testingServices, setTestingServices] = useState<Record<string, boolean>>({});
    const saveStatus = useInlineStatus();

    const isAdmin = user?.role === "admin";

    const {
        systemSettings,
        isLoading: systemSettingsLoading,
        changedServices,
        updateSystemSettings,
        saveSystemSettings,
        testService,
        loadError: systemSettingsLoadError,
        loadSystemSettings,
    } = useSystemSettings();

    // Redirect non-admins to /settings
    useEffect(() => {
        if (!authLoading && isAuthenticated && !isAdmin) {
            router.replace("/settings");
        }
    }, [authLoading, isAuthenticated, isAdmin, router]);

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
        if (!systemSettings) return;

        setIsSaving(true);
        saveStatus.setLoading();

        try {
            const changedSystemServices = await saveSystemSettings(systemSettings) || [];
            setIsSaving(false);
            saveStatus.setSuccess("Saved");
            if (changedSystemServices.length > 0) {
                setShowRestartModal(true);
            }
        } catch (error) {
            logger.error("Failed to save system settings from admin page", { error });
            setIsSaving(false);
            saveStatus.setError("Failed to save");
        }
    }, [systemSettings, saveSystemSettings, saveStatus]);

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

    if (!isAuthenticated || !isAdmin) {
        return null;
    }

    if (systemSettingsLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (systemSettingsLoadError || !systemSettings) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-[#0a0a0a] gap-4 px-4">
                <p className="text-red-400 text-sm text-center">
                    Failed to load settings from the server. Settings cannot be edited until they are loaded.
                </p>
                <button
                    onClick={() => loadSystemSettings()}
                    className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white text-sm rounded-full transition-colors"
                >
                    Retry
                </button>
            </div>
        );
    }

    return (
        <>
            <SettingsLayout sidebarItems={sidebarItems} isAdmin={true} title="Admin">
                <DownloadPreferencesSection
                    settings={systemSettings}
                    onUpdate={updateSystemSettings}
                />

                <DownloadServicesSection
                    settings={systemSettings}
                    onUpdate={updateSystemSettings}
                    onTest={handleTestService}
                    testingServices={testingServices}
                />

                <AudiobookshelfSection
                    settings={systemSettings}
                    onUpdate={updateSystemSettings}
                    onTest={handleTestService}
                    isTesting={testingServices.audiobookshelf || false}
                />

                <YouTubeMusicAdminSection
                    settings={systemSettings}
                    onUpdate={updateSystemSettings}
                />

                <AIServicesSection
                    settings={systemSettings}
                    onUpdate={updateSystemSettings}
                    onTest={handleTestService}
                    isTesting={testingServices.openai || testingServices.fanart || false}
                />

                <StoragePathsSection
                    settings={systemSettings}
                    onUpdate={updateSystemSettings}
                    onTest={handleTestService}
                    isTesting={false}
                />

                <LibrarySafetySection
                    settings={systemSettings}
                    onUpdate={updateSystemSettings}
                />

                <CacheSection
                    settings={systemSettings}
                    onUpdate={updateSystemSettings}
                />

                <UserManagementSection />

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
                        <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 bg-[#0a0a0a]/90 backdrop-blur-sm px-3 py-0.5 rounded-full">
                            <InlineStatus {...saveStatus.props} />
                        </div>
                    </div>
                </div>
            </SettingsLayout>

            <RestartModal
                isOpen={showRestartModal}
                onClose={() => setShowRestartModal(false)}
                changedServices={changedServices}
            />
        </>
    );
}
