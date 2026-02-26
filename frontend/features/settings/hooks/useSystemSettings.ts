import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { createFrontendLogger } from "@/lib/logger";
import { SystemSettings } from "../types";
import { shouldRetryFailedSettingsLoad } from "./settingsHydration";

const logger = createFrontendLogger("Settings.useSystemSettings");

const defaultSystemSettings: SystemSettings = {
    lidarrEnabled: true,
    lidarrUrl: "http://localhost:8686",
    lidarrApiKey: "",
    openaiEnabled: false,
    openaiApiKey: "",
    openaiModel: "gpt-4",
    fanartEnabled: false,
    fanartApiKey: "",
    lastfmApiKey: "",
    audiobookshelfEnabled: false,
    audiobookshelfUrl: "http://localhost:13378",
    audiobookshelfApiKey: "",
    soulseekUsername: "",
    soulseekPassword: "",
    spotifyClientId: "",
    spotifyClientSecret: "",
    tidalEnabled: false,
    tidalAccessToken: "",
    tidalRefreshToken: "",
    tidalUserId: "",
    tidalCountryCode: "US",
    tidalQuality: "HIGH",
    tidalFileTemplate: "{album.artist}/{album.title}/{item.number:02d}. {item.title}",
    musicPath: "/music",
    downloadPath: "/downloads",
    transcodeCacheMaxGb: 10,
    maxCacheSizeMb: 10240,
    autoSync: true,
    autoEnrichMetadata: true,
    libraryDeletionEnabled: true,
    audioAnalyzerWorkers: 2,
    soulseekConcurrentDownloads: 4,
    // Download preferences
    downloadSource: "soulseek",
    primaryFailureFallback: "none",
    // YouTube Music streaming
    ytMusicEnabled: false,
    ytMusicClientId: "",
    ytMusicClientSecret: "",
};

