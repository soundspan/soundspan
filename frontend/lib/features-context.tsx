"use client";

import {
    createContext,
    useContext,
    useEffect,
    useState,
    useMemo,
    ReactNode,
    useCallback,
} from "react";
import { api } from "./api";

interface FeaturesState {
    musicCNN: boolean;
    vibeEmbeddings: boolean;
    loading: boolean;
}

const defaultState: FeaturesState = {
    musicCNN: false,
    vibeEmbeddings: false,
    loading: true,
};
const FEATURES_REFRESH_INTERVAL_MS = 60_000;

const FeaturesContext = createContext<FeaturesState | undefined>(undefined);

export function FeaturesProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<FeaturesState>(defaultState);
    const refreshFeatures = useCallback(async () => {
        try {
            const features = await api.getFeatures();
            setState({
                musicCNN: features.musicCNN,
                vibeEmbeddings: features.vibeEmbeddings,
                loading: false,
            });
        } catch (error) {
            console.error("Failed to fetch features:", error);
            setState((prev) =>
                prev.loading
                    ? {
                          musicCNN: false,
                          vibeEmbeddings: false,
                          loading: false,
                      }
                    : prev
            );
        }
    }, []);

    useEffect(() => {
        let isMounted = true;

        const safeRefresh = async () => {
            if (!isMounted) return;
            await refreshFeatures();
        };

        void safeRefresh();

        const interval = window.setInterval(
            safeRefresh,
            FEATURES_REFRESH_INTERVAL_MS
        );

        const onVisibilityChange = () => {
            if (document.visibilityState === "visible") {
                void safeRefresh();
            }
        };

        window.addEventListener("focus", onVisibilityChange);
        document.addEventListener("visibilitychange", onVisibilityChange);

        return () => {
            isMounted = false;
            window.clearInterval(interval);
            window.removeEventListener("focus", onVisibilityChange);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
    }, [refreshFeatures]);

    const value = useMemo(() => state, [state]);

    return (
        <FeaturesContext.Provider value={value}>
            {children}
        </FeaturesContext.Provider>
    );
}

export function useFeatures(): FeaturesState {
    const context = useContext(FeaturesContext);
    if (!context) {
        throw new Error("useFeatures must be used within FeaturesProvider");
    }
    return context;
}
