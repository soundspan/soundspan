/**
 * Settings Types
 * Centralized type definitions for the settings feature
 */

export type Tab = "user" | "account" | "system";

export interface UserSettings {
    displayName?: string | null;
    hasProfilePicture?: boolean;
    playbackQuality: "original" | "high" | "medium" | "low";
    shareOnlinePresence: boolean;
    shareListeningStatus: boolean;
    wifiOnly: boolean;
    offlineEnabled: boolean;
    maxCacheSizeMb: number;
    // YouTube Music (per-user)
    showYtMusicExplore: boolean;
    showTidalExplore: boolean;
    ytMusicOAuthJson?: string;
    ytMusicQuality: "LOW" | "MEDIUM" | "HIGH" | "LOSSLESS";
    // Per-user TIDAL streaming
    tidalOAuthJson?: string;
    tidalStreamingQuality: "LOW" | "HIGH" | "LOSSLESS" | "HI_RES_LOSSLESS";
}

export interface SystemSettings {
    // Lidarr
    lidarrEnabled: boolean;
    lidarrUrl: string;
    lidarrApiKey: string;
    // AI Services
    openaiEnabled: boolean;
    openaiApiKey: string;
    openaiModel: string;
    fanartEnabled: boolean;
    fanartApiKey: string;
    lastfmApiKey: string;
    // Audiobookshelf
    audiobookshelfEnabled: boolean;
    audiobookshelfUrl: string;
    audiobookshelfApiKey: string;
    // Soulseek (direct connection via slsk-client)
    soulseekUsername: string;
    soulseekPassword: string;
    // TIDAL — token material never leaves the backend; tidalConnected
    // reports whether the admin download connection is established.
    tidalEnabled: boolean;
    tidalConnected: boolean;
    tidalUserId: string;
    tidalCountryCode: string;
    tidalQuality: "LOW" | "HIGH" | "LOSSLESS" | "HI_RES_LOSSLESS";
    tidalFileTemplate: string;
    // Storage
    musicPath: string;
    downloadPath: string;
    // Advanced
    transcodeCacheMaxGb: number;
    maxCacheSizeMb: number;
    autoSync: boolean;
    autoEnrichMetadata: boolean;
    libraryDeletionEnabled: boolean;
    audioAnalyzerWorkers: number;
    soulseekConcurrentDownloads: number;
    // Download Preferences
    downloadSource: "soulseek" | "lidarr" | "tidal";
    primaryFailureFallback: "none" | "lidarr" | "soulseek" | "tidal";
    // YouTube Music streaming (admin toggle + OAuth app credentials)
    ytMusicEnabled: boolean;
    ytMusicClientId: string;
    ytMusicClientSecret: string;
    // UI
    showVersion: boolean;
}

export interface ApiKey {
    id: string;
    name: string;
    keyPreview?: string;
    createdAt: string;
    expiresAt: string;
    lastUsed?: string | null;
    lastUsedAt?: string | null;
}

/** Admin-facing user summary returned by the authentication API. */
export interface User {
    id: string;
    username: string;
    email: string | null;
    role: "user" | "admin";
    createdAt: string;
    hasPassword: boolean;
    linkedProviders: string[];
}

export interface ConfirmModalConfig {
    title: string;
    message: string;
    confirmText: string;
    onConfirm: () => void;
}
