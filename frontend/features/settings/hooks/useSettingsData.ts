import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { UserSettings } from "../types";

const defaultSettings: UserSettings = {
    displayName: "",
    playbackQuality: "original",
    shareOnlinePresence: false,
    shareListeningStatus: false,
    wifiOnly: false,
    offlineEnabled: false,
    maxCacheSizeMb: 5120,
    ytMusicQuality: "HIGH",
    tidalStreamingQuality: "HIGH",
};

export function useSettingsData() {
    const { isAuthenticated } = useAuth();
    const [settings, setSettings] = useState<UserSettings>(defaultSettings);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (isAuthenticated) {
            loadSettings();
        }
    }, [isAuthenticated]);

    const loadSettings = async () => {
        try {
            setIsLoading(true);
            const data = await api.getSettings();
            setSettings({
                ...data,
                displayName: data.displayName ?? "",
                shareOnlinePresence: data.shareOnlinePresence ?? false,
                shareListeningStatus: data.shareListeningStatus ?? false,
            });
        } catch (error) {
            console.error("Failed to load settings:", error);
            // No toast - error visible in UI if settings fail to load
        } finally {
            setIsLoading(false);
        }
    };

    const saveSettings = async (newSettings: UserSettings) => {
        try {
            setIsSaving(true);
            await api.updateSettings(newSettings);
            setSettings(newSettings);
            // No toast - caller shows inline status
        } catch (error) {
            console.error("Failed to save settings:", error);
            throw error; // Re-throw so caller can show inline error
        } finally {
            setIsSaving(false);
        }
    };

    const updateSettings = (updates: Partial<UserSettings>) => {
        setSettings((prev) => ({ ...prev, ...updates }));
    };

    return {
        settings,
        isLoading,
        isSaving,
        setSettings,
        updateSettings,
        saveSettings,
        loadSettings,
    };
}
