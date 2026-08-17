"use client";

import {
    createContext,
    useContext,
    useEffect,
    useState,
    useMemo,
    ReactNode,
    useCallback,
    useRef,
} from "react";
import { api } from "./api";
import { useVisibilityGatedInterval } from "../hooks/useVisibilityGatedInterval";
import { frontendLogger as sharedFrontendLogger } from "./logger";
import type { VibeSystemStatus } from "./api/settings";

interface FeaturesState {
    musicCNN: boolean;
    vibeEmbeddings: boolean;
    audioAnalysis: boolean;
    discovery: boolean;
    autoPlaylists: boolean;
    federation: boolean;
    vibe: VibeSystemStatus;
    showVersion: boolean;
    loading: boolean;
}

// Configured feature flags (audioAnalysis/discovery/autoPlaylists) default ON
// server-side, so they default true here to avoid hiding sections while the
// first features fetch is in flight.
const defaultState: FeaturesState = {
    musicCNN: false,
    vibeEmbeddings: false,
    audioAnalysis: true,
    discovery: true,
    autoPlaylists: true,
    federation: false,
    vibe: {
        provider: {
            configured: false,
            reachable: null,
            checkedAt: null,
            fresh: false,
        },
        activeSpace: null,
        migration: null,
    },
    showVersion: false,
    loading: true,
};
const FEATURES_REFRESH_INTERVAL_MS = 60_000;

const FeaturesContext = createContext<FeaturesState | undefined>(undefined);

/**
 * Renders the FeaturesProvider component.
 */
export function FeaturesProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<FeaturesState>(defaultState);
    const isMountedRef = useRef(false);
    const refreshFeatures = useCallback(async () => {
        try {
            const [features, uiSettings] = await Promise.all([
                api.getFeatures(),
                api.getUiSettings().catch(() => ({ showVersion: false })),
            ]);
            setState({
                musicCNN: features.musicCNN,
                vibeEmbeddings: features.vibeEmbeddings,
                audioAnalysis: features.audioAnalysis ?? true,
                discovery: features.discovery ?? true,
                autoPlaylists: features.autoPlaylists ?? true,
                federation: features.federation ?? false,
                vibe: features.vibe,
                showVersion: uiSettings.showVersion,
                loading: false,
            });
        } catch (error) {
            sharedFrontendLogger.error("Failed to fetch features:", error);
            setState((prev) =>
                prev.loading
                    ? {
                          musicCNN: false,
                          vibeEmbeddings: false,
                          audioAnalysis: true,
                          discovery: true,
                          autoPlaylists: true,
                          federation: false,
                          vibe: defaultState.vibe,
                          showVersion: false,
                          loading: false,
                      }
                    : prev,
            );
        }
    }, []);

    const safeRefresh = useCallback(async () => {
        if (!isMountedRef.current) return;
        await refreshFeatures();
    }, [refreshFeatures]);

    useVisibilityGatedInterval(safeRefresh, FEATURES_REFRESH_INTERVAL_MS);

    useEffect(() => {
        isMountedRef.current = true;
        void safeRefresh();
        return () => {
            isMountedRef.current = false;
        };
    }, [safeRefresh]);

    const value = useMemo(() => state, [state]);

    return (
        <FeaturesContext.Provider value={value}>
            {children}
        </FeaturesContext.Provider>
    );
}

/**
 * Executes useFeatures.
 */
export function useFeatures(): FeaturesState {
    const context = useContext(FeaturesContext);
    if (!context) {
        throw new Error("useFeatures must be used within FeaturesProvider");
    }
    return context;
}