export function useSystemSettings() {
    const { isAuthenticated, user } = useAuth();
    const [systemSettings, setSystemSettings] = useState<SystemSettings>(
        defaultSystemSettings
    );
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [changedServices, setChangedServices] = useState<string[]>([]);
    const [originalSettings, setOriginalSettings] = useState<SystemSettings>(
        defaultSystemSettings
    );
    const [loadError, setLoadError] = useState(false);
    const lastLoadAttemptAtRef = useRef(0);

    const isAdmin = user?.role === "admin";

    const loadSystemSettings = useCallback(async (options?: { background?: boolean }) => {
        const isBackground = options?.background === true;
        try {
            lastLoadAttemptAtRef.current = Date.now();
            if (!isBackground) {
                setIsLoading(true);
            }
            const [sysData, userData] = await Promise.all([
                api.getSystemSettings(),
                api.getSettings(),
            ]);

            // Sanitize null values to empty strings for controlled inputs
            const sanitizeSettings = (settings: Record<string, unknown>): SystemSettings => {
                const sanitized: Record<string, unknown> = {};
                for (const key in settings) {
                    const value = settings[key];
                    // Convert null to empty string for string fields
                    if (value === null && typeof defaultSystemSettings[key as keyof SystemSettings] === 'string') {
                        sanitized[key] = '';
                    } else {
                        sanitized[key] = value;
                    }
                }
                return sanitized as unknown as SystemSettings;
            };

            const combinedSettings = {
                ...sanitizeSettings(sysData),
                maxCacheSizeMb: userData.maxCacheSizeMb,
            };

            setSystemSettings(combinedSettings);
            setOriginalSettings(combinedSettings);
            setLoadError(false);
        } catch (error) {
            logger.error("Failed to load system settings", { error });
            setLoadError(true);
        } finally {
            if (!isBackground) {
                setIsLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated && isAdmin) {
            void loadSystemSettings();
            return;
        }
        setIsLoading(false);
        setLoadError(false);
    }, [isAuthenticated, isAdmin, loadSystemSettings]);

    useEffect(() => {
        if (!isAuthenticated || !isAdmin) return;
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
                void loadSystemSettings({ background: true });
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
    }, [isAuthenticated, isAdmin, loadError, loadSystemSettings]);

    const saveSystemSettings = async (settingsToSave: SystemSettings, _showToast = false) => {
        try {
            setIsSaving(true);

            // Save system settings
            await api.updateSystemSettings(settingsToSave);

            // Also save user cache setting
            await api.updateSettings({
                maxCacheSizeMb: settingsToSave.maxCacheSizeMb,
            });

            // Determine which services changed
            const changed: string[] = [];
            if (
                originalSettings.lidarrEnabled !==
                    settingsToSave.lidarrEnabled ||
                originalSettings.lidarrUrl !== settingsToSave.lidarrUrl ||
                originalSettings.lidarrApiKey !== settingsToSave.lidarrApiKey
            ) {
                changed.push("Lidarr");
            }
            if (
                originalSettings.soulseekUsername !== settingsToSave.soulseekUsername ||
                originalSettings.soulseekPassword !== settingsToSave.soulseekPassword
            ) {
                changed.push("Soulseek");
            }
            if (
                originalSettings.audiobookshelfEnabled !==
                    settingsToSave.audiobookshelfEnabled ||
                originalSettings.audiobookshelfUrl !==
                    settingsToSave.audiobookshelfUrl ||
                originalSettings.audiobookshelfApiKey !==
                    settingsToSave.audiobookshelfApiKey
            ) {
                changed.push("Audiobookshelf");
            }
            if (
                originalSettings.tidalEnabled !== settingsToSave.tidalEnabled
            ) {
                changed.push("TIDAL");
            }

            setChangedServices(changed);
            setOriginalSettings(settingsToSave);

            return changed; // Return changed services
        } catch (error) {
            logger.error("Failed to save system settings", { error });
            throw error; // Caller handles the error display
        } finally {
            setIsSaving(false);
        }
    };

    const updateSystemSettings = (updates: Partial<SystemSettings>) => {
        setSystemSettings((prev) => ({ ...prev, ...updates }));
    };

    /**
     * Test a service connection
     * Returns { success: true, version?: string } or { success: false, error: string }
     * Caller handles displaying the result inline
     */
    const testService = async (service: string): Promise<{ success: boolean; version?: string; error?: string }> => {
        try {
            let result;
            switch (service) {
                case "lidarr":
                    result = await api.testLidarr(
                        systemSettings.lidarrUrl,
                        systemSettings.lidarrApiKey
                    );
                    break;
                case "openai":
                    result = await api.testOpenai(
                        systemSettings.openaiApiKey,
                        systemSettings.openaiModel
                    );
                    break;
                case "fanart":
                    result = await api.testFanart(systemSettings.fanartApiKey);
                    break;
                case "lastfm":
                    result = await api.testLastfm(systemSettings.lastfmApiKey);
                    break;
                case "audiobookshelf":
                    result = await api.testAudiobookshelf(
                        systemSettings.audiobookshelfUrl,
                        systemSettings.audiobookshelfApiKey
                    );
                    break;
                case "soulseek":
                    result = await api.testSoulseek(
                        systemSettings.soulseekUsername,
                        systemSettings.soulseekPassword
                    );
                    break;
                case "spotify":
                    result = await api.testSpotify(
                        systemSettings.spotifyClientId,
                        systemSettings.spotifyClientSecret
                    );
                    break;
                case "tidal":
                    result = await api.testTidal();
                    break;
                default:
                    throw new Error(`Unknown service: ${service}`);
            }

            return { success: true, version: result?.version };
        } catch (error: unknown) {
            logger.error("Failed to test service", { service, error });
            return { success: false, error: error instanceof Error ? error.message : `Failed to connect` };
        }
    };

    return {
        systemSettings,
        isLoading,
        isSaving,
        changedServices,
        setSystemSettings,
        updateSystemSettings,
        saveSystemSettings,
        testService,
        loadSystemSettings,
        loadError,
    };
}
