import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { createFrontendLogger } from "@/lib/logger";
import { UserSettings } from "../types";
import { shouldRetryFailedSettingsLoad } from "./settingsHydration";

const logger = createFrontendLogger("Settings.useSettingsData");

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
    const [loadError, setLoadError] = useState(false);
    const lastLoadAttemptAtRef = useRef(0);

    const loadSettings = useCallback(async (options?: { background?: boolean }) => {
        const isBackground = options?.background === true;
        try {
            lastLoadAttemptAtRef.current = Date.now();
            if (!isBackground) {
                setIsLoading(true);
            }
            const data = await api.getSettings();
            setSettings({
                ...data,
                displayName: data.displayName ?? "",
                shareOnlinePresence: data.shareOnlinePresence ?? false,
                shareListeningStatus: data.shareListeningStatus ?? false,
            });
            setLoadError(false);
        } catch (error) {
            logger.error("Failed to load user settings", { error });
            setLoadError(true);
        } finally {
            if (!isBackground) {
                setIsLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated) {
            void loadSettings();
            return;
        }
        setIsLoading(false);
        setLoadError(false);
    }, [isAuthenticated, loadSettings]);

    useEffect(() => {
        if (!isAuthenticated) return;
        if (typeof window === "undefined" || typeof document === "undefined") {
            return;
        }

        const maybeRetryLoad = () => {
            if (document.hidden) return;
            if (
                shouldRetryFailedSettingsLoad(
                    loadError,
                    lastLoadAttemptAtRef.current
                )
            ) {
                void loadSettings({ background: true });
            }
        };

        window.addEventListener("focus", maybeRetryLoad);
        window.addEventListener("online", maybeRetryLoad);
        document.addEventListener("visibilitychange", maybeRetryLoad);

        return () => {
            window.removeEventListener("focus", maybeRetryLoad);
            window.removeEventListener("online", maybeRetryLoad);
            document.removeEventListener("visibilitychange", maybeRetryLoad);
        };
    }, [isAuthenticated, loadError, loadSettings]);

    const saveSettings = async (newSettings: UserSettings) => {
        try {
            setIsSaving(true);
            await api.updateSettings(newSettings);
            setSettings(newSettings);
            // No toast - caller shows inline status
        } catch (error) {
            logger.error("Failed to save user settings", { error });
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
        loadError,
    };
}
